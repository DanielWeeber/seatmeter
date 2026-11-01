// Modul projektkatalog: Die Bremse zählt über einen Zeitraum, nicht je Lauf. `veraltet_seit` merkt, wann der Job ein Projekt
// wegen Alters deaktiviert hat, und wird leer, sobald es wieder gesendet wird. `sync_fenster_ab`: Eine geänderte Grenze
// beginnt den Zeitraum neu, damit „Grenze einmal erhöhen“ ein Ausweg ist. `push_aktiv_ab`: seit wann die Quelle ohne
// Unterbrechung sendet; ein Ausfall zählt so nie als Alter der Projekte. Der Bestand beginnt beim letzten Push: Das
// Deaktivieren wartet nach dem Einspielen einmal die eingestellten Tage ab. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

const SCHEMA = `
ALTER TABLE katalog_projekt ADD COLUMN veraltet_seit timestamptz;
ALTER TABLE mandant_projektkatalog
  ADD COLUMN sync_fenster_ab timestamptz,
  ADD COLUMN push_aktiv_ab timestamptz;
UPDATE mandant_projektkatalog SET push_aktiv_ab = zuletzt_push WHERE zuletzt_push IS NOT NULL;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
