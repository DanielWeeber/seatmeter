// Migration 0030 auf einem Bestand aus Stand 0029: neue Spalten leer, die Zählung des Sendens beginnt beim letzten Push.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { MIGRATIONEN } from '../src/db/migrations/index.js';
import { migriere } from '../src/db/migrator.js';
import { frischeDatenbank } from './db-hilfen.js';

const LETZTE_ALT = '2026_11_01_0029_katalog_push';

describe('Migration Katalog-Bremse', () => {
  let db: Db;

  beforeAll(async () => {
    db = erstelleDb(await frischeDatenbank('seatmeter_test_katalog_bremse'), 2);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('übernimmt den Bestand; ohne bisherigen Push bleibt die Zählung leer', async () => {
    const bisher = Object.fromEntries(
      Object.entries(MIGRATIONEN).filter(([name]) => name <= LETZTE_ALT),
    );
    const vorher = await new Migrator({
      db,
      provider: { getMigrations: async () => bisher },
    }).migrateToLatest();
    expect(vorher.error).toBeUndefined();
    const gesendet = randomUUID();
    const nieGesendet = randomUUID();
    const push = '2026-10-30T08:00:00.000Z';
    for (const m of [gesendet, nieGesendet]) {
      await sql`INSERT INTO mandant (id, name, slug, plan) VALUES (${m}, 'T', ${`t-${m}`}, 'team')`.execute(
        db,
      );
      await sql`INSERT INTO katalog_projekt (mandant_id, externe_id, name, quelle) VALUES (${m}, 'a', 'A', 'api')`.execute(
        db,
      );
    }
    await sql`INSERT INTO mandant_projektkatalog (mandant_id, sync_deaktivieren_tage, zuletzt_push) VALUES (${gesendet}, 7, ${push})`.execute(
      db,
    );
    await sql`INSERT INTO mandant_projektkatalog (mandant_id, sync_deaktivieren_tage) VALUES (${nieGesendet}, 7)`.execute(
      db,
    );

    const r = await migriere(db);
    expect(r.error).toBeUndefined();

    const zeilen = await sql<{ veraltet_seit: Date | null }>`
      SELECT veraltet_seit FROM katalog_projekt`.execute(db);
    expect(zeilen.rows).toEqual([{ veraltet_seit: null }, { veraltet_seit: null }]);
    const stand = await sql<{
      mandant_id: string;
      sync_fenster_ab: Date | null;
      push_aktiv_ab: Date | null;
    }>`SELECT mandant_id, sync_fenster_ab, push_aktiv_ab FROM mandant_projektkatalog`.execute(db);
    const von = (m: string) => stand.rows.find((z) => z.mandant_id === m);
    expect(von(gesendet)?.sync_fenster_ab).toBeNull();
    expect(von(gesendet)?.push_aktiv_ab?.toISOString()).toBe(push);
    expect(von(nieGesendet)?.push_aktiv_ab).toBeNull();

    await sql`DELETE FROM mandant WHERE id IN (${gesendet}, ${nieGesendet})`.execute(db);
    const rest = await sql<{ n: number }>`SELECT count(*)::int AS n FROM katalog_projekt`.execute(
      db,
    );
    expect(rest.rows[0]?.n).toBe(0);
  });
});
