// Aktualisierungsweg des Kerns ohne ee (Umzug der ee-Tabellen in den Kern, Entscheidung vom 2026-10-23):
// Eine Installation im Stand vor 2026-10-24 (Kern-Migrationen bis 0021, nie ein ee-Plugin) bekommt durch die
// neuen Kern-Migrationen dieselben Tabellen wie eine frische Installation. Den Weg mit ee-Plugin (Tabellen
// schon aus den ee-Migrationen) prüft ee/server/test/migration-umzug.test.ts.
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { MIGRATIONEN } from '../src/db/migrations/index.js';
import { migriere } from '../src/db/migrator.js';
import { frischeDatenbank, schemaAbbild } from './db-hilfen.js';

/** Letzte Kern-Migration vor dem Umzug. */
const LETZTE_ALT = '2026_10_23_0021_rolle_quelle_scim';

/** Seit 2026-10-24 im Kern angelegte Tabellen (vorher ee-Migrationen). */
const UMGEZOGENE_TABELLEN = [
  'alarm_kanal',
  'hinweis',
  'ee_einstellung',
  'mandant_oidc',
  'mandant_domain',
  'konto_einladung',
  'mandant_scim_token',
  'scim_konto',
  'mandant_scim_gruppe',
  'mandant_scim_mitglied',
] as const;

describe('Kern-Migrationen: Aktualisierung ohne ee', () => {
  let alt: Db;
  let altUrl: string;
  let frischUrl: string;

  beforeAll(async () => {
    altUrl = await frischeDatenbank('seatmeter_test_umzug_kern');
    frischUrl = await frischeDatenbank('seatmeter_test_umzug_kern_frisch');
    alt = erstelleDb(altUrl, 2);
  });
  afterAll(async () => {
    await alt?.destroy();
  });

  it('Stand vor 2026-10-24 → neue Kern-Migrationen legen die umgezogenen Tabellen an', async () => {
    const bisher = Object.fromEntries(
      Object.entries(MIGRATIONEN).filter(([name]) => name <= LETZTE_ALT),
    );
    const vorher = await new Migrator({
      db: alt,
      provider: { getMigrations: async () => bisher },
    }).migrateToLatest();
    expect(vorher.error).toBeUndefined();
    const vorhanden = await sql<{ n: string }>`
      SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`.execute(alt);
    for (const t of UMGEZOGENE_TABELLEN) expect(vorhanden.rows.map((r) => r.n)).not.toContain(t);

    const ergebnis = await migriere(alt);
    expect(ergebnis.results?.every((r) => r.status === 'Success')).toBe(true);
    expect(ergebnis.results?.map((r) => r.migrationName)).toEqual(
      Object.keys(MIGRATIONEN).filter((name) => name > LETZTE_ALT),
    );
  });

  it('ergibt dasselbe Schema wie eine frische Installation (RLS, Richtlinien, Rechte)', async () => {
    const frisch = erstelleDb(frischUrl, 2);
    try {
      await migriere(frisch);
    } finally {
      await frisch.destroy();
    }
    const a = await schemaAbbild(altUrl);
    const b = await schemaAbbild(frischUrl);
    expect(a).toEqual(b);
    for (const t of UMGEZOGENE_TABELLEN) {
      expect(a).toContain(`tabelle ${t} art=r rls=true force=false`);
      expect(a.some((z) => z.startsWith(`policy ${t}.mandant_trennung `))).toBe(true);
    }
  });
});
