// Phase 3: Kalkulation, Monatsabschluss, Kurs, Mandanten-Einstellungen und Berichte über die API.
//
// Golden-Datensatz (Monat 2026-09, Kurs manuell 0,86 € je $, keine Überschreitungsdaten):
//   P1 (Premium 100 $): x 258 $, y 37 $   P2 (Premium 100 $): x 124 $, z 50 $   P3 (Standard 20 $): keine Nutzung
//   Schatten je Projekt: x 382 $, y 37 $, z 50 $ (Σ 469 $), Σ Sitzkosten 220 $.
// Von Hand gerechnet (Projektpreis erst auf US-Cent, dann × 0,86 auf EUR-Cent):
//   person: x 382 + 100·258/295 + 100·124/174 = 382 + 87,457627 + 71,264368 = 540,72 $ → 465,02 €
//           y 37 + 100·37/295 = 49,54 $ → 42,60 €;  z 50 + 100·50/174 = 78,74 $ → 67,72 €;  ungenutzt 20 $ → 17,20 €
//   gleich: x 382 + 50 + 50 = 482,00 $ → 414,52 €;  y 37 + 50 = 87,00 $ → 74,82 €;  z 50 + 50 = 100,00 $ → 86,00 €;
//           ungenutzt 20 $ → 17,20 €
//   pool:   x 382 + 220·382/469 = 561,19 $ → 482,62 €;  y 37 + 220·37/469 = 54,36 $ → 46,75 €;
//           z 50 + 220·50/469 = 73,45 $ → 63,17 €;  ungenutzt 0 (Σ 689,00 $)
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  betriebsratBerichtSchema,
  kalkulationAntwortSchema,
  monatsabschlussSchema,
  type KalkulationAntwort,
  type ProjektpreisZeile,
} from '@seatmeter/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aggregiereTage } from '../src/aggregation/job.js';
import { heuteIn } from '../src/aggregation/tage.js';
import { erstelleApp } from '../src/app.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { anfragePartitionenAnlegen } from '../src/db/partitionen.js';
import {
  holeEzbKurse,
  kursEzbAktualisieren,
  leseEzbReihe,
  plusMonate,
  type FetchFunktion,
} from '../src/kalkulation/kurs.js';
import { monatsabschlussJob } from '../src/kalkulation/abschluss.js';
import {
  legeMandantAn,
  legePersonAn,
  legeProjektAn,
  meldeAn,
  testKonfiguration,
  type TestSitzung,
} from './api-hilfen.js';

