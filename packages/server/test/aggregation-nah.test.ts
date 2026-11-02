// Job `aggregation.nah`: dasselbe Ergebnis wie der nächtliche Lauf, Sperren, keine halben Stände, nichts Überflüssiges schreiben.
// Eigene Datenbank: Ein Test legt vorübergehend eine Prüfregel auf `tag_aggregat`. Nur erfundene Daten.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGGREGATION_NAH,
  aggregationNahJob,
  aggregationNahZeitplan,
  aggregiereTage,
} from '../src/aggregation/index.js';
import { ladeKonfiguration } from '../src/config.js';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { anfragePartitionenAnlegen } from '../src/db/partitionen.js';
import { migriere } from '../src/db/migrator.js';
import { fuehreJobAus, imJobLauf, JobPlaner } from '../src/jobs/index.js';
import { schliesseMonat } from '../src/kalkulation/abschluss.js';
import { aggregationPlugin } from '../src/aggregation/index.js';
import { aufbewahrungJob } from '../src/aufbewahrung/index.js';
import { pruefeBudgets } from '../src/budgets/pruefen.js';
import {
  kernApp,
  legeMandantAn,
  legePersonAn,
  legeProjektAn,
  meldeAn,
  testKonfiguration,
} from './api-hilfen.js';
import { frischeDatenbank } from './db-hilfen.js';

const j = new Date();
const MONAT = j.toISOString().slice(0, 7);
const HEUTE = `${MONAT}-15`;
const GESTERN = `${MONAT}-14`;
/** Fester Zeitpunkt: mitten im Monat, damit der Lauf nicht vom Kalendertag des Testlaufs abhängt. */
const JETZT = new Date(`${HEUTE}T12:00:00Z`);
const FOLGEMONAT = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, 1))
  .toISOString()
  .slice(0, 7);

let db: Db;
let url: string;
const ctx = () => ({ db, konfiguration: testKonfiguration(url) });

interface Aufbau {
  m: string;
  personen: string[];
  repos: string[];
}

async function aufbau(): Promise<Aufbau> {
  const m = await legeMandantAn(db);
  return {
    m,
    personen: [await legePersonAn(db, m), await legePersonAn(db, m)],
    repos: [await legeProjektAn(db, m, 'eins'), await legeProjektAn(db, m, 'zwei')],
  };
}

interface Roh {
  tag: string;
  person?: string | null;
  projekt?: string | null;
  model?: string;
  speed?: string | null;
  abo?: boolean;
  input?: number;
  cacheWrite?: number;
  cache1h?: number | null;
  webSearch?: number;
  issue?: string[] | null;
}

async function anfrage(m: string, z: Roh): Promise<string> {
  const key = `msg:${randomUUID()}`;
  await db
    .insertInto('anfrage')
    .values({
      mandant_id: m,
      anfrage_key: key,
      ts: new Date(`${z.tag}T10:00:00Z`),
      tag: z.tag,
      session_id: 's-1',
      person_id: z.person ?? null,
      projekt_id: z.projekt ?? null,
      model: z.model ?? 'claude-opus-5-5',
      speed: z.speed === undefined ? null : z.speed,
      auth_klasse: 'abo',
      zaehlt_als_abo: z.abo ?? true,
      input: z.input ?? 1000,
      output: 500,
      cache_read: 10,
      cache_write: z.cacheWrite ?? 0,
      cache_write_1h: z.cache1h ?? null,
      web_search: z.webSearch ?? 0,
      quellen: 1,
      issue_schluessel: z.issue ?? null,
    })
    .execute();
  return key;
}

/** Abwechslungsreiche Daten: mit und ohne Person und Repo, Preis, Geschwindigkeit, Cache, Nicht-Abo. */
async function vielfalt(a: Aufbau, tag: string) {
  const [p1, p2] = a.personen;
  const [r1, r2] = a.repos;
  await anfrage(a.m, { tag, person: p1, projekt: r1 });
  await anfrage(a.m, { tag, person: p1, projekt: r1, input: 7 });
  await anfrage(a.m, { tag, person: p1, projekt: r2, cacheWrite: 5000 });
  await anfrage(a.m, { tag, person: p2, projekt: r1, cacheWrite: 700, cache1h: 300 });
  await anfrage(a.m, { tag, person: p2, projekt: r1, speed: 'fast', webSearch: 3 });
  await anfrage(a.m, { tag, person: p2, projekt: null });
  await anfrage(a.m, { tag, person: null, projekt: r2 });
  await anfrage(a.m, { tag, person: null, projekt: null, speed: 'normal' });
  await anfrage(a.m, { tag, person: p1, projekt: r1, model: 'modell-ohne-preis' });
  await anfrage(a.m, { tag, person: p1, projekt: r1, abo: false, input: 999_999 });
  await anfrage(a.m, { tag, person: p1, projekt: r2, issue: ['ABC-1'] });
}

