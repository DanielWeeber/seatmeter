// Grundschema laut Architektur §3.1 inklusive ee-Tabellen, Partitionierung von `anfrage`,
// Row-Level-Security je Mandant und der Anwendungsrolle ohne BYPASSRLS.
// Neue Migrationen bekommen eigene Dateien (Name `JJJJ_MM_TT_NNNN_thema.ts`, nur vorwärts).
import { sql, type Kysely } from 'kysely';
import { APP_ROLLE } from '../konstanten.js';
import { anfragePartitionenAnlegen, monatsanfang } from '../partitionen.js';

/** Tabellen mit Spalte `mandant_id` und Standard-Policy (lesen und schreiben nur im eigenen Mandanten). */
export const MANDANTEN_TABELLEN = [
  'mandant_geheimnis',
  'anthropic_org',
  'ingest_token',
  'einmalcode',
  'person',
  'rechner',
  'person_klar',
  'person_sitz',
  'sitzkosten',
  'projekt',
  'projekt_alias',
  'sitzung',
  'anfrage',
  'otel_kontrollsumme',
  'tag_aggregat',
  'monatsabschluss',
  'kurs',
  'ueberschreitung',
  'abgleich_lauf',
  'budget',
  'alarm',
  'rolle',
  'audit',
  'ingest_statistik',
  'loeschlauf',
] as const;

