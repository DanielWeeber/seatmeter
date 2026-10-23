// Migrationen mit dem Kysely-Migrator: nur vorwärts, unter Advisory-Lock (Postgres-Adapter von Kysely).
import type { Kysely } from 'kysely';
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import type { SeatmeterPlugin } from '../plugin.js';
import { MIGRATIONEN } from './migrations/index.js';

export function erstelleMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => MIGRATIONEN },
  });
}

/** Führt alle offenen Migrationen aus; wirft bei Fehlern. */
export async function migriere<DB>(db: Kysely<DB>): Promise<MigrationResultSet> {
  const ergebnis = await erstelleMigrator(db).migrateToLatest();
  if (ergebnis.error) {
    throw ergebnis.error instanceof Error
      ? ergebnis.error
      : new Error(`Migration fehlgeschlagen: ${String(ergebnis.error)}`);
  }
  return ergebnis;
}

/**
 * Führt die eigenen Migrationen der Plugins aus (nach den Kern-Migrationen), je Plugin mit eigener
 * Protokolltabelle `kysely_migration_<name>`; die Anwendungsrolle bekommt auf diese keine Rechte.
 */
export async function migrierePlugins<DB>(
  db: Kysely<DB>,
  plugins: readonly Pick<SeatmeterPlugin, 'migrationen'>[],
): Promise<void> {
  for (const plugin of plugins) {
    const m = plugin.migrationen;
    if (!m) continue;
    if (!/^[a-z0-9_]+$/.test(m.name)) throw new Error(`Ungültiger Migrationsname: ${m.name}`);
    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => m.migrationen },
      migrationTableName: `kysely_migration_${m.name}`,
      migrationLockTableName: `kysely_migration_${m.name}_lock`,
    });
    const ergebnis = await migrator.migrateToLatest();
    if (ergebnis.error) {
      throw ergebnis.error instanceof Error
        ? ergebnis.error
        : new Error(`Migration (${m.name}) fehlgeschlagen: ${String(ergebnis.error)}`);
    }
  }
}
