// Phase 5a (ee: SSO je Mandant): Kern-Spalten, die die ee-Anmeldung je Mandant braucht.
//   - `benutzer.oidc_issuer`: Herkunft des OIDC-Subjekts. Jeder Mandant kann einen eigenen Anmeldedienst
//     haben, deshalb ist ein Subjekt nur zusammen mit dem Issuer eindeutig. Bestehende Konten des globalen
//     Anbieters (SEATMETER_OIDC_*) behalten `NULL` und bekommen den Issuer beim nächsten Login.
//   - `benutzer.zuletzt_angemeldet`: Zeitpunkt der letzten neuen Dashboard-Sitzung (Kontenverwaltung).
//   - `mandant.konten_max`: Kontenkontingent je Mandant (nur Plattform-Admin), `NULL` = unbegrenzt.
// Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `ALTER TABLE benutzer
         ADD COLUMN oidc_issuer text,
         ADD COLUMN zuletzt_angemeldet timestamptz;
       ALTER TABLE benutzer DROP CONSTRAINT IF EXISTS benutzer_oidc_sub_key;
       CREATE UNIQUE INDEX benutzer_oidc_subjekt_idx
         ON benutzer (coalesce(oidc_issuer, ''), oidc_sub) WHERE oidc_sub IS NOT NULL;
       ALTER TABLE mandant
         ADD COLUMN konten_max integer CHECK (konten_max BETWEEN 0 AND 100000);`,
    )
    .execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
