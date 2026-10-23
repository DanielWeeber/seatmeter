// Sitztypen max5/max20 (Entscheidung Daniel 2026-10-22): Migration 0017 benennt den
// Platzhalter `max` in `max20` um, jeder Mandant hat die Standardpreise (Trigger beim Anlegen), die
// Kalkulation rechnet beide Typen.
//
// Golden-Datensatz (Monat 2026-09, Verteilung „person“, code_anteil_sitz 1,0, Schattenfaktor 1,0):
//   P5 (Max 5x, 100 $):  x 50 $          P20 (Max 20x, 200 $): x 150 $, y 50 $
//   person: x = 50 + 150 + 100·50/50 + 200·150/200 = 200 + 100 + 150 = 450,00 $
//           y = 50 + 200·50/200 = 100,00 $;  Σ Sitzkosten 300 $, kein „ungenutzt“
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  kalkulationAntwortSchema,
  SITZ_STANDARDKOSTEN,
  sitzkostenAntwortSchema,
  SITZ_TYPEN,
} from '@seatmeter/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { erstelleApp } from '../src/app.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { erstelleMigrator, migriere } from '../src/db/migrator.js';
import {
  legeMandantAn,
  legePersonAn,
  legeProjektAn,
  meldeAn,
  testKonfiguration,
  type TestSitzung,
} from './api-hilfen.js';
import { frischeDatenbank } from './db-hilfen.js';

const M = 1_000_000;

