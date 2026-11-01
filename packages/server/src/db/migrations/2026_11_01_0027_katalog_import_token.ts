// Modul projektkatalog: eigene Tokens für geplante Katalog-Importe. Bewusst getrennt von `ingest_token`: Das
// Mandanten-Token können alle Beschäftigten lesen und darf den Katalog deshalb nie schreiben. Diese Tokens
// gelten nur für die Upload-Route; gespeichert wird nur der SHA-256. Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
CREATE TABLE katalog_import_token (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL UNIQUE,
  praefix text NOT NULL,
  bezeichnung text NOT NULL CHECK (length(bezeichnung) BETWEEN 1 AND 100),
  erstellt timestamptz NOT NULL DEFAULT now(),
  zuletzt_genutzt timestamptz,
  widerrufen timestamptz
);
CREATE INDEX katalog_import_token_mandant_idx ON katalog_import_token (mandant_id);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, ['katalog_import_token']);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
