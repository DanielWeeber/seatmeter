// Modul projektkatalog: Push aus dem Quellsystem. Die externe ID ist der Schlüssel, die Nummer nur noch Anzeige. Bestand
// wird aus `nummer` übernommen. `parent_externe_id` ohne Fremdschlüssel: Ein Kind darf vor seinem Elternprojekt ankommen.
// Dazu Tokens mit Zweck, Einstellungen und Tageszähler der Synchronisation. Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
ALTER TABLE katalog_projekt
  ADD COLUMN externe_id text,
  ADD COLUMN parent_externe_id text,
  ADD COLUMN status_roh text;
UPDATE katalog_projekt SET externe_id = nummer;
ALTER TABLE katalog_projekt
  ALTER COLUMN externe_id SET NOT NULL,
  ALTER COLUMN nummer DROP NOT NULL,
  ADD CONSTRAINT katalog_projekt_externe_id_laenge CHECK (length(externe_id) BETWEEN 1 AND 200),
  ADD CONSTRAINT katalog_projekt_parent_laenge
    CHECK (parent_externe_id IS NULL OR length(parent_externe_id) <= 200),
  ADD CONSTRAINT katalog_projekt_status_laenge CHECK (status_roh IS NULL OR length(status_roh) <= 100),
  DROP CONSTRAINT katalog_projekt_mandant_id_nummer_key,
  ADD CONSTRAINT katalog_projekt_mandant_externe_id_key UNIQUE (mandant_id, externe_id);

-- Abschluss: Schlüssel und Pfad des Projekts; leer bzw. NULL bleibt „offen“.
ALTER TABLE katalog_abschluss
  ADD COLUMN externe_id text NOT NULL DEFAULT '',
  ADD COLUMN pfad text;
UPDATE katalog_abschluss SET externe_id = nummer;

-- NULL bei inaktiv_status = Standardliste; NULL bei sync_warnung_stunden = Warnung aus.
ALTER TABLE mandant_projektkatalog
  ADD COLUMN inaktiv_status text[],
  ADD COLUMN zuletzt_sync timestamptz,
  ADD COLUMN zuletzt_push timestamptz,
  ADD COLUMN sync_warnung_stunden integer DEFAULT 48 CHECK (sync_warnung_stunden > 0),
  ADD COLUMN sync_deaktivieren_tage integer CHECK (sync_deaktivieren_tage > 0),
  ADD COLUMN sync_deaktivieren_max_prozent integer NOT NULL DEFAULT 25
    CHECK (sync_deaktivieren_max_prozent BETWEEN 1 AND 100),
  ADD COLUMN sync_alarm_seit timestamptz,
  ADD COLUMN sync_bremse_seit timestamptz;

ALTER TABLE katalog_import_token
  ADD COLUMN scope text NOT NULL DEFAULT 'csv_import' CHECK (scope IN ('csv_import', 'katalog_api', 'sync_status'));

-- Tageszähler je Token (UTC-Tag), nie je Anfrage; protokolliert: Audit-Zeile des Tages ist geschrieben.
CREATE TABLE katalog_sync_tag (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  tag date NOT NULL,
  token_id uuid NOT NULL REFERENCES katalog_import_token (id) ON DELETE CASCADE,
  neu bigint NOT NULL DEFAULT 0,
  aktualisiert bigint NOT NULL DEFAULT 0,
  unveraendert bigint NOT NULL DEFAULT 0,
  abgelehnt bigint NOT NULL DEFAULT 0,
  protokolliert boolean NOT NULL DEFAULT false,
  PRIMARY KEY (mandant_id, tag, token_id)
);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, ['katalog_sync_tag']);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
