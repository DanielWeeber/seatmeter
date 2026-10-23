// Issue-Schlüssel aus Branch-Namen (Architektur Phase 5c). Gespeichert wird nur der
// Schlüssel (`ABC-123`), nie der Branch-Name:
// - `anfrage.issue_schluessel`: Schlüssel je Anfrage (Quelle B je Transkriptzeile, Quelle A vom
//   Start-Wrapper beim Sitzungsstart); NULL = unbekannt, leeres Array = Branch ohne Schlüssel.
// - `mandant.issue_praefixe`: Positivliste der Projektschlüssel (pflegt ee aus der Jira-Zuordnung);
//   NULL = alle erkannten Schlüssel.
// - `issue_aggregat`: Monatssummen je (Projekt, Schlüssel), nur Abo-Nutzung, Tokens und Schattenpreis
//   einer Anfrage gleichmäßig auf ihre Schlüssel verteilt; aufgebaut vom Aggregationsjob.
// Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { APP_ROLLE } from '../konstanten.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE anfrage ADD COLUMN issue_schluessel text[]`.execute(db);
  await sql`ALTER TABLE mandant ADD COLUMN issue_praefixe text[]`.execute(db);
  await sql
    .raw(
      `
CREATE TABLE issue_aggregat (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  monat date NOT NULL CHECK (extract(day FROM monat) = 1),
  projekt_id uuid REFERENCES projekt (id) ON DELETE CASCADE,
  schluessel text NOT NULL CHECK (schluessel ~ '^[A-Z][A-Z0-9]+-[0-9]+$'),
  sitzungen integer NOT NULL DEFAULT 0,
  anfragen integer NOT NULL DEFAULT 0,
  input bigint NOT NULL DEFAULT 0,
  output bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  cache_write_1h bigint NOT NULL DEFAULT 0,
  web_search integer NOT NULL DEFAULT 0,
  schatten_usd_micros bigint NOT NULL DEFAULT 0,
  aktualisiert timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (mandant_id, monat, projekt_id, schluessel)
);
CREATE INDEX issue_aggregat_schluessel_idx ON issue_aggregat (mandant_id, monat, schluessel);
ALTER TABLE issue_aggregat ENABLE ROW LEVEL SECURITY;
CREATE POLICY mandant_trennung ON issue_aggregat
  USING (mandant_id = app_mandant_id()) WITH CHECK (mandant_id = app_mandant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON issue_aggregat TO ${APP_ROLLE};
`,
    )
    .execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
