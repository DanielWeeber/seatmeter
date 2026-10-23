// Hilfen für Tests gegen echte Postgres (compose.dev.yml bzw. CI-Dienst `postgres`).
import pg from 'pg';

export const BASIS_URL =
  process.env.DATABASE_URL ?? 'postgres://seatmeter:seatmeter-dev@localhost:5432/seatmeter';

/** Ersetzt den Datenbanknamen in einer postgres://-URL. */
export function urlMitDatenbank(url: string, datenbank: string): string {
  const u = new URL(url);
  u.pathname = `/${datenbank}`;
  return u.toString();
}

/** Wartet, bis Postgres Verbindungen annimmt (höchstens `sekunden`). */
export async function warteAufPostgres(url: string, sekunden = 60): Promise<void> {
  const ende = Date.now() + sekunden * 1000;
  let letzterFehler: unknown;
  while (Date.now() < ende) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (fehler) {
      letzterFehler = fehler;
      await client.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Postgres nicht erreichbar nach ${sekunden} s: ${String(letzterFehler)}`);
}

/** Legt eine leere Datenbank an (vorhandene gleichen Namens wird verworfen). */
export async function frischeDatenbank(name: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Ungültiger Datenbankname: ${name}`);
  const admin = new pg.Client({ connectionString: urlMitDatenbank(BASIS_URL, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return urlMitDatenbank(BASIS_URL, name);
}

/**
 * Abbild des Schemas `public` als sortierte Textzeilen (Tabellen, Spalten, Constraints, Indizes, RLS,
 * Richtlinien, Rechte der Anwendungsrolle, Funktionen), ohne die Protokolltabellen der Migratoren. Zwei
 * Datenbanken mit gleichem Abbild sind für die Anwendung gleich (Test des Aktualisierungswegs).
 */
export async function schemaAbbild(url: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const ohneMigrator = `NOT LIKE 'kysely\\_migration%'`;
  const abfragen = [
    `SELECT 'spalte ' || table_name || '.' || column_name || ' #' || ordinal_position || ' ' || data_type
        || ' null=' || is_nullable || ' default=' || coalesce(column_default, '-') AS z
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name ${ohneMigrator}`,
    `SELECT 'constraint ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid) AS z
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname ${ohneMigrator}`,
    `SELECT 'index ' || indexdef AS z FROM pg_indexes WHERE schemaname = 'public' AND tablename ${ohneMigrator}`,
    `SELECT 'tabelle ' || c.relname || ' art=' || c.relkind::text || ' rls=' || c.relrowsecurity::text || ' force=' || c.relforcerowsecurity::text AS z
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND c.relname ${ohneMigrator}`,
    `SELECT 'policy ' || tablename || '.' || policyname || ' ' || cmd || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-') AS z
       FROM pg_policies WHERE schemaname = 'public'`,
    `SELECT 'recht ' || grantee || ' ' || table_name || ' ' || privilege_type AS z
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = 'seatmeter_app' AND table_name ${ohneMigrator}`,
    `SELECT 'funktion ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS z
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
  ];
  try {
    const zeilen: string[] = [];
    for (const q of abfragen) {
      const r = await client.query<{ z: string }>(q);
      zeilen.push(...r.rows.map((x) => x.z));
    }
    return zeilen.sort();
  } finally {
    await client.end();
  }
}
