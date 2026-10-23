// Abgleich (Kern, bis 2026-10-24 ee): Analytics-API-Client gegen die Doku-Fixtures (Paging, 401, 429, 410), Team-CSV mit zwei
// Spaltenlayouts, Abgleich über die API (Key verschlüsselt, Personen über HMAC(account_id), Zusammenfassung
// ohne Personendaten) und der Abzug der Überschreitung in der Kalkulation (Architektur §4).
//
// Abzug von Hand gerechnet (Monat 2026-10, Kurs 0,86, keine Sitze), Person P = Nutzer A der Fixtures:
//   05.10.: Schatten x 30 $, y 10 $ (S = 40 $); Kosten A: amount 1500 + 54,22 Cent = 15,5422 $,
//           list 1500 + 67,78 Cent = 15,6778 $ → u = 15,6778 / 40 = 0,391945
//           x netto 30 · 0,608055 = 18,24165 $, y netto 6,08055 $; Ü: x 15,5422 · 30/40 = 11,65665 $, y 3,88555 $
//   06.10.: Schatten x 20 $; amount 802,63 + 18,59 = 8,2122 $, list 802,63 + 23,24 = 8,2587 $
//           → u = 0,412935, x netto 20 · 0,587065 = 11,7413 $, Ü x 8,2122 $
//   x: 18,24165 + 11,7413 + 11,65665 + 8,2122 = 49,8518 $ → 4985 US-Cent → 4287 EUR-Cent (4985 · 0,86 = 4287,1)
//   y: 6,08055 + 3,88555 = 9,9661 $ → 997 US-Cent → 857 EUR-Cent (857,42)
//   Nutzer B ist keiner Person zugeordnet (zwei Personentage ohne Zuordnung).
//   Tokens: 05.10. Quelle 24 136 000 = seatmeter 24 136 000 (innerhalb ±3 %),
//           06.10. Quelle 12 205 500, seatmeter 12 815 775 (+5 %, abweichend).
import { randomUUID } from 'node:crypto';
import { erstelleDb, mandantSaltsLaden, withMandant, type Db } from '../src/index.js';
import {
  abgleichLaufSchema,
  abgleichStatusSchema,
  csvVorschauSchema,
  kalkulationAntwortSchema,
  type AbgleichLauf,
} from '@seatmeter/shared';
import { personKeyEmail, personKeyKonto } from '@seatmeter/shared/hmac';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AnalyticsFehler,
  centZuMikro,
  erkenneZuordnung,
  holeKosten,
  holeNutzung,
  leseSpendCsv,
  leseZahl,
  type AnalyticsOptionen,
} from '../src/abgleich/index.js';
import {
  kernApp,
  legeMandantAn,
  legePersonAn,
  legeProjektAn,
  MASTER_KEY_B64,
  meldeAn,
} from './api-hilfen.js';
import {
  fixture,
  kurs,
  M,
  starteEmpfaenger,
  tagAggregat,
  type Empfaenger,
} from './modul-hilfen.js';

const NUTZER_A = 'user_01AbCdEfGhIjKlMnOpQrSt';
const EMAIL_A = 'anna.beispiel@example.com';
const salt = Buffer.alloc(32, 3);

/** Analytics-Fixtures je Endpunkt; Seite 2 nur mit dem Cursor aus Seite 1. */
function analyticsRouten(e: Empfaenger, zusatz: { usage401?: boolean } = {}) {
  e.routen.push((url) => {
    if (url.pathname.endsWith('/user_usage_report')) {
      if (zusatz.usage401) return { status: 401, body: fixture('fehler-401.json') };
      const seite = url.searchParams.get('page');
      return { status: 200, body: fixture(seite ? 'usage-seite-2.json' : 'usage-seite-1.json') };
    }
    if (url.pathname.endsWith('/user_cost_report'))
      return { status: 200, body: fixture('kosten-seite-1.json') };
    return null;
  });
}

