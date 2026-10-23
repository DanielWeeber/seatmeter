// Umzug in den Kern (Entscheidung vom 2026-10-23): SCIM 2.0 je Mandant, bis 2026-10-24 ee-Migration
// `2026_10_23_0005_scim`. Bearer-Tokens je Mandant, SCIM-Verknüpfung der Konten (externalId, aktiv im Mandanten),
// Gruppen und Mitgliedschaften. Vollständig idempotent wie Migration 0022; mandantenfrei liest die
// Eigentümer-Verbindung nur Token-Hash → Mandant (Anmeldung der SCIM-Anfrage). `rolle.quelle = 'scim'` erlaubt
// Migration 0021. Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
-- Bearer-Tokens für /scim/v2 (Klartext nur bei der Erzeugung, gespeichert nur SHA-256).
CREATE TABLE IF NOT EXISTS mandant_scim_token (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL UNIQUE,
  praefix text NOT NULL,
  bezeichnung text,
  erstellt timestamptz NOT NULL DEFAULT now(),
  zuletzt_genutzt timestamptz,
  widerrufen timestamptz
);
CREATE INDEX IF NOT EXISTS mandant_scim_token_mandant_idx ON mandant_scim_token (mandant_id);

-- Konten, die der Mandant per SCIM verwaltet. aktiv = false: im Mandanten gesperrt (keine SCIM-Rollen;
-- ohne Rollen in anderen Mandanten zusätzlich benutzer.deaktiviert).
CREATE TABLE IF NOT EXISTS scim_konto (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  benutzer_id uuid NOT NULL REFERENCES benutzer (id) ON DELETE CASCADE,
  external_id text,
  aktiv boolean NOT NULL DEFAULT true,
  erstellt timestamptz NOT NULL DEFAULT now(),
  geaendert timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mandant_id, benutzer_id),
  UNIQUE (mandant_id, external_id)
);

-- SCIM-Gruppen; Rollen kommen aus mandant_oidc.gruppen_rollen (Schlüssel displayName oder externalId).
CREATE TABLE IF NOT EXISTS mandant_scim_gruppe (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  external_id text,
  erstellt timestamptz NOT NULL DEFAULT now(),
  geaendert timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mandant_scim_gruppe_name_idx
  ON mandant_scim_gruppe (mandant_id, lower(display_name));

CREATE TABLE IF NOT EXISTS mandant_scim_mitglied (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  gruppe_id uuid NOT NULL REFERENCES mandant_scim_gruppe (id) ON DELETE CASCADE,
  benutzer_id uuid NOT NULL REFERENCES benutzer (id) ON DELETE CASCADE,
  PRIMARY KEY (gruppe_id, benutzer_id)
);
CREATE INDEX IF NOT EXISTS mandant_scim_mitglied_benutzer_idx
  ON mandant_scim_mitglied (mandant_id, benutzer_id);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, [
    'mandant_scim_token',
    'scim_konto',
    'mandant_scim_gruppe',
    'mandant_scim_mitglied',
  ]);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
