// Umzug in den Kern (Entscheidung vom 2026-10-23): Alarmkanäle, Projekt-Hinweise und
// Hinweis-Schwellen je Mandant, bis 2026-10-24 ee-Migration `2026_10_22_0002_budgets_hinweise`. Vollständig
// idempotent: Auf Installationen mit ee-Plugin gibt es die Tabellen schon (Protokoll `kysely_migration_ee`),
// dann ändert diese Migration nichts; sonst legt sie sie genau so an wie damals die ee-Migration. Der
// Tabellenname `ee_einstellung` bleibt aus Kompatibilität. Nur vorwärts.
import { sql, type Kysely } from 'kysely';
import { mandantenTabellenAbsichern } from '../idempotent.js';

const SCHEMA = `
-- Alarmkanäle je Mandant; Geheimnis (Bearer-Token, SMTP-Passwort, Relay-Token) mit AES-256-GCM,
-- AAD 'alarm_kanal.geheimnis'. konfig enthält nie Geheimnisse.
CREATE TABLE IF NOT EXISTS alarm_kanal (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  typ text NOT NULL CHECK (typ IN ('webhook', 'smtp', 'weeberwrk-relay')),
  bezeichnung text NOT NULL,
  aktiv boolean NOT NULL DEFAULT true,
  konfig jsonb NOT NULL DEFAULT '{}',
  geheimnis bytea,
  erstellt timestamptz NOT NULL DEFAULT now(),
  geaendert timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alarm_kanal_mandant_idx ON alarm_kanal (mandant_id);

-- Projekt-Hinweise je Monat; projekt_id NULL = mandantenweit. Ein Hinweis je (Monat, Projekt, Typ).
CREATE TABLE IF NOT EXISTS hinweis (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  monat date NOT NULL,
  projekt_id uuid REFERENCES projekt (id) ON DELETE CASCADE,
  typ text NOT NULL,
  text text NOT NULL,
  wert numeric(16, 4),
  erstellt timestamptz NOT NULL DEFAULT now(),
  aktualisiert timestamptz NOT NULL DEFAULT now(),
  erledigt timestamptz,
  erledigt_von uuid REFERENCES benutzer (id) ON DELETE SET NULL,
  UNIQUE NULLS NOT DISTINCT (mandant_id, monat, projekt_id, typ)
);

-- Hinweis-Schwellen je Mandant (Name aus der ee-Zeit).
CREATE TABLE IF NOT EXISTS ee_einstellung (
  mandant_id uuid PRIMARY KEY REFERENCES mandant (id) ON DELETE CASCADE,
  hinweise jsonb NOT NULL DEFAULT '{}',
  geaendert timestamptz NOT NULL DEFAULT now()
);
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await mandantenTabellenAbsichern(db, ['alarm_kanal', 'hinweis', 'ee_einstellung']);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