const zeilen = async (m: string) => {
  const r = await withMandant(db, m, (t) =>
    t
      .selectFrom('tag_aggregat')
      .selectAll()
      .orderBy(['tag', 'person_id', 'projekt_id', 'model', 'speed'])
      .execute(),
  );
  return r;
};
const versionen = async (m: string) =>
  (
    await withMandant(db, m, (t) =>
      sql<{ v: string }>`
        SELECT tag::text || person_id::text || projekt_id::text || model || speed || ':' || xmin::text AS v
        FROM tag_aggregat ORDER BY 1`.execute(t),
    )
  ).rows.map((z) => z.v);
const lauf = (m: string, jetzt = JETZT) => aggregationNahJob(ctx(), jetzt, [m]);

/** Häufiger Lauf und nächtlicher Lauf müssen auf denselben Daten Zeile für Zeile und Spalte für Spalte gleich sein. */
async function erwarteWieNachts(m: string, von = GESTERN, bis = HEUTE) {
  const nah = await zeilen(m);
  await aggregiereTage(db, m, von, bis);
  const nachts = await zeilen(m);
  expect(nah).toEqual(nachts);
  return nah;
}

beforeAll(async () => {
  url = await frischeDatenbank('seatmeter_test_nah');
  db = erstelleDb(url, 6);
  await migriere(db);
  await anfragePartitionenAnlegen(db);
});

afterAll(async () => {
  await db.destroy();
});

