// Modul projektkatalog: Der Stand eines abgeschlossenen Monats friert auch die Hierarchie ein. `pfad` gibt es seit 0029, dazu
// kommt das aufgelöste Elternprojekt (externe ID). Vorher abgeschlossene Monate haben keins und zeigen flach. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

const SCHEMA = `
ALTER TABLE katalog_abschluss ADD COLUMN parent_externe_id text;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
