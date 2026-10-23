// Vitest-globalSetup: wartet auf Postgres, legt eine frische Testdatenbank an und migriert sie.
import type { TestProject } from 'vitest/node';
import { erstelleDb } from '../src/db/db.js';
import { migriere } from '../src/db/migrator.js';
import { BASIS_URL, frischeDatenbank, warteAufPostgres } from './db-hilfen.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatenbankUrl: string;
    /** Eigene Datenbank der Modul-Tests (Budgets, Hinweise, Abgleich, SSO, SCIM, Jira; bis 2026-10-24 ee). */
    modulDatenbankUrl: string;
  }
}

export default async function setup(projekt: TestProject): Promise<void> {
  await warteAufPostgres(BASIS_URL);
  for (const [name, schluessel] of [
    ['seatmeter_test', 'testDatenbankUrl'],
    ['seatmeter_test_modul', 'modulDatenbankUrl'],
  ] as const) {
    const url = await frischeDatenbank(name);
    const db = erstelleDb(url, 2);
    try {
      await migriere(db);
    } finally {
      await db.destroy();
    }
    projekt.provide(schluessel, url);
  }
}
