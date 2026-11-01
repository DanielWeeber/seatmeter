import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aufbewahrungJob, minusMonate } from '../src/aufbewahrung/index.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { anfragePartitionenAnlegen } from '../src/db/partitionen.js';
import { fuehreJobAus, imJobLauf, JobPlaner, parseCron, passt } from '../src/jobs/index.js';
import type { JobDefinition, PluginKontext } from '../src/plugin.js';
import { legeMandantAn, legePersonAn, legeProjektAn, testKonfiguration } from './api-hilfen.js';

describe('Job-Planer', () => {
  let db: Db;
  let ctx: PluginKontext;

  beforeAll(() => {
    const konfiguration = testKonfiguration(inject('testDatenbankUrl'));
    db = erstelleDb(konfiguration.DATABASE_URL, 4);
    ctx = { db, konfiguration };
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('Cron: Felder, Listen, Bereiche, Schritte', () => {
    const c = parseCron('15 2 * * *');
    expect(passt(c, new Date('2026-10-22T02:15:00Z'))).toBe(true);
    expect(passt(c, new Date('2026-10-22T02:16:00Z'))).toBe(false);
    const s = parseCron('*/15 8-10 1,15 * 1-5');
    expect(passt(s, new Date('2026-10-01T09:30:00Z'))).toBe(true);
    // Tag ODER Wochentag (2026-10-22 ist ein Donnerstag)
    expect(passt(s, new Date('2026-10-22T08:45:00Z'))).toBe(true);
    expect(passt(s, new Date('2026-10-24T08:45:00Z'))).toBe(false);
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
  });

  it('protokolliert Läufe in job_lauf, Fehler und parallele Läufe', async () => {
    const name = `test.${randomUUID()}`;
    const ok = await imJobLauf(ctx, name, 'einmal', async () => ({ zeilen: 3 }));
    expect(ok).toEqual({ status: 'ok', ergebnis: { zeilen: 3 } });
    const fehler = await imJobLauf(ctx, name, 'einmal', async () => {
      throw new Error('kaputt');
    });
    expect(fehler).toMatchObject({ status: 'fehler', fehler: 'kaputt' });
    let freigeben!: () => void;
    const lang = imJobLauf(ctx, name, 'plan', () => new Promise<void>((r) => (freigeben = r)));
    await new Promise((r) => setTimeout(r, 200));
    const parallel = await imJobLauf(ctx, name, 'api', async () => 1);
    expect(parallel.status).toBe('uebersprungen');
    freigeben();
    await lang;
    const laeufe = await db
      .selectFrom('job_lauf')
      .select(['status', 'ergebnis', 'fehler'])
      .where('job', '=', name)
      .orderBy('gestartet')
      .execute();
    expect(laeufe.map((l) => l.status).sort()).toEqual(['fehler', 'ok', 'ok', 'uebersprungen']);
    expect(laeufe.find((l) => l.fehler === 'kaputt')).toBeTruthy();
  });

  it('fuehreJobAus und tick starten die richtigen Jobs', async () => {
    const gelaufen: string[] = [];
    const jobs: JobDefinition[] = [
      {
        name: `a.${randomUUID()}`,
        zeitplan: '0 3 * * *',
        ausfuehren: async () => void gelaufen.push('a'),
      },
      {
        name: `b.${randomUUID()}`,
        zeitplan: '30 3 * * *',
        ausfuehren: async () => void gelaufen.push('b'),
      },
    ];
    await expect(fuehreJobAus(jobs, 'gibt.es.nicht', ctx)).rejects.toThrow(/Unbekannter Job/);
    expect((await fuehreJobAus(jobs, jobs[1]?.name ?? '', ctx)).status).toBe('ok');
    const log = {
      info: () => undefined,
      error: () => undefined,
    } as unknown as ConstructorParameters<typeof JobPlaner>[2];
    const planer = new JobPlaner(jobs, ctx, log);
    expect(planer.tick(new Date('2026-10-22T03:00:00Z'))).toEqual([jobs[0]?.name]);
    await planer.stop();
    expect(gelaufen).toEqual(['b', 'a']);
  });
});

describe('Aufbewahrung (Architektur §3.5)', () => {
  let db: Db;
  let ctx: PluginKontext;
  let m: string;
  let person: string;
  let projekt: string;
  const JETZT = new Date('2025-05-15T12:00:00Z');

  beforeAll(async () => {
    const konfiguration = testKonfiguration(inject('testDatenbankUrl'));
    db = erstelleDb(konfiguration.DATABASE_URL, 4);
    ctx = { db, konfiguration };
    m = await legeMandantAn(db);
    person = await legePersonAn(db, m);
    projekt = await legeProjektAn(db, m, 'alt');
    await anfragePartitionenAnlegen(db, { ab: new Date('2025-01-01T00:00:00Z'), monate: 2 });
    const zeile = (ts: string) => ({
      mandant_id: m,
      anfrage_key: `req_${randomUUID()}`,
      ts: new Date(ts),
      tag: ts.slice(0, 10),
      model: 'claude-sonnet-5-5',
      input: 1,
      output: 1,
      cache_read: 0,
      cache_write: 0,
    });
    await db
      .insertInto('anfrage')
      .values([zeile('2025-01-15T10:00:00Z'), zeile('2025-02-20T10:00:00Z')])
      .execute();
    const agg = (tag: string, personId: string | null) => ({
      mandant_id: m,
      tag,
      person_id: personId,
      projekt_id: projekt,
      model: 'claude-sonnet-5-5',
      auth_klasse: 'abo' as const,
      input: 10,
      output: 20,
      cache_read: 0,
      cache_write: 0,
      cache_write_1h: 0,
      anfragen: 2,
      schatten_usd_micros: 220,
    });
    await db
      .insertInto('tag_aggregat')
      .values([agg('2024-01-10', person), agg('2024-01-10', null), agg('2025-03-01', person)])
      .execute();
    await db
      .insertInto('otel_kontrollsumme')
      .values([
        { mandant_id: m, tag: '2025-04-01', session_id: 's', model: 'x', typ: 'input', wert: 1 },
        { mandant_id: m, tag: '2025-05-10', session_id: 's', model: 'x', typ: 'input', wert: 1 },
      ])
      .execute();
    await db
      .insertInto('audit')
      .values({ mandant_id: m, aktion: 'Alt', ts: new Date('2023-01-01T00:00:00Z') })
      .execute();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('minusMonate', () => {
    expect(minusMonate('2025-05-15', 13)).toBe('2024-04-15');
    expect(minusMonate('2025-01-31', 1)).toBe('2024-12-31');
  });

  it('löscht genau die alte Partition, fasst alte Personenzeilen zusammen und protokolliert', async () => {
    const e = await aufbewahrungJob(ctx, JETZT);
    // 90 Tage vor 2025-05-15 = 2025-02-14 → nur der Januar ist vollständig älter.
    expect(e.partitionen_geloescht).toEqual(['anfrage_2025_01']);
    const partitionen = await sql<{ name: string }>`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'anfrage' AND c.relname LIKE 'anfrage_2025_%'`.execute(
      db,
    );
    expect(partitionen.rows.map((r) => r.name)).toEqual(['anfrage_2025_02']);
    const rest = await db.selectFrom('anfrage').select('ts').where('mandant_id', '=', m).execute();
    expect(rest).toHaveLength(1);

    const agg = await db
      .selectFrom('tag_aggregat')
      .select(['tag', 'person_id', 'input', 'anfragen', 'schatten_usd_micros'])
      .where('mandant_id', '=', m)
      .orderBy('tag')
      .execute();
    expect(agg).toEqual([
      { tag: '2024-01-10', person_id: null, input: 20, anfragen: 4, schatten_usd_micros: 440 },
      { tag: '2025-03-01', person_id: person, input: 10, anfragen: 2, schatten_usd_micros: 220 },
    ]);
    const kontrolle = await db
      .selectFrom('otel_kontrollsumme')
      .select('tag')
      .where('mandant_id', '=', m)
      .execute();
    expect(kontrolle).toEqual([{ tag: '2025-05-10' }]);

    const lauf = await db
      .selectFrom('loeschlauf')
      .select(['tabelle', 'bis', 'anzahl'])
      .where('mandant_id', '=', m)
      .execute();
    expect(lauf).toEqual(
      expect.arrayContaining([
        { tabelle: 'anfrage', bis: '2025-02-01', anzahl: 1 },
        { tabelle: 'tag_aggregat (Person)', bis: '2024-04-15', anzahl: 1 },
        { tabelle: 'otel_kontrollsumme', bis: '2025-04-15', anzahl: 1 },
        { tabelle: 'audit', bis: '2023-05-15', anzahl: 1 },
        { tabelle: 'ingest_statistik', bis: '2024-04-15', anzahl: 0 },
      ]),
    );
    // Zweiter Lauf: nichts mehr zu tun, aber wieder protokolliert.
    const zwei = await aufbewahrungJob(ctx, JETZT);
    expect(zwei.partitionen_geloescht).toEqual([]);
    expect(zwei.posten.filter((p) => p.mandant_id === m).every((p) => p.anzahl === 0)).toBe(true);
  });

  it('Sitzungs-Zuordnung bleibt, bis die letzte Anfrage der Sitzung abgelaufen ist', async () => {
    const mandant = await legeMandantAn(db);
    const katalog = await db
      .insertInto('katalog_projekt')
      .values({
        mandant_id: mandant,
        externe_id: 'P-1',
        nummer: 'P-1',
        name: 'Eins',
        quelle: 'csv',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Beide Zuordnungen sind älter als die Frist; nur die laufende Sitzung hat noch Anfragen.
    await db
      .insertInto('sitzung_katalog')
      .values(
        ['s-laeuft-weiter', 's-vorbei'].map((session_id) => ({
          mandant_id: mandant,
          session_id,
          katalog_projekt_id: katalog.id,
          erstellt: new Date('2025-01-20T10:00:00Z'),
        })),
      )
      .execute();
    await db
      .insertInto('anfrage')
      .values({
        mandant_id: mandant,
        anfrage_key: `req_${randomUUID()}`,
        ts: new Date('2025-02-20T10:00:00Z'),
        tag: '2025-02-20',
        session_id: 's-laeuft-weiter',
        model: 'claude-sonnet-5-5',
        input: 1,
        output: 1,
        cache_read: 0,
        cache_write: 0,
      })
      .execute();
    const sitzungen = async () =>
      (
        await db
          .selectFrom('sitzung_katalog')
          .select('session_id')
          .where('mandant_id', '=', mandant)
          .execute()
      ).map((z) => z.session_id);

    await aufbewahrungJob(ctx, JETZT);
    expect(await sitzungen()).toEqual(['s-laeuft-weiter']);

    // Läuft auch diese Anfrage ab, geht die Zuordnung mit.
    await db
      .updateTable('mandant')
      .set({ aufbewahrung_anfrage_tage: 30 })
      .where('id', '=', mandant)
      .execute();
    await aufbewahrungJob(ctx, JETZT);
    expect(await sitzungen()).toEqual([]);
  });
});
