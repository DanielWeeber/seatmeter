// Modul projektkatalog: Ordner ohne Git-Remote. Der verwaltete Hook meldet für solche Ordner einen Schlüssel
// `local-<Pfad relativ zum Home-Ordner>`; daraus wird ein gewöhnliches `projekt` (url_norm = Schlüssel, Provider `pfad`),
// und diese Tabelle hält, welche Sitzung in welchem Ordner lief. Der Ingest rechnet Anfragen ohne Repo darüber dem
// Projekt zu. Erste Meldung je Sitzung gilt. Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
CREATE TABLE sitzung_ordner (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  session_id text NOT NULL,
  projekt_id uuid NOT NULL REFERENCES projekt (id) ON DELETE CASCADE,
  erstellt timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mandant_id, session_id)
);
CREATE INDEX sitzung_ordner_projekt_idx ON sitzung_ordner (mandant_id, projekt_id);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, ['sitzung_ordner']);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
