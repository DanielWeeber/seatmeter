// Migration der Projektwahl: Der frühere Schalter `erzwingen` wird zur Stufe, „an“ bleibt wirksam als `blockieren`.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { MIGRATIONEN } from '../src/db/migrations/index.js';
import { migriere } from '../src/db/migrator.js';
import { frischeDatenbank } from './db-hilfen.js';

const LETZTE_ALT = '2026_11_01_0027_katalog_import_token';

describe('Migration Stufe der Projektwahl', () => {
  let db: Db;
  beforeAll(async () => {
    db = erstelleDb(await frischeDatenbank('seatmeter_test_stufe'), 2);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('an → blockieren, aus → aus; die alte Spalte ist weg', async () => {
    const bisher = Object.fromEntries(
      Object.entries(MIGRATIONEN).filter(([name]) => name <= LETZTE_ALT),
    );
    const vorher = await new Migrator({
      db,
      provider: { getMigrations: async () => bisher },
    }).migrateToLatest();
    expect(vorher.error).toBeUndefined();
    const an = randomUUID();
    const aus = randomUUID();
    for (const [id, wert] of [
      [an, true],
      [aus, false],
    ] as const) {
      await sql`INSERT INTO mandant (id, name, slug, plan) VALUES (${id}, 'T', ${`t-${id}`}, 'team')`.execute(
        db,
      );
      await sql`INSERT INTO mandant_projektkatalog (mandant_id, erzwingen) VALUES (${id}, ${wert})`.execute(
        db,
      );
    }
    const ergebnis = await migriere(db);
    expect(ergebnis.results?.every((r) => r.status === 'Success')).toBe(true);
    const z = await sql<{ mandant_id: string; stufe: string }>`
      SELECT mandant_id, stufe FROM mandant_projektkatalog`.execute(db);
    expect(Object.fromEntries(z.rows.map((r) => [r.mandant_id, r.stufe]))).toEqual({
      [an]: 'blockieren',
      [aus]: 'aus',
    });
    const spalten = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'mandant_projektkatalog'`.execute(
      db,
    );
    expect(spalten.rows.map((s) => s.column_name)).not.toContain('erzwingen');
    await expect(
      sql`UPDATE mandant_projektkatalog SET stufe = 'vielleicht'`.execute(db),
    ).rejects.toThrow();
  });
});
