// Umzug in den Kern (Entscheidung vom 2026-10-23): Jira je Mandant, bis 2026-10-24 ee-Migration
// `2026_10_23_0006_jira`. Verbindung, Zuordnung seatmeter-Projekt → Jira-Projekt und Zwischenspeicher der
// Issue-Titel. Vollständig idempotent wie Migration 0022. Die Schlüssel je Anfrage und das Monatsaggregat stehen
// in Migration 0020. Nur lesender Zugriff auf Jira, kein Rückschreiben. Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
-- Verbindung je Mandant. token (Cloud: API-Token, Data Center: Personal Access Token) mit AES-256-GCM
-- unter dem Master-Schlüssel, AAD 'mandant_jira.token'; nie in Antworten oder Logs.
-- nur_zugeordnete: Issue-Schlüssel nur für zugeordnete Jira-Projekte speichern (mandant.issue_praefixe).
CREATE TABLE IF NOT EXISTS mandant_jira (
  mandant_id uuid PRIMARY KEY REFERENCES mandant (id) ON DELETE CASCADE,
  basis_url text NOT NULL,
  art text NOT NULL CHECK (art IN ('cloud', 'datacenter')),
  benutzer_email text,
  token bytea NOT NULL,
  aktiv boolean NOT NULL DEFAULT true,
  nur_zugeordnete boolean NOT NULL DEFAULT false,
  zuletzt_geprueft timestamptz,
  fehler text,
  erstellt timestamptz NOT NULL DEFAULT now(),
  geaendert timestamptz NOT NULL DEFAULT now(),
  CHECK (art <> 'cloud' OR benutzer_email IS NOT NULL)
);

-- Zuordnung: ein Jira-Projekt je seatmeter-Projekt (mehrere seatmeter-Projekte dürfen dasselbe Jira-Projekt haben).
CREATE TABLE IF NOT EXISTS projekt_jira (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  projekt_id uuid PRIMARY KEY REFERENCES projekt (id) ON DELETE CASCADE,
  jira_projekt_schluessel text NOT NULL CHECK (jira_projekt_schluessel ~ '^[A-Z][A-Z0-9]+$'),
  jira_projekt_name text,
  geaendert timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projekt_jira_mandant_idx ON projekt_jira (mandant_id, jira_projekt_schluessel);

-- Titel und Status je Issue (24 h gültig); gefunden = false: Jira kennt den Schlüssel nicht (404).
CREATE TABLE IF NOT EXISTS jira_issue_cache (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  schluessel text NOT NULL CHECK (schluessel ~ '^[A-Z][A-Z0-9]+-[0-9]+$'),
  titel text,
  status text,
  gefunden boolean NOT NULL DEFAULT true,
  geholt timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mandant_id, schluessel)
);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, ['mandant_jira', 'projekt_jira', 'jira_issue_cache']);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
