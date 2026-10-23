// Phase 5b (ee: SCIM 2.0 je Mandant): Rollen aus SCIM-Gruppen tragen `rolle.quelle = 'scim'`
// und werden beim Abgleich der Gruppenmitgliedschaften wieder entzogen; manuell und per OIDC vergebene Rollen
// bleiben davon unberührt. Die Tabellen für Tokens, Konten und Gruppen stehen in der ee-Migration 0005.
// Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `ALTER TABLE rolle DROP CONSTRAINT IF EXISTS rolle_quelle_check;
       ALTER TABLE rolle ADD CONSTRAINT rolle_quelle_check
         CHECK (quelle IN ('manuell', 'oidc', 'scim'));`,
    )
    .execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
