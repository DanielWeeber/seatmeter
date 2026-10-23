// Umzug in den Kern (Entscheidung vom 2026-10-23): OIDC-Konfiguration, E-Mail-Domains und Einladungen je
// Mandant, bis 2026-10-24 ee-Migration `2026_10_23_0004_sso_je_mandant`. Vollständig idempotent: Mit früherem
// ee-Plugin gibt es die Tabellen schon, dann ändert diese Migration nichts; sonst legt sie sie genau so an wie
// damals die ee-Migration. Mandantenfrei gelesen (Eigentümer-Verbindung, nur die Zuordnung) werden nur:
// Domain → Mandant (Anmeldeseite), aktive Konfigurationen (Abgleich des globalen Anbieters) und
// Einladungs-Token → Konto (Annahme ohne Anmeldung). Spalten an Kern-Tabellen stehen in Migration 0019.
// Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
-- Anmeldedienst je Mandant. client_secret mit AES-256-GCM unter dem Master-Schlüssel,
-- AAD 'mandant_oidc.client_secret'. gruppen_rollen: { "<gruppe>": ["<rolle>", …] }.
CREATE TABLE IF NOT EXISTS mandant_oidc (
  mandant_id uuid PRIMARY KEY REFERENCES mandant (id) ON DELETE CASCADE,
  issuer text NOT NULL,
  client_id text NOT NULL,
  client_secret bytea NOT NULL,
  scopes text NOT NULL DEFAULT 'openid profile email groups',
  bezeichnung text NOT NULL,
  gruppen_rollen jsonb NOT NULL DEFAULT '{}',
  aktiv boolean NOT NULL DEFAULT true,
  erstellt timestamptz NOT NULL DEFAULT now(),
  geaendert timestamptz NOT NULL DEFAULT now(),
  zuletzt_geprueft timestamptz
);

-- Verifizierte E-Mail-Domains: serverweit eindeutig (Primärschlüssel), klein und in IDNA-Form (Punycode).
CREATE TABLE IF NOT EXISTS mandant_domain (
  domain text PRIMARY KEY CHECK (domain = lower(domain)),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  verifiziert boolean NOT NULL DEFAULT false,
  verifizierungs_token text NOT NULL,
  verifiziert_am timestamptz,
  quelle text CHECK (quelle IN ('dns', 'plattform_admin')),
  erstellt timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mandant_domain_mandant_idx ON mandant_domain (mandant_id);

-- Einladungen (Konto ohne Passwort, bis der Link angenommen ist). Token nur als SHA-256.
CREATE TABLE IF NOT EXISTS konto_einladung (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  benutzer_id uuid NOT NULL REFERENCES benutzer (id) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL UNIQUE,
  laeuft_ab timestamptz NOT NULL,
  erstellt timestamptz NOT NULL DEFAULT now(),
  erstellt_von uuid REFERENCES benutzer (id) ON DELETE SET NULL,
  PRIMARY KEY (mandant_id, benutzer_id)
);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, ['mandant_oidc', 'mandant_domain', 'konto_einladung']);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
