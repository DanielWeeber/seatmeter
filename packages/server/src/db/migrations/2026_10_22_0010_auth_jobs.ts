// Phase 1b „Jobs + API“: Dashboard-Sitzungen (Modul auth), Protokoll der Job-Läufe (jobs/) und die
// mandantenfreie Auflösung der Rollen eines Benutzers (Login vor Mandantenwahl).
// Beide Tabellen sind mandantenübergreifend wie `benutzer` und tragen deshalb keine RLS-Policy.
import { sql, type Kysely } from 'kysely';
import { APP_ROLLE } from '../konstanten.js';

const SCHEMA = `
-- Dashboard-Sitzung: Cookie enthält ein Zufallstoken, gespeichert ist nur dessen SHA-256.
CREATE TABLE benutzer_sitzung (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  token_sha256 bytea NOT NULL UNIQUE,
  benutzer_id uuid NOT NULL REFERENCES benutzer (id) ON DELETE CASCADE,
  mandant_id uuid REFERENCES mandant (id) ON DELETE SET NULL,
  csrf text NOT NULL,
  quelle text NOT NULL DEFAULT 'lokal' CHECK (quelle IN ('lokal', 'remote_user')),
  erstellt timestamptz NOT NULL DEFAULT now(),
  laeuft_ab timestamptz NOT NULL
);
CREATE INDEX benutzer_sitzung_ablauf_idx ON benutzer_sitzung (laeuft_ab);
CREATE INDEX benutzer_sitzung_benutzer_idx ON benutzer_sitzung (benutzer_id);

-- Protokoll der Job-Läufe (Planer, --einmal, API); ergebnis enthält nur Zähler.
CREATE TABLE job_lauf (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  job text NOT NULL,
  ausloeser text NOT NULL DEFAULT 'plan' CHECK (ausloeser IN ('plan', 'einmal', 'api')),
  status text NOT NULL DEFAULT 'laeuft'
    CHECK (status IN ('laeuft', 'ok', 'fehler', 'uebersprungen')),
  gestartet timestamptz NOT NULL DEFAULT now(),
  beendet timestamptz,
  ergebnis jsonb,
  fehler text
);
CREATE INDEX job_lauf_job_idx ON job_lauf (job, gestartet);

-- Rollen eines Benutzers über alle Mandanten (rolle und mandant haben RLS); läuft als Eigentümer.
CREATE FUNCTION benutzer_mandanten(p_benutzer uuid)
  RETURNS TABLE (mandant_id uuid, name text, slug text, rolle text, projekt_ids uuid[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT m.id, m.name, m.slug, r.rolle, r.projekt_ids
    FROM rolle r JOIN mandant m ON m.id = r.mandant_id
    WHERE r.benutzer_id = p_benutzer
    ORDER BY m.name, m.id, r.rolle
  $$;
REVOKE EXECUTE ON FUNCTION benutzer_mandanten(uuid) FROM PUBLIC;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
  await sql
    .raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON benutzer_sitzung, job_lauf TO ${APP_ROLLE};
       GRANT EXECUTE ON FUNCTION benutzer_mandanten(uuid) TO ${APP_ROLLE};`,
    )
    .execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
