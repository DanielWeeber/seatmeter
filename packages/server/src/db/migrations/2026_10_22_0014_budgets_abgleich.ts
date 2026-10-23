// Phase 4b: Spalten an Kern-Tabellen für die ee-Module Budgets und Abgleich (die Tabellen stammen aus dem
// Grundschema): Budgets mandantenweit oder je Projekt, Alarm-Zustellung, zweite Personenzuordnung über
// `account_id` (füllt der Kern-Ingest), Analytics-Key-Zeitpunkt, Abgleich-Protokoll. Neue ee-Tabellen
// (Alarmkanäle, Hinweise, Einstellungen) liegen in den ee-Migrationen. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

const SCHEMA = `
-- Budget: projekt_id NULL = mandantenweit (Summe aller Töpfe). Betrag in waehrung bzw. Tokens (basis tokens).
ALTER TABLE budget ALTER COLUMN projekt_id DROP NOT NULL;
ALTER TABLE budget
  ADD COLUMN bezeichnung text,
  ADD COLUMN ausloeser text NOT NULL DEFAULT 'verbrauch' CHECK (ausloeser IN ('verbrauch', 'prognose')),
  ADD COLUMN aktiv boolean NOT NULL DEFAULT true,
  ADD COLUMN geaendert timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT budget_betrag_positiv CHECK (betrag > 0),
  ADD CONSTRAINT budget_waehrung_check CHECK (waehrung IN ('EUR', 'USD')),
  ADD CONSTRAINT budget_schwellen_check CHECK (cardinality(schwellen) BETWEEN 1 AND 10);

-- Alarm: je (budget, periode, schwelle) genau einmal (UNIQUE im Grundschema); Zustellung protokolliert.
ALTER TABLE alarm
  ADD COLUMN prozent numeric(10, 2),
  ADD COLUMN betrag numeric(14, 2),
  ADD COLUMN prognose numeric(14, 2),
  ADD COLUMN zustellung text NOT NULL DEFAULT 'offen'
    CHECK (zustellung IN ('offen', 'zugestellt', 'fehler', 'ohne_kanal')),
  ADD COLUMN zustellversuche integer NOT NULL DEFAULT 0,
  ADD COLUMN zustellfehler text,
  ADD COLUMN zugestellt timestamptz,
  ADD COLUMN quittiert_von uuid REFERENCES benutzer (id) ON DELETE SET NULL;
CREATE INDEX alarm_mandant_idx ON alarm (mandant_id, ausgeloest);

-- Zweite Personenzuordnung: HMAC(person_salt, user.account_id) für den Abgleich mit actor.user_id.
ALTER TABLE person ADD COLUMN key_konto_id bytea;
CREATE UNIQUE INDEX person_key_konto_id_uq ON person (mandant_id, key_konto_id);

ALTER TABLE mandant_geheimnis ADD COLUMN analytics_key_geaendert timestamptz;

ALTER TABLE abgleich_lauf
  ADD COLUMN quelle text NOT NULL DEFAULT 'api' CHECK (quelle IN ('api', 'csv')),
  ADD COLUMN ausloeser text NOT NULL DEFAULT 'plan' CHECK (ausloeser IN ('plan', 'einmal', 'api')),
  ADD COLUMN zeilen integer NOT NULL DEFAULT 0,
  ADD COLUMN fehler text;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
