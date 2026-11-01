// Migration 0031 auf einem Bestand aus Stand 0030: Abgeschlossene Monate behalten ihre Zeilen und haben kein Elternprojekt.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { MIGRATIONEN } from '../src/db/migrations/index.js';
import { migriere } from '../src/db/migrator.js';
import { frischeDatenbank } from './db-hilfen.js';

const LETZTE_ALT = '2026_11_01_0030_katalog_bremse';

describe('Migration Katalog-Abschluss mit Baum', () => {
  let db: Db;

  beforeAll(async () => {
    db = erstelleDb(await frischeDatenbank('seatmeter_test_katalog_summen'), 2);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('übernimmt den Bestand: Zeilen und Pfad bleiben, das Elternprojekt ist leer', async () => {
    const bisher = Object.fromEntries(
      Object.entries(MIGRATIONEN).filter(([name]) => name <= LETZTE_ALT),
    );
    const vorher = await new Migrator({
      db,
      provider: { getMigrations: async () => bisher },
    }).migrateToLatest();
    expect(vorher.error).toBeUndefined();
    const m = randomUUID();
    await sql`INSERT INTO mandant (id, name, slug, plan) VALUES (${m}, 'T', ${`t-${m}`}, 'team')`.execute(
      db,
    );
    await sql`INSERT INTO katalog_abschluss (mandant_id, monat, externe_id, nummer, name, pfad, schatten_usd_micros)
      VALUES (${m}, '2026-09-01', 'k', 'K', 'Kind', 'Eltern › Kind', 5)`.execute(db);

    const r = await migriere(db);
    expect(r.error).toBeUndefined();

    const zeilen = await sql<{
      pfad: string;
      parent_externe_id: string | null;
      schatten_usd_micros: number;
    }>`SELECT pfad, parent_externe_id, schatten_usd_micros FROM katalog_abschluss`.execute(db);
    expect(zeilen.rows).toEqual([
      { pfad: 'Eltern › Kind', parent_externe_id: null, schatten_usd_micros: 5 },
    ]);
  });
});
