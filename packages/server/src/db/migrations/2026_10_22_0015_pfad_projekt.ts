// Pfad-Projekte (Agent-Option `pfad_projekte`, Phase 5): `projekt.provider = 'pfad'` für Sitzungen ohne
// Git-Remote unter einem konfigurierten Pfad; `url_norm` bleibt NULL, `anzeigename` = Bezeichnung.
// Der Name der CHECK-Bedingung stammt von Postgres (`<tabelle>_<spalte>_check`). Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE projekt DROP CONSTRAINT IF EXISTS projekt_provider_check`.execute(db);
  await sql`ALTER TABLE projekt ADD CONSTRAINT projekt_provider_check
    CHECK (provider IN ('github', 'gitlab', 'gitea', 'unknown', 'pfad'))`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