describe('gleich wie der nächtliche Lauf', () => {
  it('auf leerem Stand: jede Zeile und jede Spalte', async () => {
    const a = await aufbau();
    await vielfalt(a, HEUTE);
    await vielfalt(a, GESTERN);
    await anfrage(a.m, { tag: `${MONAT}-13`, person: a.personen[0], projekt: a.repos[0] });
    const e = await lauf(a.m);
    expect(e).toMatchObject({ tage_gerechnet: 2, anfragen: 20, fehlgeschlagen: 0 });
    const nah = await erwarteWieNachts(a.m);
    expect(nah.length).toBeGreaterThan(10);
    // Tage außerhalb bleiben unberührt: Dafür ist der nächtliche Lauf da.
    expect(nah.map((z) => z.tag)).not.toContain(`${MONAT}-13`);
  });

  it('nach jeder Art Änderung: neu, umgebucht, gelöscht, nicht mehr Abo, Preis und Annahme', async () => {
    const a = await aufbau();
    await vielfalt(a, HEUTE);
    await vielfalt(a, GESTERN);
    await aggregiereTage(db, a.m, GESTERN, HEUTE);
    expect(await lauf(a.m)).toMatchObject({
      zeilen_neu: 0,
      zeilen_geaendert: 0,
      zeilen_geloescht: 0,
    });

    const key = await anfrage(a.m, { tag: HEUTE, person: a.personen[0], projekt: a.repos[1] });
    expect((await lauf(a.m)).zeilen_geaendert).toBeGreaterThan(0);
    await erwarteWieNachts(a.m);

    // Umbuchen ohne neue Anfrage, wie es `merge.ab` tun kann: gleiche Summen, andere Zeile.
    await db
      .updateTable('anfrage')
      .set({ projekt_id: null, person_id: null })
      .where('anfrage_key', '=', key)
      .execute();
    const um = await lauf(a.m);
    expect(um.tage_gerechnet).toBe(1);
    await erwarteWieNachts(a.m);

    // Eine Gruppe verschwindet ganz.
    await db
      .deleteFrom('anfrage')
      .where('mandant_id', '=', a.m)
      .where('tag', '=', GESTERN)
      .where('model', '=', 'modell-ohne-preis')
      .execute();
    expect((await lauf(a.m)).zeilen_geloescht).toBe(1);
    await erwarteWieNachts(a.m);

    // Nicht mehr Abo.
    await db
      .updateTable('anfrage')
      .set({ zaehlt_als_abo: false })
      .where('mandant_id', '=', a.m)
      .where('tag', '=', HEUTE)
      .where('speed', '=', 'fast')
      .execute();
    expect((await lauf(a.m)).tage_gerechnet).toBe(1);
    await erwarteWieNachts(a.m);

    // Annahme und Preise ohne jede neue Anfrage: Der Betrag ändert sich wie nachts.
    const vor = await zeilen(a.m);
    await db
      .updateTable('mandant')
      .set({ cache_write_annahme: '5m' })
      .where('id', '=', a.m)
      .execute();
    expect((await lauf(a.m)).tage_gerechnet).toBe(2);
    const nach = await erwarteWieNachts(a.m);
    expect(nach).not.toEqual(vor);
    await db
      .insertInto('preis')
      .values({
        mandant_id: a.m,
        modell_praefix: 'modell-ohne-preis',
        gueltig_ab: '2020-01-01',
        input: '1',
        output: '2',
        cache_read: '0.1',
        cache_write_5m: '1',
        cache_write_1h: '2',
        quelle_url: 'https://preise.example.org',
        geprueft_am: '2026-01-01',
      })
      .execute();
    expect((await lauf(a.m)).tage_gerechnet).toBe(2);
    await erwarteWieNachts(a.m);
  });

  it('Tagesgrenze des Mandanten wie nachts: Zeitzone entscheidet über heute und gestern', async () => {
    const a = await aufbau();
    await db.updateTable('mandant').set({ zeitzone: 'Asia/Tokyo' }).where('id', '=', a.m).execute();
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
    await anfrage(a.m, { tag: GESTERN, person: a.personen[0] });
    await anfrage(a.m, { tag: `${MONAT}-13`, person: a.personen[0] });
    // 20:00 UTC am 14. ist in Tokio schon der 15.
    await lauf(a.m, new Date(`${GESTERN}T20:00:00Z`));
    expect([...new Set((await zeilen(a.m)).map((z) => z.tag))].sort()).toEqual([GESTERN, HEUTE]);
  });

  it('am Ersten: gestern liegt im Vormonat, auch der ist gleich wie nachts', async () => {
    const a = await aufbau();
    const erster = `${FOLGEMONAT}-01`;
    const letzter = new Date(new Date(`${erster}T12:00:00Z`).getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await vielfalt(a, erster);
    await vielfalt(a, letzter);
    await lauf(a.m, new Date(`${erster}T01:00:00Z`));
    const z = await erwarteWieNachts(a.m, letzter, erster);
    expect(new Set(z.map((x) => x.tag))).toEqual(new Set([letzter, erster]));
  });

  it('gestern im gerade abgeschlossenen Monat: Abschluss und Kosten bleiben, das Aggregat folgt wie nachts', async () => {
    const a = await aufbau();
    const erster = `${FOLGEMONAT}-01`;
    const letzter = new Date(new Date(`${erster}T12:00:00Z`).getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await vielfalt(a, letzter);
    await aggregiereTage(db, a.m, letzter, letzter);
    await schliesseMonat(db, a.m, MONAT);
    const stand = () =>
      withMandant(db, a.m, (t) =>
        t.selectFrom('monatsabschluss').selectAll().orderBy(['projekt_id', 'topf']).execute(),
      );
    const vorher = await stand();
    expect(vorher.length).toBeGreaterThan(0);
    await anfrage(a.m, { tag: letzter, person: a.personen[0], projekt: a.repos[0], input: 123 });
    const e = await lauf(a.m, new Date(`${erster}T01:00:00Z`));
    expect(e.tage_gerechnet).toBeGreaterThan(0);
    expect(await stand()).toEqual(vorher);
    await erwarteWieNachts(a.m, letzter, erster);
  });
});

describe('Last', () => {
  it('nichts Neues: Tage werden nicht gerechnet, keine Zeile geschrieben; Neues schreibt nur die betroffene Zeile', async () => {
    const a = await aufbau();
    await vielfalt(a, HEUTE);
    await vielfalt(a, GESTERN);
    await lauf(a.m);
    const v1 = await versionen(a.m);
    expect(await lauf(a.m)).toMatchObject({ tage_unveraendert: 2, tage_gerechnet: 0, anfragen: 0 });
    expect(await versionen(a.m)).toEqual(v1);

    await anfrage(a.m, { tag: HEUTE, person: a.personen[0], projekt: a.repos[0] });
    expect(await lauf(a.m)).toMatchObject({
      tage_unveraendert: 1,
      tage_gerechnet: 1,
      zeilen_geaendert: 1,
      zeilen_neu: 0,
    });
    const v2 = await versionen(a.m);
    expect(v2.filter((x) => !v1.includes(x))).toHaveLength(1);

    // Ein neuer Prozess kennt keine Signaturen: Er rechnet einmal, schreibt aber nichts.
    const anderer = erstelleDb(url, 2);
    try {
      const e = await aggregationNahJob(
        { db: anderer, konfiguration: testKonfiguration(url) },
        JETZT,
        [a.m],
      );
      expect(e).toMatchObject({ tage_gerechnet: 2, zeilen_neu: 0, zeilen_geaendert: 0 });
    } finally {
      await anderer.destroy();
    }
    expect(await versionen(a.m)).toEqual(v2);
  });

  it('Issue-Aggregat höchstens stündlich neu, damit der Monat nicht bei jedem Lauf gelesen wird', async () => {
    const a = await aufbau();
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0], issue: ['ABC-1'] });
    const issues = async () =>
      (
        await withMandant(db, a.m, (t) =>
          t.selectFrom('issue_aggregat').select(['schluessel', 'anfragen']).execute(),
        )
      ).map((z) => [z.schluessel, Number(z.anfragen)]);
    expect((await lauf(a.m)).issue_monate).toBe(1);
    expect(await issues()).toEqual([['ABC-1', 1]]);
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0], issue: ['ABC-1'] });
    expect((await lauf(a.m)).issue_monate).toBe(0);
    expect(await issues()).toEqual([['ABC-1', 1]]);
    // Eine Stunde später holt es das nach, auch ohne neue Anfrage.
    const spaeter = new Date(JETZT.getTime() + 3_600_000);
    expect((await lauf(a.m, spaeter)).issue_monate).toBe(1);
    expect(await issues()).toEqual([['ABC-1', 2]]);
    await aggregiereTage(db, a.m, GESTERN, HEUTE);
    expect(await issues()).toEqual([['ABC-1', 2]]);
  });

  it('job_lauf: erfolgreiche Läufe eine Woche, Fehler und andere Jobs 90 Tage', async () => {
    const alt = new Date(JETZT.getTime() - 8 * 86_400_000);
    const zeile = (job: string, status: 'ok' | 'fehler') => ({
      job,
      status,
      gestartet: alt,
      beendet: alt,
    });
    await db
      .insertInto('job_lauf')
      .values([
        zeile(AGGREGATION_NAH, 'ok'),
        zeile(AGGREGATION_NAH, 'fehler'),
        zeile('merge.ab', 'ok'),
      ])
      .execute();
    await aufbewahrungJob(ctx(), JETZT);
    const rest = await db
      .selectFrom('job_lauf')
      .select(['job', 'status'])
      .where('gestartet', '=', alt)
      .orderBy('job')
      .execute();
    expect(rest).toEqual([
      { job: AGGREGATION_NAH, status: 'fehler' },
      { job: 'merge.ab', status: 'ok' },
    ]);
  });
});

