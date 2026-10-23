// Phase 4a (ee: OIDC): Dashboard-Sitzungen aus einer OIDC-Anmeldung (`quelle = 'oidc'`) und Herkunft einer
// Rollen-Zuordnung (`rolle.quelle`): `oidc` = aus der Gruppen-Zuordnung beim Login, wird beim nächsten Login
// ohne passende Gruppe wieder entzogen; `manuell` (Standard) = im Dashboard oder per CLI vergeben, bleibt.
// Die Tabellen gehören zum Kern, weil Sitzungen und Rollen Kern sind; die OIDC-Anmeldung selbst ist ee. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `ALTER TABLE benutzer_sitzung DROP CONSTRAINT IF EXISTS benutzer_sitzung_quelle_check;
       ALTER TABLE benutzer_sitzung ADD CONSTRAINT benutzer_sitzung_quelle_check
         CHECK (quelle IN ('lokal', 'remote_user', 'oidc'));
       ALTER TABLE rolle ADD COLUMN quelle text NOT NULL DEFAULT 'manuell'
         CHECK (quelle IN ('manuell', 'oidc'));`,
    )
    .execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