describe('Analytics-API-Client (Doku-Fixtures)', () => {
  const optionen = (
    fetch: AnalyticsOptionen['fetch'],
    warte?: AnalyticsOptionen['warte'],
  ): AnalyticsOptionen => ({
    key: 'sk-ant-analytics-test',
    pseudonymisiere: (id, email) => ({
      konto: personKeyKonto(salt, id),
      email: email ? personKeyEmail(salt, email) : null,
    }),
    fetch,
    basis: 'https://api.example.test/v1/organizations/analytics',
    ...(warte ? { warte } : {}),
  });

  it('blättert über has_more/next_page, sendet Header und Parameter laut Doku', async () => {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    const f: AnalyticsOptionen['fetch'] = async (u, init) => {
      urls.push(u);
      headers.push(init?.headers as Record<string, string>);
      const page = new URL(u).searchParams.get('page');
      return Response.json(fixture(page ? 'usage-seite-2.json' : 'usage-seite-1.json'));
    };
    const zeilen = await holeNutzung(optionen(f), '2026-10-05', '2026-10-07');
    expect(zeilen).toHaveLength(7);
    expect(urls).toHaveLength(2);
    const p = new URL(urls[0]!).searchParams;
    expect(new URL(urls[0]!).pathname).toBe('/v1/organizations/analytics/user_usage_report');
    expect(p.get('starting_at')).toBe('2026-10-05T00:00:00Z');
    expect(p.get('ending_at')).toBe('2026-10-07T00:00:00Z');
    expect(p.get('bucket_width')).toBe('1d');
    expect(p.getAll('products[]')).toEqual(['claude_code']);
    expect(p.getAll('group_by[]')).toEqual(['model']);
    expect(new URL(urls[1]!).searchParams.get('page')).toBe(
      'page_ZXhhbXBsZS1jdXJzb3ItdXNhZ2UtcDI=',
    );
    expect(headers[0]).toEqual({
      'x-api-key': 'sk-ant-analytics-test',
      'anthropic-version': '2023-06-01',
    });
    // Erste Zeile: Nutzer A, Opus, 05.10.; E-Mail und Name nur als HMAC bzw. verworfen.
    expect(zeilen[0]).toMatchObject({
      tag: '2026-10-05',
      model: 'claude-opus-5-5',
      input: 412_000,
      output: 380_000,
      cache_read: 18_400_000,
      cache_write: 1_250_000,
      cache_write_1h: 0,
    });
    expect(zeilen[0]!.akteur.konto.equals(personKeyKonto(salt, NUTZER_A))).toBe(true);
    expect(zeilen[0]!.akteur.email!.equals(personKeyEmail(salt, EMAIL_A))).toBe(true);
    expect(JSON.stringify(zeilen)).not.toMatch(/anna|Beispiel|example\.com/);
  });

  it('rechnet Beträge von Cent-Strings exakt in Mikro-USD um', async () => {
    expect(centZuMikro('1500.000000')).toBe(15 * M);
    expect(centZuMikro('54.220000')).toBe(542_200);
    expect(centZuMikro('0.000049')).toBe(0);
    expect(centZuMikro('0.000050')).toBe(1);
    expect(centZuMikro(null)).toBeNull();
    const kosten = await holeKosten(
      optionen(async () => Response.json(fixture('kosten-seite-1.json'))),
      '2026-10-05',
      '2026-10-07',
    );
    expect(kosten).toHaveLength(7);
    const summe = kosten.reduce((s, k) => s + k.amountUsdMicros, 0);
    // 2375,44 + 182,69 Cent laut Fixture-README.
    expect(summe).toBe(25_581_300);
  });

  it('401 → Fehler „auth“; 429 mit retry-after wird abgewartet; 410 startet den Abschnitt neu', async () => {
    const f401: AnalyticsOptionen['fetch'] = async () =>
      Response.json(fixture('fehler-401.json'), { status: 401 });
    const fehler = await holeNutzung(optionen(f401), '2026-10-05', '2026-10-06').catch(
      (e: unknown) => e,
    );
    expect(fehler).toBeInstanceOf(AnalyticsFehler);
    expect((fehler as AnalyticsFehler).art).toBe('auth');
    expect((fehler as Error).message).not.toContain('sk-ant');

    const gewartet: number[] = [];
    let n = 0;
    const f429: AnalyticsOptionen['fetch'] = async () =>
      ++n === 1
        ? Response.json(fixture('fehler-429.json'), {
            status: 429,
            headers: { 'retry-after': '2' },
          })
        : Response.json(fixture('kosten-seite-1.json'));
    expect(
      await holeKosten(
        optionen(f429, async (ms) => void gewartet.push(ms)),
        '2026-10-05',
        '2026-10-06',
      ),
    ).toHaveLength(7);
    expect(gewartet).toEqual([2000]);

    const dauer429: AnalyticsOptionen['fetch'] = async () =>
      Response.json(fixture('fehler-429.json'), { status: 429 });
    const rate = await holeKosten(
      optionen(dauer429, async () => undefined),
      '2026-10-05',
      '2026-10-06',
    ).catch((e: unknown) => e);
    expect((rate as AnalyticsFehler).art).toBe('rate');

    let m = 0;
    const f410: AnalyticsOptionen['fetch'] = async (u) => {
      m += 1;
      if (new URL(u).searchParams.get('page') && m === 2)
        return new Response('{}', { status: 410 });
      const page = new URL(u).searchParams.get('page');
      return Response.json(fixture(page ? 'usage-seite-2.json' : 'usage-seite-1.json'));
    };
    expect(await holeNutzung(optionen(f410), '2026-10-05', '2026-10-07')).toHaveLength(4 + 7);
  });

  it('teilt lange Zeiträume in Abschnitte von höchstens 31 Tagen', async () => {
    const urls: string[] = [];
    await holeKosten(
      optionen(async (u) => (urls.push(u), Response.json({ data: [], has_more: false }))),
      '2026-08-01',
      '2026-10-15',
    );
    expect(urls.map((u) => new URL(u).searchParams.get('starting_at'))).toEqual([
      '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z',
      '2026-10-02T00:00:00Z',
    ]);
  });
});

