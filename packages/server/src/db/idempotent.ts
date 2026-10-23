// Bausteine für idempotente Migrationen (Umzug der ee-Tabellen in den Kern, Entscheidung vom 2026-10-23):
// Dieselbe Migration läuft auf frischen Installationen (legt alles an) und auf Installationen, auf denen die
// frühere ee-Migration die Tabellen schon angelegt hat (ändert dann nichts).
import { sql, type Kysely } from 'kysely';
import { APP_ROLLE } from './konstanten.js';

const NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * RLS wie im Grundschema für Tabellen mit `mandant_id`: Row-Level-Security an, Richtlinie
 * `mandant_trennung` (nur anlegen, wenn sie fehlt) und Rechte der Anwendungsrolle.
 */
export async function mandantenTabellenAbsichern(
  db: Kysely<unknown>,
  tabellen: readonly string[],
): Promise<void> {
  const teile: string[] = [];
  for (const t of tabellen) {
    if (!NAME.test(t)) throw new Error(`Ungültiger Tabellenname: ${t}`);
    teile.push(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`);
    teile.push(`DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = '${t}' AND policyname = 'mandant_trennung'
  ) THEN
    CREATE POLICY mandant_trennung ON ${t}
      USING (mandant_id = app_mandant_id()) WITH CHECK (mandant_id = app_mandant_id());
  END IF;
END $$;`);
    teile.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLLE};`);
  }
  await sql.raw(teile.join('\n')).execute(db);
}
