// Migration des Katalog-Push: Die externe ID kommt aus der Nummer, die Nummer wird optional und darf sich wiederholen.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { MIGRATIONEN } from '../src/db/migrations/index.js';
import { migriere } from '../src/db/migrator.js';
import { frischeDatenbank } from './db-hilfen.js';

const LETZTE_ALT = '2026_11_01_0028_projektwahl_stufe';

describe('Migration Katalog-Push', () => {
  let db: Db;
  beforeAll(async () => {
    db = erstelleDb(await frischeDatenbank('seatmeter_test_katalog_push'), 2);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('übernimmt den Bestand, Zuordnungen bleiben gültig, Nummern dürfen sich wiederholen', async () => {
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
    await sql`INSERT INTO katalog_projekt (mandant_id, nummer, name, quelle) VALUES (${m}, 'P-1', 'Eins', 'csv')`.execute(
      db,
    );
    await sql`INSERT INTO katalog_abschluss (mandant_id, monat, nummer, name) VALUES (${m}, '2026-09-01', 'P-1', 'Eins')`.execute(
      db,
    );
    await sql`INSERT INTO katalog_import_token (mandant_id, token_sha256, praefix, bezeichnung)
      VALUES (${m}, decode(md5(${m}), 'hex'), 'smk_x', 'Alt')`.execute(db);

    const ergebnis = await migriere(db);
    expect(ergebnis.results?.every((r) => r.status === 'Success')).toBe(true);

    const z = await sql<{ externe_id: string; nummer: string }>`
      SELECT externe_id, nummer FROM katalog_projekt`.execute(db);
    expect(z.rows).toEqual([{ externe_id: 'P-1', nummer: 'P-1' }]);
    const a = await sql<{ externe_id: string }>`SELECT externe_id FROM katalog_abschluss`.execute(
      db,
    );
    expect(a.rows).toEqual([{ externe_id: 'P-1' }]);
    const t = await sql<{ scope: string }>`SELECT scope FROM katalog_import_token`.execute(db);
    expect(t.rows).toEqual([{ scope: 'csv_import' }]);

    // Gleiche Nummer unter anderer ID geht, gleiche ID nicht, Nummer darf fehlen.
    await sql`INSERT INTO katalog_projekt (mandant_id, externe_id, nummer, name, quelle)
      VALUES (${m}, 'x-2', 'P-1', 'Zwei', 'api')`.execute(db);
    await sql`INSERT INTO katalog_projekt (mandant_id, externe_id, name, quelle)
      VALUES (${m}, 'x-3', 'Drei', 'api')`.execute(db);
    await expect(
      sql`INSERT INTO katalog_projekt (mandant_id, externe_id, name, quelle)
        VALUES (${m}, 'x-3', 'Doppelt', 'api')`.execute(db),
    ).rejects.toThrow();
  });
});
