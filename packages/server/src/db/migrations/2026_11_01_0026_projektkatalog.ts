// Modul projektkatalog: Projektliste je Mandant, Zuordnung Repo → Katalog-Projekt und Sitzung ohne Repo →
// Katalog-Projekt, Stand beim Monatsabschluss, Schalter für die erzwungene Projektwahl. Die Nutzungsdaten
// bleiben unverändert; die Zuordnung liegt getrennt und ist deshalb korrigierbar und rückwirkend.
// Neue Rolle `entwickler` (nur Projektwahl, keine Auswertung). Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
ALTER TABLE rolle DROP CONSTRAINT IF EXISTS rolle_rolle_check;
ALTER TABLE rolle ADD CONSTRAINT rolle_rolle_check
  CHECK (rolle IN ('mandanten_admin', 'projektleiter', 'controller', 'betriebsrat', 'entwickler'));

-- Einstellungen je Mandant; ohne Zeile gilt: nicht erzwungen, noch kein Import.
CREATE TABLE mandant_projektkatalog (
  mandant_id uuid PRIMARY KEY REFERENCES mandant (id) ON DELETE CASCADE,
  erzwingen boolean NOT NULL DEFAULT false,
  zuletzt_import timestamptz,
  import_quelle text,
  geaendert timestamptz NOT NULL DEFAULT now()
);

-- Projekte aus der Quelle. Fehlt ein Projekt im nächsten vollständigen Import, wird es inaktiv, nie gelöscht:
-- Zuordnungen und Abschlüsse dürfen darauf zeigen.
CREATE TABLE katalog_projekt (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  nummer text NOT NULL CHECK (length(nummer) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  kunde text CHECK (kunde IS NULL OR length(kunde) <= 300),
  aktiv boolean NOT NULL DEFAULT true,
  quelle text NOT NULL,
  zuletzt_gesehen timestamptz NOT NULL DEFAULT now(),
  erstellt timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandant_id, nummer)
);

-- Ein Katalog-Projekt je seatmeter-Projekt (Repo); mehrere Repos dürfen dasselbe Katalog-Projekt haben.
CREATE TABLE projekt_katalog (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  projekt_id uuid PRIMARY KEY REFERENCES projekt (id) ON DELETE CASCADE,
  katalog_projekt_id uuid NOT NULL REFERENCES katalog_projekt (id),
  geaendert timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projekt_katalog_ziel_idx ON projekt_katalog (mandant_id, katalog_projekt_id);

-- Ordner ohne Repo: Wahl gilt nur für diese Sitzung; Nutzung wird über anfrage.session_id zugerechnet.
CREATE TABLE sitzung_katalog (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  session_id text NOT NULL,
  katalog_projekt_id uuid NOT NULL REFERENCES katalog_projekt (id),
  erstellt timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mandant_id, session_id)
);

-- Stand der Kosten beim Monatsabschluss je Katalog-Projekt und Repo; projekt_id NULL = Sitzungen ohne Repo.
-- Name und Kunde als Kopie: spätere Importe und Korrekturen ändern einen abgeschlossenen Monat nicht.
CREATE TABLE katalog_abschluss (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  monat date NOT NULL,
  nummer text NOT NULL,
  name text NOT NULL,
  kunde text,
  projekt_id uuid,
  projekt_name text,
  sitzungen integer NOT NULL DEFAULT 0,
  input bigint NOT NULL DEFAULT 0,
  output bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  cache_write_1h bigint NOT NULL DEFAULT 0,
  web_search bigint NOT NULL DEFAULT 0,
  anfragen bigint NOT NULL DEFAULT 0,
  schatten_usd_micros bigint NOT NULL DEFAULT 0
);
CREATE INDEX katalog_abschluss_monat_idx ON katalog_abschluss (mandant_id, monat);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, [
    'mandant_projektkatalog',
    'katalog_projekt',
    'projekt_katalog',
    'sitzung_katalog',
    'katalog_abschluss',
  ]);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