describe('Team-Spend-CSV (tolerant, zwei Layouts)', () => {
  const hash = (e: string) => personKeyEmail(salt, e);

  it('Layout englisch: Komma, $-Beträge mit Tausenderkomma, ISO-Datum, Tokenspalten', () => {
    const csv = [
      'Date,User Email,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Write Tokens,Estimated Cost (USD),List Amount (USD)',
      '2026-10-05,Anna.Beispiel@example.com,claude-opus-5-5,"412,000",380000,18400000,1250000,$15.00,$15.00',
      '2026-10-05T00:00:00Z,bert@example.com,claude-sonnet-5-5,1000,2000,0,0,"$1,234.50",',
      'kaputt,,,,,,,,',
    ].join('\n');
    expect(erkenneZuordnung(csv.split('\n')[0]!.split(','))).toEqual({
      email: 'User Email',
      tag: 'Date',
      modell: 'Model',
      amount: 'Estimated Cost (USD)',
      list_amount: 'List Amount (USD)',
      input: 'Input Tokens',
      output: 'Output Tokens',
      cache_read: 'Cache Read Tokens',
      cache_write: 'Cache Write Tokens',
    });
    const r = leseSpendCsv(csv, hash);
    expect(r.trennzeichen).toBe(',');
    expect(r.zeilen).toHaveLength(2);
    expect(r.zeilen[0]).toMatchObject({
      tag: '2026-10-05',
      amountUsdMicros: 15 * M,
      listAmountUsdMicros: 15 * M,
      input: 412_000,
      cache_write: 1_250_000,
      hatTokens: true,
    });
    expect(r.zeilen[0]!.emailKey.equals(hash(EMAIL_A))).toBe(true);
    expect(r.zeilen[1]).toMatchObject({
      amountUsdMicros: 1_234_500_000,
      listAmountUsdMicros: null,
    });
    expect(r.fehler).toEqual(['Zeile 4: E-Mail, Datum oder Betrag nicht lesbar']);
    expect(r.beispiel[0]!.email).toBe('A***@example.com');
  });

  it('Layout deutsch: Semikolon, Dezimalkomma, TT.MM.JJJJ, andere Spaltennamen; Zuordnung überschreibbar', () => {
    const csv = [
      '\uFEFFDatum;E-Mail-Adresse;Modell;Kosten;Listenpreis;Hinweis',
      '05.10.2026;anna.beispiel@example.com;claude-opus-5-5;15,00;1.234,56;x',
      '6.10.2026;anna.beispiel@example.com;claude-opus-5-5;8,21;8,26;"a;b"',
    ].join('\r\n');
    const r = leseSpendCsv(csv, hash);
    expect(r.trennzeichen).toBe(';');
    expect(r.zuordnung).toMatchObject({
      email: 'E-Mail-Adresse',
      tag: 'Datum',
      modell: 'Modell',
      amount: 'Kosten',
      list_amount: 'Listenpreis',
      input: null,
    });
    expect(
      r.zeilen.map((z) => [z.tag, z.amountUsdMicros, z.listAmountUsdMicros, z.hatTokens]),
    ).toEqual([
      ['2026-10-05', 15 * M, 1_234_560_000, false],
      ['2026-10-06', 8_210_000, 8_260_000, false],
    ]);
    const cent = leseSpendCsv(csv, hash, {
      betragEinheit: 'cent',
      zuordnung: { list_amount: null },
    });
    expect(cent.zeilen[0]).toMatchObject({ amountUsdMicros: 150_000, listAmountUsdMicros: null });
    const ohne = leseSpendCsv('Wer;Wann;Was\na@example.com;05.10.2026;1', hash);
    expect(ohne.fehler).toContain('Keine Spalte für email erkannt; bitte zuordnen');
    const zugeordnet = leseSpendCsv('Wer;Wann;Was\na@example.com;05.10.2026;1', hash, {
      zuordnung: { email: 'Wer', tag: 'Wann', amount: 'Was' },
    });
    expect(zugeordnet.zeilen).toHaveLength(1);
    expect(leseZahl('1.234.567')).toBe(1_234_567);
    expect(leseZahl('12.30 USD')).toBe(12.3);
  });
});