describe('Migration 0017: max → max20, Standardpreise max5/max20', () => {
  let db: Db;

  beforeAll(async () => {
    db = erstelleDb(await frischeDatenbank('seatmeter_test_sitztypen'), 2);
    const bis = await erstelleMigrator(db).migrateTo('2026_10_22_0016_speed_normal');
    expect(bis.error).toBeUndefined();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('benennt vorhandene max-Sitze und -Preise um und ergänzt nur fehlende Standardpreise', async () => {
    const mandant = randomUUID();
    await db.insertInto('mandant').values({ id: mandant, name: 'Pilot', slug: 'pilot' }).execute();
    const person = await legePersonAn(db, mandant);
    // Alte Werte direkt per SQL (der Typ `max` ist im TypeScript-Schema nicht mehr erlaubt).
    await sql`INSERT INTO sitzkosten (mandant_id, sitz_typ, gueltig_ab, preis_monat, abrechnung)
      VALUES (${mandant}, 'max', '2026-10-01', 200, 'monatlich')`.execute(db);
    await sql`INSERT INTO person_sitz (mandant_id, person_id, gueltig_ab, sitz_typ)
      VALUES (${mandant}, ${person}, '2026-10-01', 'max')`.execute(db);

    await migriere(db);

    const sitz = await db.selectFrom('person_sitz').select(['sitz_typ', 'gueltig_ab']).execute();
    expect(sitz).toEqual([{ sitz_typ: 'max20', gueltig_ab: '2026-10-01' }]);
    const kosten = await db
      .selectFrom('sitzkosten')
      .select(['sitz_typ', 'gueltig_ab', 'preis_monat', 'waehrung', 'abrechnung'])
      .where('mandant_id', '=', mandant)
      .orderBy('sitz_typ')
      .execute();
    expect(kosten.map((k) => ({ ...k, preis_monat: Number(k.preis_monat) }))).toEqual([
      // Umbenannter Pilot-Preis bleibt (200 $ ab 2026-10-01), kein zweiter max20-Standardpreis.
      {
        sitz_typ: 'max20',
        gueltig_ab: '2026-10-01',
        preis_monat: 200,
        waehrung: 'USD',
        abrechnung: 'monatlich',
      },
      {
        sitz_typ: 'max5',
        gueltig_ab: '2025-01-01',
        preis_monat: 100,
        waehrung: 'USD',
        abrechnung: 'monatlich',
      },
    ]);
    // `max` ist nicht mehr erlaubt.
    await expect(
      db
        .insertInto('person_sitz')
        .values({
          mandant_id: mandant,
          person_id: person,
          gueltig_ab: '2026-11-01',
          sitz_typ: 'max' as never,
        })
        .execute(),
    ).rejects.toThrow(/person_sitz_sitz_typ_check/);
  });
});

describe('Sitztypen über die API: Standardpreise und Golden-Test', () => {
  let db: Db;
  let app: FastifyInstance;
  const konfiguration = testKonfiguration(inject('testDatenbankUrl'));
  let mandant: string;
  let admin: TestSitzung;
  let x: string;
  let y: string;

  beforeAll(async () => {
    db = erstelleDb(konfiguration.DATABASE_URL, 4);
    app = await erstelleApp({ konfiguration, db });
    mandant = await legeMandantAn(db);
    admin = await meldeAn(db, mandant, 'mandanten_admin');
    x = await legeProjektAn(db, mandant, 'x-max');
    y = await legeProjektAn(db, mandant, 'y-max');
    const p5 = await legePersonAn(db, mandant);
    const p20 = await legePersonAn(db, mandant);
    const posten: [string, string, number][] = [
      [p5, x, 50],
      [p20, x, 150],
      [p20, y, 50],
    ];
    await db
      .insertInto('tag_aggregat')
      .values(
        posten.map(([person, projekt, usd]) => ({
          mandant_id: mandant,
          tag: '2026-09-15',
          person_id: person,
          projekt_id: projekt,
          model: 'claude-opus-5-5',
          auth_klasse: 'abo' as const,
          input: 100,
          output: 10,
          cache_read: 0,
          cache_write: 0,
          cache_write_1h: 0,
          anfragen: 1,
          schatten_usd_micros: usd * M,
          preis_version: 'global:claude-opus-5-5@2026-01-01',
        })),
      )
      .execute();
    for (const [p, typ] of [
      [p5, 'max5'],
      [p20, 'max20'],
    ] as const) {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/v1/personen/${p}/sitz`,
        headers: admin.headers,
        payload: { sitz_typ: typ, gueltig_ab: '2026-09-01' },
      });
      expect(r.statusCode).toBe(200);
    }
  });
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it('kennt genau die Sitztypen standard, premium, enterprise, max5, max20', () => {
    expect(SITZ_TYPEN).toEqual(['standard', 'premium', 'enterprise', 'max5', 'max20']);
  });

  it('neuer Mandant hat die Standardpreise aus shared (Trigger der Migration 0017)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/sitzkosten',
      headers: admin.headers,
    });
    const zeilen = sitzkostenAntwortSchema.parse(r.json()).zeilen;
    expect(zeilen).toHaveLength(SITZ_STANDARDKOSTEN.length);
    expect(zeilen).toEqual(expect.arrayContaining([...SITZ_STANDARDKOSTEN]));
  });

  it('Golden-Test: Max 5x und Max 20x verteilen 300 $ Sitzkosten nach Nutzung (person)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/kalkulation?monat=2026-09',
      headers: admin.headers,
    });
    expect(r.statusCode).toBe(200);
    const k = kalkulationAntwortSchema.parse(r.json());
    expect(k.einstellungen.sitzkosten_verteilung).toBe('person');
    expect(k.sitzkosten_usd_micros).toBe(300 * M);
    const zeile = (id: string) => k.zeilen.find((z) => z.projekt_id === id);
    expect(zeile(x)).toMatchObject({
      schatten_usd_micros: 200 * M,
      sitzanteil_usd_micros: 250 * M,
      projektpreis_usd_cent: 45_000,
    });
    expect(zeile(y)).toMatchObject({
      schatten_usd_micros: 50 * M,
      sitzanteil_usd_micros: 50 * M,
      projektpreis_usd_cent: 10_000,
    });
    expect(k.zeilen.some((z) => z.topf === 'ungenutzt')).toBe(false);
    expect(k.hinweise.some((h) => h.includes('ohne Sitzkosten'))).toBe(false);
  });
});