const SCHEMA = `
CREATE OR REPLACE FUNCTION app_mandant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.mandant_id', true), '')::uuid $$;

CREATE TABLE mandant (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'team' CHECK (plan IN ('team', 'enterprise', 'max_pilot')),
  abrechnungsmodell text NOT NULL DEFAULT 'kontingent'
    CHECK (abrechnungsmodell IN ('kontingent', 'nutzungsbasiert')),
  auswertungsstufe smallint NOT NULL DEFAULT 1 CHECK (auswertungsstufe BETWEEN 0 AND 3),
  klarnamen_aktiv boolean NOT NULL DEFAULT false,
  zeitzone text NOT NULL DEFAULT 'Europe/Berlin',
  waehrung text NOT NULL DEFAULT 'EUR',
  sitzkosten_verteilung text NOT NULL DEFAULT 'person'
    CHECK (sitzkosten_verteilung IN ('person', 'gleich', 'pool')),
  code_anteil_sitz numeric(6, 4) NOT NULL DEFAULT 1.0,
  schatten_faktor numeric(6, 4) NOT NULL DEFAULT 1.0,
  cache_write_annahme text NOT NULL DEFAULT '1h' CHECK (cache_write_annahme IN ('5m', '1h')),
  aufbewahrung_anfrage_tage integer NOT NULL DEFAULT 90,
  aufbewahrung_aggregat_monate integer NOT NULL DEFAULT 13,
  aufbewahrung_abschluss_monate integer NOT NULL DEFAULT 24,
  aufbewahrung_kontrollsumme_tage integer NOT NULL DEFAULT 30,
  aufbewahrung_statistik_monate integer NOT NULL DEFAULT 13,
  aufbewahrung_audit_monate integer NOT NULL DEFAULT 24,
  erstellt timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mandant_geheimnis (
  mandant_id uuid PRIMARY KEY REFERENCES mandant (id) ON DELETE CASCADE,
  person_salt bytea NOT NULL,
  projekt_salt bytea NOT NULL,
  analytics_key bytea,
  erstellt timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE anthropic_org (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  org_uuid uuid NOT NULL,
  bezeichnung text,
  plan text,
  gueltig_ab date NOT NULL DEFAULT current_date,
  PRIMARY KEY (mandant_id, org_uuid)
);

CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  pseudonym text NOT NULL,
  key_konto bytea,
  key_email bytea,
  erste_nutzung date,
  letzte_nutzung date,
  UNIQUE (mandant_id, key_konto),
  UNIQUE (mandant_id, key_email),
  UNIQUE (mandant_id, pseudonym)
);

CREATE TABLE rechner (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  person_id uuid REFERENCES person (id) ON DELETE SET NULL,
  bezeichnung text,
  os text CHECK (os IN ('macos', 'linux', 'windows')),
  agent_version text,
  registriert timestamptz NOT NULL DEFAULT now(),
  zuletzt_gesehen timestamptz,
  widerrufen timestamptz
);
CREATE INDEX rechner_person_idx ON rechner (mandant_id, person_id);

CREATE TABLE ingest_token (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  typ text NOT NULL CHECK (typ IN ('mandant', 'rechner')),
  rechner_id uuid REFERENCES rechner (id) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL UNIQUE,
  praefix text NOT NULL,
  erstellt timestamptz NOT NULL DEFAULT now(),
  zuletzt_genutzt timestamptz,
  widerrufen timestamptz,
  CHECK ((typ = 'rechner') = (rechner_id IS NOT NULL))
);

CREATE TABLE einmalcode (
  code_sha256 bytea PRIMARY KEY,
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  person_id uuid REFERENCES person (id) ON DELETE CASCADE,
  erstellt timestamptz NOT NULL DEFAULT now(),
  laeuft_ab timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  genutzt_am timestamptz,
  rechner_id uuid REFERENCES rechner (id) ON DELETE SET NULL
);

CREATE TABLE person_klar (
  person_id uuid PRIMARY KEY REFERENCES person (id) ON DELETE CASCADE,
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  email_enc bytea,
  name_enc bytea
);

CREATE TABLE person_sitz (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  gueltig_ab date NOT NULL,
  sitz_typ text NOT NULL CHECK (sitz_typ IN ('standard', 'premium', 'enterprise', 'max')),
  gueltig_bis date,
  PRIMARY KEY (person_id, gueltig_ab)
);
CREATE INDEX person_sitz_mandant_idx ON person_sitz (mandant_id, gueltig_ab);

CREATE TABLE sitzkosten (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  sitz_typ text NOT NULL CHECK (sitz_typ IN ('standard', 'premium', 'enterprise', 'max')),
  gueltig_ab date NOT NULL,
  preis_monat numeric(12, 2) NOT NULL,
  waehrung text NOT NULL DEFAULT 'USD',
  abrechnung text NOT NULL DEFAULT 'jaehrlich' CHECK (abrechnung IN ('monatlich', 'jaehrlich')),
  PRIMARY KEY (mandant_id, sitz_typ, gueltig_ab)
);

CREATE TABLE projekt (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  projekt_key bytea NOT NULL,
  url_norm text,
  repo_name text,
  owner text,
  provider text CHECK (provider IN ('github', 'gitlab', 'gitea', 'unknown')),
  anzeigename text,
  kunde text,
  erstellt timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandant_id, projekt_key)
);
CREATE INDEX projekt_kunde_idx ON projekt (mandant_id, kunde);

CREATE TABLE projekt_alias (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  projekt_key bytea NOT NULL,
  projekt_id uuid NOT NULL REFERENCES projekt (id) ON DELETE CASCADE,
  PRIMARY KEY (mandant_id, projekt_key)
);

CREATE TABLE sitzung (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  session_id text NOT NULL,
  person_id uuid REFERENCES person (id) ON DELETE SET NULL,
  rechner_id uuid REFERENCES rechner (id) ON DELETE SET NULL,
  projekt_id uuid REFERENCES projekt (id) ON DELETE SET NULL,
  org_uuid uuid,
  auth_klasse text NOT NULL DEFAULT 'unbekannt'
    CHECK (auth_klasse IN ('abo', 'api', 'provider', 'fremd_org', 'unbekannt')),
  quellen smallint NOT NULL DEFAULT 0,
  cc_version text,
  start timestamptz,
  ende timestamptz,
  PRIMARY KEY (mandant_id, session_id)
);
CREATE INDEX sitzung_person_idx ON sitzung (mandant_id, person_id, start);

-- Einzelanfragen, monatlich nach ts (UTC) partitioniert. Postgres verlangt die Partitionsspalte im
-- Primärschlüssel; der Merge sucht deshalb über (mandant_id, anfrage_key) und ein ts-Fenster.
CREATE TABLE anfrage (
  mandant_id uuid NOT NULL,
  anfrage_key text NOT NULL,
  ts timestamptz NOT NULL,
  tag date NOT NULL,
  session_id text,
  person_id uuid,
  projekt_id uuid,
  model text NOT NULL,
  speed text,
  inference_geo text,
  service_tier text,
  query_source text,
  ist_subagent boolean,
  input bigint NOT NULL DEFAULT 0,
  output bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  cache_write_1h bigint,
  web_search integer NOT NULL DEFAULT 0,
  quellen smallint NOT NULL DEFAULT 0,
  auth_klasse text NOT NULL DEFAULT 'unbekannt'
    CHECK (auth_klasse IN ('abo', 'api', 'provider', 'fremd_org', 'unbekannt')),
  zaehlt_als_abo boolean NOT NULL DEFAULT false,
  cc_kosten_usd_micros bigint,
  abweichung_ab boolean NOT NULL DEFAULT false,
  heuristisch boolean NOT NULL DEFAULT false,
  PRIMARY KEY (mandant_id, anfrage_key, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX anfrage_tag_idx ON anfrage (mandant_id, tag);
CREATE INDEX anfrage_sitzung_idx ON anfrage (mandant_id, session_id, ts);
CREATE INDEX anfrage_projekt_idx ON anfrage (mandant_id, projekt_id, tag);
CREATE INDEX anfrage_person_idx ON anfrage (mandant_id, person_id, tag);

CREATE TABLE otel_kontrollsumme (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  tag date NOT NULL,
  session_id text NOT NULL,
  model text NOT NULL,
  typ text NOT NULL,
  query_source text NOT NULL DEFAULT '',
  wert bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (mandant_id, tag, session_id, model, typ, query_source)
);

-- person_id/projekt_id NULL = ohne Person bzw. „unzugeordnet“, daher UNIQUE NULLS NOT DISTINCT statt PK.
CREATE TABLE tag_aggregat (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  tag date NOT NULL,
  person_id uuid REFERENCES person (id) ON DELETE CASCADE,
  projekt_id uuid REFERENCES projekt (id) ON DELETE CASCADE,
  model text NOT NULL,
  speed text NOT NULL DEFAULT 'normal',
  auth_klasse text NOT NULL,
  input bigint NOT NULL DEFAULT 0,
  output bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  cache_write_1h bigint NOT NULL DEFAULT 0,
  web_search integer NOT NULL DEFAULT 0,
  anfragen integer NOT NULL DEFAULT 0,
  schatten_usd_micros bigint NOT NULL DEFAULT 0,
  preis_version text,
  abo_anteil numeric(10, 8) NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (mandant_id, tag, person_id, projekt_id, model, speed, auth_klasse)
);
CREATE INDEX tag_aggregat_projekt_idx ON tag_aggregat (mandant_id, projekt_id, tag);
CREATE INDEX tag_aggregat_person_idx ON tag_aggregat (mandant_id, person_id, tag);

-- topf: 'projekt' (projekt_id gesetzt), 'unzugeordnet', 'ungenutzt' (Sitze ohne Nutzung).
CREATE TABLE monatsabschluss (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  monat date NOT NULL CHECK (extract(day FROM monat) = 1),
  projekt_id uuid REFERENCES projekt (id) ON DELETE RESTRICT,
  topf text NOT NULL DEFAULT 'projekt' CHECK (topf IN ('projekt', 'unzugeordnet', 'ungenutzt')),
  schatten_usd_micros bigint NOT NULL DEFAULT 0,
  sitzanteil_usd_micros bigint NOT NULL DEFAULT 0,
  ueberschreitung_usd_micros bigint NOT NULL DEFAULT 0,
  projektpreis_usd_micros bigint NOT NULL DEFAULT 0,
  projektpreis_eur_cent bigint NOT NULL DEFAULT 0,
  kurs numeric(12, 6) NOT NULL,
  preis_version text NOT NULL,
  eingefroren_am timestamptz NOT NULL DEFAULT now(),
  CHECK ((topf = 'projekt') = (projekt_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (mandant_id, monat, topf, projekt_id)
);

CREATE TABLE kurs (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  monat date NOT NULL CHECK (extract(day FROM monat) = 1),
  usd_eur numeric(12, 6) NOT NULL,
  quelle text NOT NULL DEFAULT 'ezb' CHECK (quelle IN ('ezb', 'mandant')),
  PRIMARY KEY (mandant_id, monat)
);

-- mandant_id NULL = globale Zeile (Seed aus @seatmeter/shared), sonst Mandanten-Zeile.
CREATE TABLE preis (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid REFERENCES mandant (id) ON DELETE CASCADE,
  modell_praefix text NOT NULL,
  gueltig_ab date NOT NULL,
  input numeric(12, 6) NOT NULL,
  output numeric(12, 6) NOT NULL,
  cache_read numeric(12, 6) NOT NULL,
  cache_write_5m numeric(12, 6) NOT NULL,
  cache_write_1h numeric(12, 6) NOT NULL,
  fast_input numeric(12, 6),
  fast_output numeric(12, 6),
  prompt_schwelle_tokens integer,
  lang_input numeric(12, 6),
  lang_output numeric(12, 6),
  lang_cache_read numeric(12, 6),
  lang_cache_write_5m numeric(12, 6),
  lang_cache_write_1h numeric(12, 6),
  geo_us_faktor numeric(6, 4) NOT NULL DEFAULT 1.0,
  quelle_url text NOT NULL,
  geprueft_am date NOT NULL,
  UNIQUE NULLS NOT DISTINCT (mandant_id, modell_praefix, gueltig_ab)
);

CREATE TABLE ueberschreitung (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  tag date NOT NULL,
  person_id uuid NOT NULL REFERENCES person (id) ON DELETE CASCADE,
  model text NOT NULL,
  amount_usd_micros bigint NOT NULL DEFAULT 0,
  list_amount_usd_micros bigint,
  input bigint NOT NULL DEFAULT 0,
  output bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  quelle text NOT NULL CHECK (quelle IN ('api', 'csv')),
  PRIMARY KEY (mandant_id, tag, person_id, model)
);

CREATE TABLE abgleich_lauf (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  zeitraum daterange NOT NULL,
  status text NOT NULL DEFAULT 'laeuft' CHECK (status IN ('laeuft', 'ok', 'abweichung', 'fehler')),
  abweichungen jsonb,
  gestartet timestamptz NOT NULL DEFAULT now(),
  beendet timestamptz
);
CREATE INDEX abgleich_lauf_mandant_idx ON abgleich_lauf (mandant_id, gestartet);

CREATE TABLE budget (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  projekt_id uuid NOT NULL REFERENCES projekt (id) ON DELETE CASCADE,
  zeitraum text NOT NULL DEFAULT 'monat' CHECK (zeitraum IN ('monat')),
  betrag numeric(14, 2) NOT NULL,
  waehrung text NOT NULL DEFAULT 'EUR',
  basis text NOT NULL DEFAULT 'projektpreis' CHECK (basis IN ('projektpreis', 'tokens')),
  schwellen integer[] NOT NULL DEFAULT '{50,80,100}',
  erstellt timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX budget_projekt_idx ON budget (mandant_id, projekt_id);

CREATE TABLE alarm (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES budget (id) ON DELETE CASCADE,
  periode date NOT NULL,
  schwelle integer NOT NULL,
  ausgeloest timestamptz NOT NULL DEFAULT now(),
  wert numeric(14, 2) NOT NULL,
  quittiert timestamptz,
  UNIQUE (budget_id, periode, schwelle)
);

-- Konten sind mandantenübergreifend (Login vor Mandantenwahl); die Zuordnung steht in rolle.
CREATE TABLE benutzer (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  benutzername text NOT NULL UNIQUE,
  login text NOT NULL CHECK (login IN ('lokal', 'oidc')),
  oidc_sub text UNIQUE,
  passwort_hash text,
  erstellt timestamptz NOT NULL DEFAULT now(),
  deaktiviert timestamptz
);

CREATE TABLE rolle (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  benutzer_id uuid NOT NULL REFERENCES benutzer (id) ON DELETE CASCADE,
  rolle text NOT NULL
    CHECK (rolle IN ('mandanten_admin', 'projektleiter', 'controller', 'betriebsrat')),
  projekt_ids uuid[],
  UNIQUE (mandant_id, benutzer_id, rolle)
);

CREATE TABLE audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  benutzer_id uuid REFERENCES benutzer (id) ON DELETE SET NULL,
  aktion text NOT NULL,
  objekt text,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_mandant_idx ON audit (mandant_id, ts);

CREATE TABLE ingest_statistik (
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  tag date NOT NULL,
  quelle text NOT NULL CHECK (quelle IN ('a', 'b', 'c')),
  angenommen bigint NOT NULL DEFAULT 0,
  verworfen_inhalt bigint NOT NULL DEFAULT 0,
  verworfen_api bigint NOT NULL DEFAULT 0,
  verworfen_fremd_org bigint NOT NULL DEFAULT 0,
  unzugeordnet bigint NOT NULL DEFAULT 0,
  zuletzt timestamptz,
  PRIMARY KEY (mandant_id, tag, quelle)
);

-- Protokoll der Löschläufe (Architektur §3.5, erscheint im Betriebsrats-Bericht).
CREATE TABLE loeschlauf (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  mandant_id uuid NOT NULL REFERENCES mandant (id) ON DELETE CASCADE,
  tabelle text NOT NULL,
  bis date NOT NULL,
  anzahl bigint NOT NULL DEFAULT 0,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loeschlauf_mandant_idx ON loeschlauf (mandant_id, ts);

-- Mandantenfreie Auflösung für Ingest und Enrollment: läuft als Eigentümer (umgeht RLS),
-- gibt nur die Zuordnung zurück, nie andere Zeilen.
CREATE FUNCTION token_aufloesen(p_sha256 bytea)
  RETURNS TABLE (token_id uuid, mandant_id uuid, typ text, rechner_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT t.id, t.mandant_id, t.typ, t.rechner_id FROM ingest_token t
    WHERE t.token_sha256 = p_sha256 AND t.widerrufen IS NULL
  $$;

CREATE FUNCTION einmalcode_aufloesen(p_sha256 bytea)
  RETURNS TABLE (mandant_id uuid, person_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT e.mandant_id, e.person_id FROM einmalcode e
    WHERE e.code_sha256 = p_sha256 AND e.genutzt_am IS NULL AND e.laeuft_ab > now()
  $$;
`;

