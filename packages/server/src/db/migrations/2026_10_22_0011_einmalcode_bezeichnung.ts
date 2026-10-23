// Bezeichnung des Rechners schon beim Erzeugen des Einmalcodes (Dashboard „Rechner/Agenten“);
// beim Enrollment wird sie in `rechner.bezeichnung` übernommen. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE einmalcode ADD COLUMN bezeichnung text`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