const MONAT = '2026-09';
const M = 1_000_000;
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ezb/${name}`, import.meta.url), 'utf8');

/** Aufgezeichnete EZB-Antworten (2026-10-22): Monatsmittel Juli–September, Tageskurse ab September. */
const ezbFetch: FetchFunktion = async (url) => {
  if (url.includes('/M.USD.EUR.')) return new Response(fixture('monat.json'), { status: 200 });
  if (url.includes('/D.USD.EUR.')) return new Response(fixture('tag.json'), { status: 200 });
  return new Response('nicht gefunden', { status: 404 });
};

describe('Kalkulation, Monatsabschluss, Kurs und Berichte', () => {
  let db: Db;
  let app: FastifyInstance;
  const konfiguration = testKonfiguration(inject('testDatenbankUrl'));
  let a: string;
  let b: string;
  let p1: string;
  let p2: string;
  let p3: string;
  let x: string;
  let y: string;
  let z: string;
  let admin: TestSitzung;
  let adminB: TestSitzung;
  let controller: TestSitzung;
  let leiter: TestSitzung;
  let betriebsrat: TestSitzung;
  const pseudonyme: string[] = [];

  const get = (s: TestSitzung, url: string) =>
    app.inject({ method: 'GET', url, headers: s.headers });
  const put = (s: TestSitzung, url: string, payload: unknown) =>
    app.inject({ method: 'PUT', url, headers: s.headers, payload: payload as object });
  const post = (s: TestSitzung, url: string) =>
    app.inject({ method: 'POST', url, headers: s.headers, payload: {} });

  async function kalkulation(s: TestSitzung, monat = MONAT): Promise<KalkulationAntwort> {
    const r = await get(s, `/api/v1/kalkulation?monat=${monat}`);
    expect(r.statusCode).toBe(200);
    return kalkulationAntwortSchema.parse(r.json());
  }
  const zeile = (k: KalkulationAntwort, id: string | null, topf = 'projekt') =>
    k.zeilen.find((r) => r.topf === topf && r.projekt_id === id) as ProjektpreisZeile;
  const cents = (r: ProjektpreisZeile | undefined) => [
    r?.projektpreis_usd_cent,
    r?.projektpreis_eur_cent,
  ];

  beforeAll(async () => {
    db = erstelleDb(konfiguration.DATABASE_URL, 4);
    app = await erstelleApp({ konfiguration, db });
    a = await legeMandantAn(db);
    b = await legeMandantAn(db);
    p1 = await legePersonAn(db, a);
    p2 = await legePersonAn(db, a);
    p3 = await legePersonAn(db, a);
    for (const p of [p1, p2, p3]) {
      const z = await db
        .selectFrom('person')
        .select('pseudonym')
        .where('id', '=', p)
        .executeTakeFirstOrThrow();
      pseudonyme.push(z.pseudonym);
    }
    x = await legeProjektAn(db, a, 'x-shop');
    y = await legeProjektAn(db, a, 'y-portal');
    z = await legeProjektAn(db, a, 'z-app');
    admin = await meldeAn(db, a, 'mandanten_admin');
    adminB = await meldeAn(db, b, 'mandanten_admin');
    controller = await meldeAn(db, a, 'controller');
    leiter = await meldeAn(db, a, 'projektleiter', [x]);
    betriebsrat = await meldeAn(db, a, 'betriebsrat');

    const posten: [string, string, string, number][] = [
      [p1, x, '2026-09-03', 258],
      [p1, y, '2026-09-10', 37],
      [p2, x, '2026-09-15', 124],
      [p2, z, '2026-09-20', 50],
    ];
    await db
      .insertInto('tag_aggregat')
      .values(
        posten.map(([person, projekt, tag, usd]) => ({
          mandant_id: a,
          tag,
          person_id: person,
          projekt_id: projekt,
          model: 'claude-opus-5-5',
          auth_klasse: 'abo' as const,
          input: 1000,
          output: 100,
          cache_read: 10_000,
          cache_write: 500,
          cache_write_1h: 500,
          anfragen: 2,
          schatten_usd_micros: usd * M,
          preis_version: 'global:claude-opus-5-5@2026-01-01',
        })),
      )
      .execute();

    expect(
      (
        await put(admin, '/api/v1/sitzkosten', [
          {
            sitz_typ: 'premium',
            gueltig_ab: '2026-01-01',
            preis_monat: 100,
            abrechnung: 'jaehrlich',
          },
          {
            sitz_typ: 'standard',
            gueltig_ab: '2026-01-01',
            preis_monat: 20,
            abrechnung: 'jaehrlich',
          },
        ])
      ).statusCode,
    ).toBe(200);
    for (const [p, typ] of [
      [p1, 'premium'],
      [p2, 'premium'],
      [p3, 'standard'],
    ] as const) {
      const r = await put(admin, `/api/v1/personen/${p}/sitz`, {
        sitz_typ: typ,
        gueltig_ab: '2026-09-01',
      });
      expect(r.statusCode).toBe(200);
    }
    expect((await put(admin, `/api/v1/kurs?monat=${MONAT}`, { usd_eur: 0.86 })).statusCode).toBe(
      200,
    );
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  describe('Golden-Test über die API (drei Varianten, auf den Cent)', () => {
    it('person (Standard): x 540,72 $ ≈ 465,02 €, y 49,54 $ ≈ 42,60 €, z 78,74 $ ≈ 67,72 €, ungenutzt 20 $', async () => {
      const k = await kalkulation(admin);
      expect(k.einstellungen.sitzkosten_verteilung).toBe('person');
      expect(k.kurs).toMatchObject({ usd_eur: 0.86, quelle: 'manuell', vorlaeufig: false });
      expect(k.ueberschreitung_abgezogen).toBe(false);
      expect(k.hinweise.some((h) => h.includes('Überschreitung nicht abgezogen'))).toBe(true);
      expect(zeile(k, x).schatten_usd_micros).toBe(382 * M);
      expect(zeile(k, x).sitzanteil_usd_micros).toBe(158_721_995);
      expect(cents(zeile(k, x))).toEqual([54_072, 46_502]);
      expect(cents(zeile(k, y))).toEqual([4_954, 4_260]);
      expect(cents(zeile(k, z))).toEqual([7_874, 6_772]);
      expect(cents(zeile(k, null, 'ungenutzt'))).toEqual([2_000, 1_720]);
      expect(k.summe.projektpreis_usd_cent).toBe(68_900);
      expect(k.sitzkosten_usd_micros).toBe(220 * M);
      expect(zeile(k, x).tokens).toMatchObject({ input: 2000, output: 200, gesamt: 23_200 });
      expect(zeile(k, x).name).toBe('test/x-shop');
    });

    it('gleich: x 482,00 $ ≈ 414,52 €, y 87,00 $ ≈ 74,82 €, z 100,00 $ ≈ 86,00 €', async () => {
      const r = await put(admin, '/api/v1/mandant/einstellungen', {
        sitzkosten_verteilung: 'gleich',
      });
      expect(r.statusCode).toBe(200);
      const k = await kalkulation(admin);
      expect(k.einstellungen.sitzkosten_verteilung).toBe('gleich');
      expect(cents(zeile(k, x))).toEqual([48_200, 41_452]);
      expect(cents(zeile(k, y))).toEqual([8_700, 7_482]);
      expect(cents(zeile(k, z))).toEqual([10_000, 8_600]);
      expect(cents(zeile(k, null, 'ungenutzt'))).toEqual([2_000, 1_720]);
    });

    it('pool: x 561,19 $ ≈ 482,62 €, y 54,36 $ ≈ 46,75 €, z 73,45 $ ≈ 63,17 €, kein „ungenutzt“', async () => {
      await put(admin, '/api/v1/mandant/einstellungen', { sitzkosten_verteilung: 'pool' });
      const k = await kalkulation(admin);
      expect(cents(zeile(k, x))).toEqual([56_119, 48_262]);
      expect(cents(zeile(k, y))).toEqual([5_436, 4_675]);
      expect(cents(zeile(k, z))).toEqual([7_345, 6_317]);
      expect(k.zeilen.some((r) => r.topf === 'ungenutzt')).toBe(false);
      expect(k.summe.projektpreis_usd_cent).toBe(68_900);
      await put(admin, '/api/v1/mandant/einstellungen', { sitzkosten_verteilung: 'person' });
    });
  });

  describe('Rollen und Mandantentrennung', () => {
    it('Projektleiter sieht nur eigene Projekte, Controller alle, Betriebsrat 403', async () => {
      const k = await kalkulation(leiter);
      expect(k.zeilen.map((r) => r.projekt_id)).toEqual([x]);
      expect(k.summe.projektpreis_usd_cent).toBe(54_072);
      expect(k.sitzkosten_usd_micros).toBeNull();
      expect((await kalkulation(controller)).zeilen).toHaveLength(4);
      expect((await get(betriebsrat, `/api/v1/kalkulation?monat=${MONAT}`)).statusCode).toBe(403);
      expect((await get(betriebsrat, `/api/v1/monatsabschluss?monat=${MONAT}`)).statusCode).toBe(
        403,
      );
      expect(
        (await get(betriebsrat, `/api/v1/berichte/projektabrechnung?monat=${MONAT}`)).statusCode,
      ).toBe(403);
      expect(
        (await get(betriebsrat, `/api/v1/berichte/betriebsrat?monat=${MONAT}`)).statusCode,
      ).toBe(200);
      expect(
        (await get(controller, `/api/v1/berichte/betriebsrat?monat=${MONAT}`)).statusCode,
      ).toBe(403);
    });

    it('RLS: Mandant B sieht weder Projekte noch Kurs noch Abschluss von A', async () => {
      const k = await kalkulation(adminB);
      expect(k.zeilen).toEqual([]);
      expect(k.kurs.usd_eur).toBeNull();
      expect(k.sitzkosten_usd_micros).toBe(0);
      const kurse = (await get(adminB, '/api/v1/kurse')).json() as { zeilen: unknown[] };
      expect(kurse.zeilen).toEqual([]);
      // Kurs von B ändert A nicht.
      await put(adminB, `/api/v1/kurs?monat=${MONAT}`, { usd_eur: 0.5 });
      expect((await kalkulation(admin)).kurs.usd_eur).toBe(0.86);
    });

    it('Monatsabschluss nur für Admins; ungültiger Monat 400', async () => {
      expect(
        (await post(controller, `/api/v1/jobs/kalkulation/monatsabschluss?monat=${MONAT}`))
          .statusCode,
      ).toBe(403);
      expect((await get(admin, '/api/v1/kalkulation?monat=2026-13')).statusCode).toBe(400);
    });
  });

  describe('Mandanten-Einstellungen', () => {
    it('GET für alle, PUT nur Admin, deutsche Meldungen, Audit je Feld', async () => {
      const r = await get(controller, '/api/v1/mandant/einstellungen');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        zeitzone: 'Europe/Berlin',
        waehrung: 'EUR',
        code_anteil_sitz: 1,
      });
      expect(
        (await put(controller, '/api/v1/mandant/einstellungen', { schatten_faktor: 2 })).statusCode,
      ).toBe(403);

      const falsch = await put(admin, '/api/v1/mandant/einstellungen', {
        code_anteil_sitz: 1.5,
        zeitzone: 'Mond/Basis',
      });
      expect(falsch.statusCode).toBe(400);
      const meldungen = (falsch.json() as { details: { message: string }[] }).details.map(
        (d) => d.message,
      );
      expect(meldungen).toContain('Code-Anteil höchstens 1');
      expect(meldungen.some((m) => m.startsWith('Unbekannte Zeitzone'))).toBe(true);
      expect((await put(admin, '/api/v1/mandant/einstellungen', {})).statusCode).toBe(400);

      const ok = await put(admin, '/api/v1/mandant/einstellungen', {
        code_anteil_sitz: 0.5,
        schatten_faktor: 1.1,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ code_anteil_sitz: 0.5, schatten_faktor: 1.1 });
      const k = await kalkulation(admin);
      // x: 1,1 · 382 + 0,5 · (87,457627 + 71,264368) = 420,2 + 79,360998 = 499,56 $
      expect(zeile(k, x).projektpreis_usd_cent).toBe(49_956);
      const audit = await db
        .selectFrom('audit')
        .select('objekt')
        .where('mandant_id', '=', a)
        .where('aktion', '=', 'Einstellung geändert')
        .execute();
      expect(audit.map((e) => e.objekt)).toEqual(
        expect.arrayContaining([
          'mandant.code_anteil_sitz: 1 → 0.5',
          'mandant.schatten_faktor: 1 → 1.1',
          'mandant.sitzkosten_verteilung: person → gleich',
        ]),
      );
      await put(admin, '/api/v1/mandant/einstellungen', {
        code_anteil_sitz: 1,
        schatten_faktor: 1,
      });
    });
  });

  describe('Berichte', () => {
    it('Projektabrechnung CSV: BOM, Semikolon, Dezimalkomma, keine Personendaten (Stufe 1), Audit', async () => {
      const r = await get(admin, `/api/v1/berichte/projektabrechnung?monat=${MONAT}&format=csv`);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
      expect(r.headers['content-disposition']).toContain(`projektabrechnung-${MONAT}.csv`);
      const text = r.body;
      expect(text.startsWith('\uFEFF')).toBe(true);
      const zeilen = text.slice(1).trimEnd().split('\r\n');
      expect(zeilen[0]?.split(';')[0]).toBe('Monat');
      expect(zeilen).toHaveLength(1 + 4 + 1);
      expect(text).toContain('test/x-shop');
      expect(text).toContain(';540,72;');
      expect(text).toContain(';465,02;');
      expect(text).toContain('0,860000');
      expect(zeilen.at(-1)).toContain(';Summe;');
      for (const p of [...pseudonyme, p1, p2, p3]) expect(text).not.toContain(p);
      const audit = await db
        .selectFrom('audit')
        .select('objekt')
        .where('mandant_id', '=', a)
        .where('aktion', '=', 'Export Projektabrechnung')
        .execute();
      expect(audit.map((e) => e.objekt)).toContain(`monat:${MONAT} format:csv`);
    });

    it('Projektabrechnung JSON für Projektleiter: nur eigenes Projekt', async () => {
      const r = await get(leiter, `/api/v1/berichte/projektabrechnung?monat=${MONAT}&format=json`);
      expect(r.statusCode).toBe(200);
      const j = r.json() as { stand: string; zeilen: { projekt_id: string }[] };
      expect(j.stand).toBe('vorlaeufig');
      expect(j.zeilen.map((z) => z.projekt_id)).toEqual([x]);
    });

    it('Betriebsrats-Bericht: Zähler stimmen mit der DB, keine Personen- oder Kontodaten', async () => {
      await db
        .insertInto('ingest_statistik')
        .values([
          {
            mandant_id: a,
            tag: '2026-09-05',
            quelle: 'a',
            angenommen: 10,
            verworfen_inhalt: 3,
            verworfen_api: 2,
            verworfen_fremd_org: 1,
            unzugeordnet: 0,
          },
          {
            mandant_id: a,
            tag: '2026-09-06',
            quelle: 'b',
            angenommen: 5,
            verworfen_inhalt: 0,
            verworfen_api: 0,
            verworfen_fremd_org: 0,
            unzugeordnet: 1,
          },
          {
            mandant_id: a,
            tag: '2026-10-01',
            quelle: 'a',
            angenommen: 99,
            verworfen_inhalt: 99,
            verworfen_api: 0,
            verworfen_fremd_org: 0,
            unzugeordnet: 0,
          },
        ])
        .execute();
      await db
        .insertInto('loeschlauf')
        .values([
          {
            mandant_id: a,
            tabelle: 'anfrage',
            bis: '2026-06-01',
            anzahl: 42,
            ts: '2026-09-02T01:00:00Z',
          },
          {
            mandant_id: a,
            tabelle: 'audit',
            bis: '2024-09-01',
            anzahl: 7,
            ts: '2026-08-02T01:00:00Z',
          },
        ])
        .execute();
      await db
        .insertInto('audit')
        .values([
          {
            mandant_id: a,
            benutzer_id: admin.benutzerId,
            aktion: 'Personensicht geöffnet',
            objekt: 'personen',
            ts: '2026-09-10T08:00:00Z',
          },
          {
            mandant_id: a,
            benutzer_id: admin.benutzerId,
            aktion: 'Personensicht geöffnet',
            objekt: 'personen',
            ts: '2026-09-11T08:00:00Z',
          },
          {
            mandant_id: a,
            benutzer_id: admin.benutzerId,
            aktion: 'Export Projektabrechnung',
            objekt: 'x',
            ts: '2026-09-12T08:00:00Z',
          },
          {
            mandant_id: a,
            benutzer_id: admin.benutzerId,
            aktion: 'Ansicht Betriebsrat',
            objekt: 'bericht:betriebsrat monat:2026-08',
            ts: '2026-09-12T08:30:00Z',
          },
          {
            mandant_id: a,
            benutzer_id: admin.benutzerId,
            aktion: 'Einstellung geändert',
            objekt: 'mandant.auswertungsstufe: 1 → 2',
            ts: '2026-09-12T09:00:00Z',
          },
          {
            mandant_id: a,
            benutzer_id: admin.benutzerId,
            aktion: 'Sitz geändert',
            objekt: `person:${p1} premium`,
            ts: '2026-09-12T10:00:00Z',
          },
        ])
        .execute();
      await db
        .insertInto('rechner')
        .values([
          {
            mandant_id: a,
            person_id: p1,
            bezeichnung: 'MacBook',
            os: 'macos',
            agent_version: '0.3.0',
          },
          {
            mandant_id: a,
            person_id: p2,
            bezeichnung: 'alt',
            os: 'linux',
            agent_version: '0.1.0',
            widerrufen: new Date(),
          },
        ])
        .execute();

      const r = await get(betriebsrat, `/api/v1/berichte/betriebsrat?monat=${MONAT}&format=json`);
      expect(r.statusCode).toBe(200);
      const bericht = betriebsratBerichtSchema.parse(r.json());
      expect(bericht.konfiguration).toMatchObject({
        auswertungsstufe: 1,
        klarnamen_aktiv: false,
        mindestgruppe: 3,
      });
      expect(bericht.konfiguration.quellen).toEqual({ a: true, b: true, c: false });
      expect(bericht.konfiguration.aenderungen.map((e) => e.objekt)).toEqual([
        'mandant.auswertungsstufe: 1 → 2',
      ]);
      expect(bericht.mengen).toEqual({
        personen: 2,
        rechner: 1,
        projekte: 3,
        anfragen: 8,
        tokens: 46_400,
      });
      expect(bericht.datenschutz).toMatchObject({
        angenommen: 15,
        verworfen_inhalt: 3,
        verworfen_api: 2,
        verworfen_fremd_org: 1,
        unzugeordnet: 1,
      });
      expect(bericht.datenschutz.loeschlaeufe).toEqual([
        { ts: '2026-09-02T01:00:00.000Z', tabelle: 'anfrage', bis: '2026-06-01', anzahl: 42 },
      ]);
      expect(bericht.zugriffe.personensichten).toBe(2);
      expect(bericht.zugriffe.exporte).toBe(1);
      expect(bericht.zugriffe.ansichten).toBe(1);
      expect(bericht.zugriffe.konten.find((k) => k.rolle === 'projektleiter')?.anzahl).toBe(1);
      expect(bericht.version.agenten).toEqual(['0.3.0']);

      const html = await get(
        betriebsrat,
        `/api/v1/berichte/betriebsrat?monat=${MONAT}&format=html`,
      );
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.body).toContain('Betriebsrats-Bericht 2026-09');
      const csvText = (
        await get(betriebsrat, `/api/v1/berichte/betriebsrat?monat=${MONAT}&format=csv`)
      ).body;
      expect(csvText.startsWith('\uFEFFAbschnitt;Kennzahl;Wert')).toBe(true);
      const benutzer = await db.selectFrom('benutzer').select('benutzername').execute();
      for (const text of [html.body, csvText, r.body]) {
        for (const p of [...pseudonyme, p1, p2, p3]) expect(text).not.toContain(p);
        for (const u of benutzer) expect(text).not.toContain(u.benutzername);
      }
      const audit = await db
        .selectFrom('audit')
        .select(['aktion', 'objekt'])
        .where('mandant_id', '=', a)
        .where('aktion', 'in', ['Export Betriebsrat', 'Ansicht Betriebsrat'])
        .execute();
      // Öffnen (JSON-Ansicht, HTML-Seite) = Ansicht, CSV-Download = Export (Entscheidung 2026-10-22).
      expect(audit).toEqual(
        expect.arrayContaining([
          ...['json', 'html'].map((f) => ({
            aktion: 'Ansicht Betriebsrat',
            objekt: `bericht:betriebsrat monat:${MONAT} zeitraum:2026-09-01..2026-09-30 format:${f}`,
          })),
          { aktion: 'Export Betriebsrat', objekt: `monat:${MONAT} format:csv` },
        ]),
      );
    });

    it('Betriebsrats-Bericht: Öffnen schreibt genau eine Ansicht, Download genau einen Export', async () => {
      const zaehle = async () => {
        const zeilen = await db
          .selectFrom('audit')
          .select(['aktion', 'benutzer_id', 'objekt'])
          .where('mandant_id', '=', a)
          .where('aktion', 'in', ['Export Betriebsrat', 'Ansicht Betriebsrat'])
          .where('benutzer_id', '=', betriebsrat.benutzerId)
          .execute();
        return {
          ansicht: zeilen.filter((z) => z.aktion === 'Ansicht Betriebsrat'),
          export: zeilen.filter((z) => z.aktion === 'Export Betriebsrat'),
        };
      };
      const vorher = await zaehle();
      const ansicht = await get(
        betriebsrat,
        `/api/v1/berichte/betriebsrat?monat=2026-08&format=json`,
      );
      expect(ansicht.statusCode).toBe(200);
      const nachAnsicht = await zaehle();
      expect(nachAnsicht.ansicht.length - vorher.ansicht.length).toBe(1);
      expect(nachAnsicht.export.length).toBe(vorher.export.length);
      // Ohne Inhalte: nur Berichtsart, Zeitraum, Format (kein Zähler, keine Namen).
      expect(nachAnsicht.ansicht.map((z) => z.objekt)).toContain(
        'bericht:betriebsrat monat:2026-08 zeitraum:2026-08-01..2026-08-31 format:json',
      );
      const download = await get(
        betriebsrat,
        `/api/v1/berichte/betriebsrat?monat=2026-08&format=csv`,
      );
      expect(download.statusCode).toBe(200);
      const nachDownload = await zaehle();
      expect(nachDownload.export.length - nachAnsicht.export.length).toBe(1);
      expect(nachDownload.ansicht.length).toBe(nachAnsicht.ansicht.length);
    });
  });

  describe('Monatsabschluss', () => {
    let c: string;
    let adminC: TestSitzung;
    let vormonat: string;

    beforeAll(async () => {
      c = await legeMandantAn(db);
      adminC = await meldeAn(db, c, 'mandanten_admin');
      vormonat = plusMonate(heuteIn('Europe/Berlin').slice(0, 7), -1);
      await anfragePartitionenAnlegen(db, { ab: new Date(`${vormonat}-01T00:00:00Z`), monate: 2 });
      const person = await legePersonAn(db, c);
      const projekt = await legeProjektAn(db, c, 'preis-test');
      const anfrage = (tag: string) => ({
        mandant_id: c,
        anfrage_key: `req_${randomUUID()}`,
        ts: new Date(`${tag}T10:00:00Z`),
        tag,
        person_id: person,
        projekt_id: projekt,
        model: 'claude-sonnet-5-5-test',
        input: 1_000_000,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        auth_klasse: 'abo' as const,
        zaehlt_als_abo: true,
        quellen: 1,
      });
      await db
        .insertInto('anfrage')
        .values([anfrage(`${vormonat}-05`), anfrage(`${vormonat}-20`)])
        .execute();
      await aggregiereTage(db, c, `${vormonat}-01`, `${vormonat}-28`);
      await put(adminC, `/api/v1/kurs?monat=${vormonat}`, { usd_eur: 0.9 });
    });

    const abschluss = async () =>
      monatsabschlussSchema.parse(
        (await get(adminC, `/api/v1/monatsabschluss?monat=${vormonat}`)).json(),
      );

    it('idempotent; Preisänderung mit späterem gueltig_ab ändert nur die Live-Sicht; erzwingen überschreibt mit Audit', async () => {
      expect((await abschluss()).abgeschlossen).toBe(false);
      const erst = await post(adminC, `/api/v1/jobs/kalkulation/monatsabschluss?monat=${vormonat}`);
      expect(erst.json()).toMatchObject({ status: 'angelegt', zeilen: 1 });
      const zweit = await post(
        adminC,
        `/api/v1/jobs/kalkulation/monatsabschluss?monat=${vormonat}`,
      );
      expect(zweit.json()).toMatchObject({ status: 'vorhanden', zeilen: 1 });
      // Job über alle Mandanten lässt den vorhandenen Abschluss ebenfalls stehen.
      await monatsabschlussJob({ db, konfiguration });

      let eingefroren = (await abschluss()).abschluss;
      expect(eingefroren?.quelle).toBe('monatsabschluss');
      // 2 × 1 MTok × 2 $ (globaler Sonnet-5.5-Preis) = 4 $, Kurs 0,9 → 3,60 €
      expect(eingefroren?.zeilen[0]).toMatchObject({
        schatten_usd_micros: 4 * M,
        projektpreis_eur_cent: 360,
      });
      expect(eingefroren?.kurs).toMatchObject({ usd_eur: 0.9, quelle: 'manuell' });

      // Neuer Mandantenpreis ab dem 15. (Input 4 $/MTok), danach Neuaufbau des Aggregats.
      const preis = await app.inject({
        method: 'POST',
        url: '/api/v1/preise',
        headers: adminC.headers,
        payload: {
          modell_praefix: 'claude-sonnet-5-5-test',
          gueltig_ab: `${vormonat}-15`,
          saetze: { input: 4, output: 20, cache_read: 0.4, cache_write_5m: 5, cache_write_1h: 8 },
          quelle_url: 'https://example.org/vertrag',
          geprueft_am: `${vormonat}-15`,
        },
      });
      expect(preis.statusCode).toBe(201);
      await aggregiereTage(db, c, `${vormonat}-01`, `${vormonat}-28`);

      const live = await kalkulation(adminC, vormonat);
      expect(live.abgeschlossen).toBe(true);
      expect(live.zeilen[0]?.schatten_usd_micros).toBe(6 * M);
      eingefroren = (await abschluss()).abschluss;
      expect(eingefroren?.zeilen[0]?.schatten_usd_micros).toBe(4 * M);

      // Projektabrechnung nutzt den Abschluss.
      const pa = (
        await get(adminC, `/api/v1/berichte/projektabrechnung?monat=${vormonat}&format=json`)
      ).json() as {
        stand: string;
      };
      expect(pa.stand).toBe('abgeschlossen');

      const erzwungen = await post(
        adminC,
        `/api/v1/jobs/kalkulation/monatsabschluss?monat=${vormonat}&erzwingen=1`,
      );
      expect(erzwungen.json()).toMatchObject({ status: 'ueberschrieben', zeilen: 1 });
      eingefroren = (await abschluss()).abschluss;
      expect(eingefroren?.zeilen[0]?.schatten_usd_micros).toBe(6 * M);
      expect(eingefroren?.hinweise).toContain('Abschluss wurde erzwungen neu erstellt.');
      const audit = await db
        .selectFrom('audit')
        .select(['aktion', 'benutzer_id'])
        .where('mandant_id', '=', c)
        .where('aktion', 'like', 'Monatsabschluss%')
        .orderBy('id')
        .execute();
      expect(audit.map((e) => e.aktion)).toEqual([
        'Monatsabschluss erstellt',
        'Monatsabschluss überschrieben',
      ]);
      expect(audit[1]?.benutzer_id).toBe(adminC.benutzerId);
    });
  });

  describe('EZB-Kurs', () => {
    it('liest die aufgezeichnete Antwort (Monatsmittel endgültig, laufender Monat vorläufig)', async () => {
      const reihe = leseEzbReihe(JSON.parse(fixture('monat.json')));
      expect([...reihe.keys()]).toEqual(['2026-07', '2026-08', '2026-09']);
      const kurse = await holeEzbKurse(ezbFetch, new Date('2026-10-22T05:00:00Z'));
      expect(Object.fromEntries(kurse)).toEqual({
        '2026-07': { usdEur: 0.87585, vorlaeufig: false },
        '2026-08': { usdEur: 0.862582, vorlaeufig: false },
        '2026-09': { usdEur: 0.868566, vorlaeufig: false },
        '2026-10': { usdEur: 0.891456, vorlaeufig: true },
      });
    });

    it('Job schreibt je Mandant; manueller Kurs gewinnt; endgültig wird nicht vorläufig', async () => {
      const d = await legeMandantAn(db);
      const adminD = await meldeAn(db, d, 'mandanten_admin');
      await put(adminD, '/api/v1/kurs?monat=2026-08', { usd_eur: 0.9 });
      const jetzt = new Date('2026-10-22T05:00:00Z');
      const e = await kursEzbAktualisieren(db, { fetch: ezbFetch, jetzt, mandanten: [d] });
      expect(e).toMatchObject({ mandanten: 1, monate: 4, geschrieben: 3 });
      const kurse = (await get(adminD, '/api/v1/kurse')).json() as {
        zeilen: { monat: string; usd_eur: number; quelle: string; vorlaeufig: boolean }[];
      };
      expect(kurse.zeilen.map((k) => [k.monat, k.usd_eur, k.quelle, k.vorlaeufig])).toEqual([
        ['2026-10', 0.891456, 'ezb', true],
        ['2026-09', 0.868566, 'ezb', false],
        ['2026-08', 0.9, 'manuell', false],
        ['2026-07', 0.87585, 'ezb', false],
      ]);
      // Ohne Monatsmittel (nur Tageskurse) bleibt der endgültige Septemberwert stehen.
      const nurTage: FetchFunktion = async (url) =>
        url.includes('/D.USD.EUR.') ? ezbFetch(url) : new Response('', { status: 404 });
      await kursEzbAktualisieren(db, { fetch: nurTage, jetzt, mandanten: [d] });
      const sept = (await get(adminD, '/api/v1/kurs?monat=2026-09')).json() as {
        vorlaeufig: boolean;
      };
      expect(sept.vorlaeufig).toBe(false);
      // Manuellen Kurs löschen: nächster Abruf füllt den Monat wieder aus der EZB.
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/kurs?monat=2026-08',
            headers: adminD.headers,
          })
        ).statusCode,
      ).toBe(204);
      await kursEzbAktualisieren(db, { fetch: ezbFetch, jetzt, mandanten: [d] });
      expect(
        ((await get(adminD, '/api/v1/kurs?monat=2026-08')).json() as { quelle: string }).quelle,
      ).toBe('ezb');
      // Kurs setzen nur als Admin.
      const leser = await meldeAn(db, d, 'controller');
      expect((await put(leser, '/api/v1/kurs?monat=2026-08', { usd_eur: 1 })).statusCode).toBe(403);
      expect((await put(adminD, '/api/v1/kurs?monat=2026-08', { usd_eur: 0 })).statusCode).toBe(
        400,
      );
    });
  });
});