function rlsSql(rolle: string): string {
  const teile: string[] = [];
  for (const t of MANDANTEN_TABELLEN) {
    teile.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
    teile.push(
      `CREATE POLICY mandant_trennung ON ${t} USING (mandant_id = app_mandant_id()) WITH CHECK (mandant_id = app_mandant_id());`,
    );
  }
  // mandant: nur der eigene Datensatz.
  teile.push('ALTER TABLE mandant ENABLE ROW LEVEL SECURITY;');
  teile.push(
    'CREATE POLICY mandant_trennung ON mandant USING (id = app_mandant_id()) WITH CHECK (id = app_mandant_id());',
  );
  // preis: globale Zeilen lesbar, schreiben nur im eigenen Mandanten.
  teile.push('ALTER TABLE preis ENABLE ROW LEVEL SECURITY;');
  teile.push(
    'CREATE POLICY preis_lesen ON preis FOR SELECT USING (mandant_id IS NULL OR mandant_id = app_mandant_id());',
  );
  teile.push(
    'CREATE POLICY preis_schreiben ON preis USING (mandant_id = app_mandant_id()) WITH CHECK (mandant_id = app_mandant_id());',
  );

  teile.push(`GRANT USAGE ON SCHEMA public TO ${rolle};`);
  teile.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rolle};`);
  teile.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rolle};`);
  teile.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rolle};`,
  );
  teile.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${rolle};`,
  );
  // Migrationstabellen gehören nicht der Anwendung.
  teile.push(`REVOKE ALL ON kysely_migration, kysely_migration_lock FROM ${rolle};`);
  // SECURITY-DEFINER-Funktionen nur für die Anwendungsrolle, nicht für PUBLIC.
  teile.push(
    'REVOKE EXECUTE ON FUNCTION token_aufloesen(bytea), einmalcode_aufloesen(bytea) FROM PUBLIC;',
  );
  teile.push(
    `GRANT EXECUTE ON FUNCTION token_aufloesen(bytea), einmalcode_aufloesen(bytea), app_mandant_id() TO ${rolle};`,
  );
  return teile.join('\n');
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Rollen gelten clusterweit; nur anlegen, wenn sie fehlt.
  await sql
    .raw(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLLE}') THEN
           CREATE ROLE ${APP_ROLLE} NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    )
    .execute(db);
  await sql.raw(SCHEMA).execute(db);
  await sql.raw(rlsSql(APP_ROLLE)).execute(db);
  // Partitionen für den Vormonat (Rückfüllung), den laufenden und den nächsten Monat.
  const jetzt = new Date();
  const vormonat = monatsanfang(
    new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 1, 1)),
  );
  await anfragePartitionenAnlegen(db, { ab: vormonat, monate: 3 });
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
