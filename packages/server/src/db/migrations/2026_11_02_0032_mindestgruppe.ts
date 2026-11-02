// Modul mandant: Mindestgruppe je Mandant einstellbar (bisher Konstante 3, Architektur §7). Gilt nur in Auswertungsstufe 1:
// Pseudonyme erscheinen erst, wenn mindestens so viele Personen im Ausweis stehen. Bestehende Mandanten behalten 3. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

const SCHEMA = `
ALTER TABLE mandant ADD COLUMN mindestgruppe integer NOT NULL DEFAULT 3
  CONSTRAINT mandant_mindestgruppe_bereich CHECK (mindestgruppe BETWEEN 1 AND 10);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
