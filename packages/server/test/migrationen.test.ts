import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { MANDANTEN_TABELLEN } from '../src/db/migrations/2026_10_22_0001_grundschema.js';
import { MIGRATIONEN } from '../src/db/migrations/index.js';
import { erstelleMigrator, migriere } from '../src/db/migrator.js';
import { anfragePartitionenAnlegen, partitionsName } from '../src/db/partitionen.js';
import { frischeDatenbank } from './db-hilfen.js';

describe('Migrationen', () => {
  let db: Db;

  beforeAll(async () => {
    db = erstelleDb(await frischeDatenbank('seatmeter_test_migration'), 2);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('laufen auf einer leeren Datenbank sauber durch', async () => {
    const ergebnis = await migriere(db);
    expect(ergebnis.results?.map((r) => [r.migrationName, r.status])).toEqual(
      Object.keys(MIGRATIONEN).map((name) => [name, 'Success']),
    );
  });

  it('sind idempotent: ein zweiter Lauf ändert nichts', async () => {
    const ergebnis = await migriere(db);
    expect(ergebnis.results).toEqual([]);
    const offen = (await erstelleMigrator(db).getMigrations()).filter((m) => !m.executedAt);
    expect(offen).toEqual([]);
  });

  it('legen alle Tabellen aus Architektur §3.1 an, RLS auf jeder Mandantentabelle', async () => {
    const zeilen = await sql<{ relname: string; relrowsecurity: boolean }>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'anfrage\\_%'
        AND c.relname NOT LIKE 'kysely%'`.execute(db);
    const rls = new Map(zeilen.rows.map((z) => [z.relname, z.relrowsecurity]));
    for (const t of [...MANDANTEN_TABELLEN, 'mandant', 'preis']) {
      expect(rls.get(t), `RLS auf ${t}`).toBe(true);
    }
    expect(rls.has('benutzer')).toBe(true);
  });

  it('Anwendungsrolle hat kein BYPASSRLS', async () => {
    const r = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'seatmeter_app'`.execute(db);
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it('Partitionen für laufenden und nächsten Monat existieren, Helfer ist idempotent', async () => {
    const jetzt = new Date();
    const naechster = new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() + 1, 1));
    const namen = await anfragePartitionenAnlegen(db);
    expect(namen).toEqual([partitionsName(jetzt), partitionsName(naechster)]);
    await anfragePartitionenAnlegen(db);
    const r = await sql<{ relname: string }>`
      SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'anfrage'::regclass`.execute(db);
    const vorhanden = r.rows.map((z) => z.relname);
    expect(vorhanden).toEqual(expect.arrayContaining(namen));
  });
});