describe('Sperren und Transaktion', () => {
  /** Hält die Sperre eines Mandanten in einer eigenen Transaktion, solange `f` läuft. */
  async function mitSperre(m: string, f: () => Promise<void>) {
    await db.transaction().execute(async (t) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`seatmeter:aggregation:${m}`}, 0))`.execute(
        t,
      );
      await f();
    });
  }

  it('Mandant gesperrt: überspringt ihn still, die anderen laufen, der nächste Lauf holt es nach', async () => {
    const a = await aufbau();
    const b = await aufbau();
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
    await anfrage(b.m, { tag: HEUTE, person: b.personen[0] });
    await mitSperre(a.m, async () => {
      const e = await aggregationNahJob(ctx(), JETZT, [a.m, b.m]);
      expect(e).toMatchObject({ gesperrt: 1, fehlgeschlagen: 0, tage_gerechnet: 2 });
      expect(await zeilen(a.m)).toEqual([]);
      expect(await zeilen(b.m)).toHaveLength(1);
    });
    expect(await lauf(a.m)).toMatchObject({ gesperrt: 0, tage_gerechnet: 2 });
    expect(await zeilen(a.m)).toHaveLength(1);
  });

  it.each(['aggregation.tag', 'kalkulation.monatsabschluss'])(
    'läuft %s: setzt aus, ohne selbst zu sperren',
    async (job) => {
      const a = await aufbau();
      await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
      await imJobLauf(ctx(), job, 'einmal', async () => {
        expect(await lauf(a.m)).toMatchObject({ ausgesetzt: job, tage_gerechnet: 0 });
        expect(await zeilen(a.m)).toEqual([]);
        // Eine zweite Instanz desselben Jobs sähe die Sperre wie bisher.
        expect((await imJobLauf(ctx(), job, 'einmal', () => Promise.resolve())).status).toBe(
          'uebersprungen',
        );
      });
      expect((await lauf(a.m)).tage_gerechnet).toBe(2);
    },
  );

  it('Monatsabschluss hält den Mandanten: Der häufige Lauf schreibt in dieser Zeit nichts', async () => {
    const a = await aufbau();
    await vielfalt(a, HEUTE);
    await aggregiereTage(db, a.m, HEUTE, HEUTE);
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0], projekt: a.repos[0] });
    const v = await versionen(a.m);
    // Der Abschluss wartet hier auf die Sperre, die der Test hält; so lange kann nichts dazwischenkommen.
    let abschluss: Promise<unknown> | null = null;
    await mitSperre(a.m, async () => {
      abschluss = schliesseMonat(db, a.m, MONAT);
      await new Promise((w) => setTimeout(w, 150));
      expect(await lauf(a.m)).toMatchObject({ gesperrt: 1 });
      expect(await versionen(a.m)).toEqual(v);
    });
    await abschluss;
    expect((await lauf(a.m)).gesperrt).toBe(0);
  });

  it('Job doppelt: Der zweite überspringt still, ohne Zeile in job_lauf und ohne zu warten', async () => {
    const a = await aufbau();
    const jobs = aggregationPlugin.jobs ?? [];
    const zaehlen = async () =>
      (
        await db
          .selectFrom('job_lauf')
          .select('id')
          .where('job', '=', AGGREGATION_NAH)
          .where('status', '=', 'uebersprungen')
          .execute()
      ).length;
    const vorher = await zaehlen();
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
    const job = jobs.find((x) => x.name === AGGREGATION_NAH);
    await imJobLauf(ctx(), AGGREGATION_NAH, 'einmal', async () => {
      const zweiter = await imJobLauf(ctx(), AGGREGATION_NAH, 'plan', () => Promise.resolve(), {
        still: job?.still,
      });
      expect(zweiter.status).toBe('uebersprungen');
    });
    expect(await zaehlen()).toBe(vorher);
    // Parallel gestartet: Die Summen stimmen danach, wer auch immer dran war.
    await Promise.all([1, 2, 3].map(() => fuehreJobAus(jobs, AGGREGATION_NAH, ctx(), 'einmal')));
    expect(await zaehlen()).toBe(vorher);
  });

  it('nächtlicher und häufiger Lauf gleichzeitig: am Ende gleich wie nachts', async () => {
    const a = await aufbau();
    await vielfalt(a, HEUTE);
    await vielfalt(a, GESTERN);
    await Promise.all([
      aggregiereTage(db, a.m, GESTERN, HEUTE),
      lauf(a.m),
      aggregiereTage(db, a.m, GESTERN, HEUTE),
      lauf(a.m),
    ]);
    await erwarteWieNachts(a.m);
  });

  it('kein halber Stand: Scheitert ein Tag, bleibt auch der andere wie er war; andere Mandanten laufen, der Job meldet es', async () => {
    const a = await aufbau();
    const b = await aufbau();
    await anfrage(a.m, { tag: GESTERN, person: a.personen[0] });
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
    await anfrage(b.m, { tag: HEUTE, person: b.personen[0] });
    const name = `nah_test_${randomUUID().slice(0, 8)}`;
    await sql`ALTER TABLE tag_aggregat ADD CONSTRAINT ${sql.raw(name)}
      CHECK (mandant_id <> ${sql.lit(a.m)}::uuid OR tag <> ${sql.lit(HEUTE)}::date) NOT VALID`.execute(
      db,
    );
    try {
      await expect(aggregationNahJob(ctx(), JETZT, [a.m, b.m])).rejects.toThrow(
        new RegExp(`${AGGREGATION_NAH}: 1 von 2 .*${a.m} \\(\\w+ 23514\\)`),
      );
      // Gestern hätte schon geklappt, ist aber mit zurückgerollt.
      expect(await zeilen(a.m)).toEqual([]);
      expect(await zeilen(b.m)).toHaveLength(1);
    } finally {
      await sql`ALTER TABLE tag_aggregat DROP CONSTRAINT ${sql.raw(name)}`.execute(db);
    }
    // Die Signatur wurde nicht gemerkt: Der nächste Lauf versucht es erneut.
    expect(await lauf(a.m)).toMatchObject({ tage_gerechnet: 2, fehlgeschlagen: 0 });
    await erwarteWieNachts(a.m);
  });

  it('Leser sehen während des Laufs den alten Stand beider Tage, danach den neuen', async () => {
    const a = await aufbau();
    await anfrage(a.m, { tag: GESTERN, person: a.personen[0] });
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
    await lauf(a.m);
    await anfrage(a.m, { tag: GESTERN, person: a.personen[0] });
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0] });
    const summen = async () => (await zeilen(a.m)).map((z) => Number(z.anfragen));
    const beobachtet = new Set<string>();
    const lauf2 = lauf(a.m);
    for (let i = 0; i < 40; i += 1) beobachtet.add((await summen()).join());
    await lauf2;
    beobachtet.add((await summen()).join());
    // Nur vorher oder nachher, nie ein Tag neu und der andere alt.
    expect([...beobachtet].every((x) => x === '1,1' || x === '2,2')).toBe(true);
  });
});

describe('Budgets', () => {
  it('frische Daten: Der Alarm kommt früher, je Schwelle aber genau einmal', async () => {
    const a = await aufbau();
    const app = await kernApp(db, url);
    const { headers } = await meldeAn(db, a.m, 'mandanten_admin');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/budgets',
      headers,
      payload: { projekt_id: null, betrag: 3000, basis: 'tokens', bezeichnung: 'Tokens' },
    });
    await app.close();
    expect(r.statusCode, r.body).toBe(201);
    const pruefen = () => pruefeBudgets(ctx(), {}, JETZT, a.m);
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0], input: 2500 });
    // Ohne Aggregat kein Verbrauch: bisher erst am nächsten Morgen.
    expect((await pruefen()).neue_alarme).toBe(0);
    await lauf(a.m);
    const erster = (await pruefen()).neue_alarme;
    expect(erster).toBeGreaterThan(0);
    expect((await pruefen()).neue_alarme).toBe(0);
    // Weitere Läufe mit derselben Schwelle: nichts Neues.
    await anfrage(a.m, { tag: HEUTE, person: a.personen[0], input: 1 });
    await lauf(a.m);
    expect((await pruefen()).neue_alarme).toBe(0);
    await aggregiereTage(db, a.m, GESTERN, HEUTE);
    expect((await pruefen()).neue_alarme).toBe(0);
  });
});

describe('Konfiguration', () => {
  const k = (wert?: string) =>
    testKonfiguration('postgres://x/y', {
      ...(wert === undefined ? {} : { SEATMETER_AGGREGATION_INTERVALL_MIN: wert }),
    });

  it('Standard 5 Minuten, eine Minute nach merge.ab; 0 = aus, Grenzen geprüft', () => {
    expect(aggregationNahZeitplan(k())).toBe('1-59/5 * * * *');
    expect(aggregationNahZeitplan(k('1'))).toBe('* * * * *');
    expect(aggregationNahZeitplan(k('15'))).toBe('1-59/15 * * * *');
    expect(aggregationNahZeitplan(k('60'))).toBe('1 * * * *');
    expect(aggregationNahZeitplan(k('0'))).toBeNull();
    const basis = { DATABASE_URL: 'postgres://x/y', SEATMETER_MASTER_KEY: 'a'.repeat(44) };
    for (const falsch of ['61', '-1', 'bald', '2.5']) {
      expect(
        () => ladeKonfiguration({ ...basis, SEATMETER_AGGREGATION_INTERVALL_MIN: falsch }),
        falsch,
      ).toThrow();
    }
  });

  it('0: Der Planer startet den Job nicht, --einmal geht trotzdem', async () => {
    const a = await aufbau();
    await anfrage(a.m, { tag: j.toISOString().slice(0, 10), person: a.personen[0] });
    const jobs = aggregationPlugin.jobs ?? [];
    const log = { info: () => undefined, error: () => undefined } as never;
    const aus = new JobPlaner(jobs, { db, konfiguration: k('0') }, log);
    const zeit = new Date('2026-01-01T00:06:00Z');
    expect(aus.tick(zeit)).not.toContain(AGGREGATION_NAH);
    const an = new JobPlaner(jobs, { db, konfiguration: k() }, log);
    expect(an.tick(zeit)).toContain(AGGREGATION_NAH);
    await an.stop();
    const e = await fuehreJobAus(jobs, AGGREGATION_NAH, { db, konfiguration: k('0') }, 'einmal');
    expect(e.status).toBe('ok');
  });
});