describe('Abgleich über API und CSV, Abzug in der Kalkulation', () => {
  let db: Db;
  let app: FastifyInstance;
  let quelle: Empfaenger;
  let m: string;
  let fremd: string;
  let x: string;
  let y: string;
  let p: string;
  let admin: Awaited<ReturnType<typeof meldeAn>>;
  let controller: Awaited<ReturnType<typeof meldeAn>>;
  let adminFremd: Awaited<ReturnType<typeof meldeAn>>;
  const url = inject('modulDatenbankUrl');
  const anfrage = (
    s: { headers: Record<string, string> },
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pfad: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: pfad,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  beforeAll(async () => {
    db = erstelleDb(url, 4);
    quelle = await starteEmpfaenger();
    analyticsRouten(quelle);
    app = await kernApp(db, url, {
      SEATMETER_ANALYTICS_URL: `${quelle.url}/v1/organizations/analytics`,
    });
    m = await legeMandantAn(db);
    fremd = await legeMandantAn(db);
    x = await legeProjektAn(db, m, `x-${randomUUID().slice(0, 6)}`);
    y = await legeProjektAn(db, m, `y-${randomUUID().slice(0, 6)}`);
    p = await legePersonAn(db, m);
    const masterKey = Buffer.from(MASTER_KEY_B64, 'base64');
    // Person P: key_konto aus account_uuid (zufällig), key_konto_id = HMAC(account_id) wie im Kern-Ingest.
    await withMandant(db, m, async (trx) => {
      const { personSalt } = await mandantSaltsLaden(trx, masterKey, m);
      await trx
        .updateTable('person')
        .set({ key_konto_id: personKeyKonto(personSalt, NUTZER_A) })
        .where('id', '=', p)
        .execute();
    });
    await kurs(db, m, '2026-10', 0.86);
    await tagAggregat(db, m, [
      { tag: '2026-10-05', person: p, projekt: x, usd: 30, tokens: { input: 18_000_000 } },
      { tag: '2026-10-05', person: p, projekt: y, usd: 10, tokens: { input: 6_136_000 } },
      { tag: '2026-10-06', person: p, projekt: x, usd: 20, tokens: { input: 12_815_775 } },
    ]);
    admin = await meldeAn(db, m, 'mandanten_admin');
    controller = await meldeAn(db, m, 'controller');
    adminFremd = await meldeAn(db, fremd, 'mandanten_admin');
  });

  afterAll(async () => {
    await quelle.schliessen();
    await app.close();
    await db.destroy();
  });

  it('ohne Abgleich: Überschreitung nicht abgezogen', async () => {
    const k = kalkulationAntwortSchema.parse(
      (await anfrage(admin, 'GET', '/api/v1/kalkulation?monat=2026-10')).json(),
    );
    expect(k.ueberschreitung_abgezogen).toBe(false);
    expect(k.zeilen.find((z) => z.projekt_id === x)!.projektpreis_usd_cent).toBe(5000);
  });

  it('Analytics-Key nur verschlüsselt; ohne Key schlägt der Lauf mit Hinweis fehl', async () => {
    const ohne = abgleichLaufSchema.parse(
      (await anfrage(admin, 'POST', '/api/v1/abgleich/lauf?von=2026-10-05&bis=2026-10-06')).json(),
    );
    expect(ohne).toMatchObject({ status: 'fehler', fehler: 'Kein Analytics-Key hinterlegt' });
    expect(
      (
        await anfrage(controller, 'PUT', '/api/v1/abgleich/analytics-key', {
          key: 'sk-ant-test.analytics.abcdefghijklmnop',
        })
      ).statusCode,
    ).toBe(403);
    const r = await anfrage(admin, 'PUT', '/api/v1/abgleich/analytics-key', {
      key: 'sk-ant-test.analytics.abcdefghijklmnop',
    });
    expect(r.statusCode).toBe(200);
    expect(abgleichStatusSchema.parse(r.json())).toMatchObject({ key_gesetzt: true, plan: 'team' });
    expect(r.body).not.toContain('sk-ant');
    const roh = await db
      .selectFrom('mandant_geheimnis')
      .select('analytics_key')
      .where('mandant_id', '=', m)
      .executeTakeFirstOrThrow();
    expect(roh.analytics_key!.toString('latin1')).not.toContain('sk-ant');
  });

  it('Lauf über die Analytics API: Überschreitung je Person/Tag/Modell, Zusammenfassung ohne Personendaten', async () => {
    const r = await anfrage(admin, 'POST', '/api/v1/abgleich/lauf?von=2026-10-05&bis=2026-10-06');
    const lauf = abgleichLaufSchema.parse(r.json());
    expect(lauf).toMatchObject({
      quelle: 'api',
      von: '2026-10-05',
      bis: '2026-10-06',
      status: 'abweichung',
      zeilen: 14,
      fehler: null,
    });
    expect(lauf.zusammenfassung).toMatchObject({
      schwelle_prozent: 3,
      personentage_quelle: 4,
      zugeordnet: 2,
      ohne_zuordnung: 2,
      innerhalb: 1,
      abweichend: 1,
      nur_seatmeter: 0,
      tokens_quelle: 36_341_500,
      tokens_seatmeter: 36_951_775,
      abdeckung_prozent: 101.7,
      ueberschreitung_zeilen: 4,
      ueberschreitung_usd_micros: 23_754_400,
    });
    expect(lauf.zusammenfassung!.tage).toEqual([
      {
        tag: '2026-10-05',
        tokens_quelle: 24_136_000,
        tokens_seatmeter: 24_136_000,
        abweichung_prozent: 0,
      },
      {
        tag: '2026-10-06',
        tokens_quelle: 12_205_500,
        tokens_seatmeter: 12_815_775,
        abweichung_prozent: 5,
      },
    ]);
    const text = JSON.stringify(lauf);
    expect(text).not.toMatch(/anna|Beispiel|example\.com|user_01|P-[A-Z0-9]{6}/);
    expect(text).not.toContain(p);
    // Anfragen an die Quelle: Key im Header, nie in der URL.
    expect(
      quelle.anfragen.every(
        (a) =>
          a.header['x-api-key'] === 'sk-ant-test.analytics.abcdefghijklmnop' &&
          !a.pfad.includes('sk-ant'),
      ),
    ).toBe(true);
    const ue = await db
      .selectFrom('ueberschreitung')
      .selectAll()
      .where('mandant_id', '=', m)
      .orderBy('tag')
      .orderBy('model')
      .execute();
    expect(
      ue.map((z) => [
        z.tag,
        z.model,
        z.amount_usd_micros,
        z.list_amount_usd_micros,
        z.quelle,
        z.person_id === p,
      ]),
    ).toEqual([
      ['2026-10-05', 'claude-opus-5-5', 15 * M, 15 * M, 'api', true],
      ['2026-10-05', 'claude-sonnet-5-5', 542_200, 677_800, 'api', true],
      ['2026-10-06', 'claude-opus-5-5', 8_026_300, 8_026_300, 'api', true],
      ['2026-10-06', 'claude-sonnet-5-5', 185_900, 232_400, 'api', true],
    ]);
    expect(ue[0]).toMatchObject({
      input: 412_000,
      output: 380_000,
      cache_read: 18_400_000,
      cache_write: 1_250_000,
    });
    // Wiederholung ersetzt die Zeilen (keine Doppelten).
    await anfrage(admin, 'POST', '/api/v1/abgleich/lauf?von=2026-10-05&bis=2026-10-06');
    expect(
      await db.selectFrom('ueberschreitung').select('tag').where('mandant_id', '=', m).execute(),
    ).toHaveLength(4);
  });

  it('Abzugsformel: Kalkulation zieht die Überschreitung ab (Beispiel im Testkopf)', async () => {
    const k = kalkulationAntwortSchema.parse(
      (await anfrage(admin, 'GET', '/api/v1/kalkulation?monat=2026-10')).json(),
    );
    expect(k.ueberschreitung_abgezogen).toBe(true);
    const zx = k.zeilen.find((z) => z.projekt_id === x)!;
    const zy = k.zeilen.find((z) => z.projekt_id === y)!;
    expect(zx).toMatchObject({
      schatten_usd_micros: 29_982_950,
      ueberschreitung_usd_micros: 19_868_850,
      projektpreis_usd_cent: 4985,
      projektpreis_eur_cent: 4287,
    });
    expect(zy).toMatchObject({
      schatten_usd_micros: 6_080_550,
      ueberschreitung_usd_micros: 3_885_550,
      projektpreis_usd_cent: 997,
      projektpreis_eur_cent: 857,
    });
    expect(k.hinweise).not.toContain(
      'Überschreitung nicht abgezogen (keine Abgleichsdaten für den Monat).',
    );
  });

  it('Team-CSV: Vorschau (maskiert, Zuordnung) und Import; API-Zeilen bleiben vorrangig', async () => {
    const csv = [
      'Datum;E-Mail;Modell;Kosten',
      `07.10.2026;${EMAIL_A};claude-opus-5-5;2,50`,
      `05.10.2026;${EMAIL_A};claude-opus-5-5;99,00`,
      '07.10.2026;unbekannt@example.com;claude-opus-5-5;1,00',
    ].join('\n');
    // Person P ist auch per E-Mail bekannt (key_email wie der Ingest aus user.email).
    const masterKey = Buffer.from(MASTER_KEY_B64, 'base64');
    await withMandant(db, m, async (trx) => {
      const { personSalt } = await mandantSaltsLaden(trx, masterKey, m);
      await trx
        .updateTable('person')
        .set({ key_email: personKeyEmail(personSalt, EMAIL_A) })
        .where('id', '=', p)
        .execute();
    });
    const v = csvVorschauSchema.parse(
      (await anfrage(admin, 'POST', '/api/v1/abgleich/csv/vorschau', { csv })).json(),
    );
    expect(v).toMatchObject({
      trennzeichen: ';',
      zeilen: 3,
      gueltig: 3,
      zugeordnet: 2,
      ohne_zuordnung: 1,
      tage: { von: '2026-10-05', bis: '2026-10-07' },
      summe_usd: 102.5,
    });
    expect(v.zuordnung).toMatchObject({ email: 'E-Mail', tag: 'Datum', amount: 'Kosten' });
    expect(JSON.stringify(v)).not.toContain(EMAIL_A);
    expect(v.beispiel[0]!.email).toBe('a***@example.com');
    // Als text/csv: gleiche Route, Körper ist die Datei.
    const alsText = await app.inject({
      method: 'POST',
      url: '/api/v1/abgleich/csv',
      headers: { ...admin.headers, 'content-type': 'text/csv' },
      payload: csv,
    });
    const lauf: AbgleichLauf = abgleichLaufSchema.parse(alsText.json());
    expect(lauf).toMatchObject({ quelle: 'csv', von: '2026-10-05', bis: '2026-10-07', zeilen: 3 });
    expect(lauf.zusammenfassung).toMatchObject({
      ohne_zuordnung: 1,
      abdeckung_prozent: null,
      ueberschreitung_zeilen: 2,
    });
    const ue = await db
      .selectFrom('ueberschreitung')
      .select(['tag', 'model', 'amount_usd_micros', 'quelle'])
      .where('mandant_id', '=', m)
      .where('model', '=', 'claude-opus-5-5')
      .orderBy('tag')
      .execute();
    expect(ue).toEqual([
      { tag: '2026-10-05', model: 'claude-opus-5-5', amount_usd_micros: 15 * M, quelle: 'api' },
      { tag: '2026-10-06', model: 'claude-opus-5-5', amount_usd_micros: 8_026_300, quelle: 'api' },
      { tag: '2026-10-07', model: 'claude-opus-5-5', amount_usd_micros: 2_500_000, quelle: 'csv' },
    ]);
    const kaputt = await anfrage(admin, 'POST', '/api/v1/abgleich/csv', { csv: 'a;b\n1;2' });
    expect(kaputt.statusCode).toBe(400);
  });

  it('Läufe, Rollen und RLS', async () => {
    const laeufe = (await anfrage(controller, 'GET', '/api/v1/abgleich/laeufe')).json<{
      laeufe: AbgleichLauf[];
    }>().laeufe;
    expect(laeufe.map((l) => l.quelle)).toEqual(['csv', 'api', 'api', 'api']);
    expect((await anfrage(controller, 'POST', '/api/v1/abgleich/lauf')).statusCode).toBe(403);
    expect(
      (await anfrage(adminFremd, 'GET', '/api/v1/abgleich/laeufe')).json<{
        laeufe: AbgleichLauf[];
      }>().laeufe,
    ).toEqual([]);
    expect(
      abgleichStatusSchema.parse((await anfrage(adminFremd, 'GET', '/api/v1/abgleich')).json()),
    ).toMatchObject({ key_gesetzt: false, letzter_lauf: null });
    const fremdUe = await withMandant(db, fremd, (trx) =>
      trx.selectFrom('ueberschreitung').select('tag').execute(),
    );
    expect(fremdUe).toEqual([]);
  });
});
