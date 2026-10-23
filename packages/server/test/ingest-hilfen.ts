// Hilfen für die Ingest-Tests: App mit Log-Mitschnitt und Test-Anmeldung, Mandanten, Fixtures.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { erstelleApp } from '../src/app.js';
import { ladeKonfiguration, type Konfiguration } from '../src/config.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import { protobufKodieren, type OtlpArt } from '../src/ingest-otlp/protobuf.js';
import type { Benutzerkontext, SeatmeterPlugin } from '../src/plugin.js';

/** Org-UUID der Fixtures (erfunden). */
export const TEST_ORG = '7d0a1c3e-5b2f-4c8d-9e1a-0b2c3d4e5f60';
export const TEST_EMAIL = 'test.person@example.com';
export const TEST_PROMPT = 'GEHEIMER-PROMPT';

export interface TestUmgebung {
  app: FastifyInstance;
  db: Db;
  konfiguration: Konfiguration;
  logs: () => string;
  schliessen: () => Promise<void>;
}

/** Test-Anmeldung über den Header `x-test-benutzer` (JSON eines Benutzerkontexts). */
const testAnmeldung: SeatmeterPlugin = {
  name: 'test-anmeldung',
  authProvider: [
    {
      name: 'test',
      async authentifizieren(anfrage): Promise<Benutzerkontext | null> {
        const kopf = anfrage.headers['x-test-benutzer'];
        return typeof kopf === 'string' ? (JSON.parse(kopf) as Benutzerkontext) : null;
      },
    },
  ],
};

/**
 * `datenbankUrl`: eigene, schon migrierte Datenbank (für Tests mit mandantenübergreifenden Werten);
 * `env`: zusätzliche Umgebungswerte für die Konfiguration (z. B. Ratenlimits).
 */
export async function testUmgebung(
  datenbankUrl?: string,
  env: Record<string, string> = {},
): Promise<TestUmgebung> {
  let logs = '';
  const logStream = new Writable({
    write(chunk, _enc, weiter) {
      logs += String(chunk);
      weiter();
    },
  });
  const konfiguration = ladeKonfiguration({
    DATABASE_URL: datenbankUrl ?? inject('testDatenbankUrl'),
    SEATMETER_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    LOG_LEVEL: 'debug',
    ...env,
  });
  const db = erstelleDb(konfiguration.DATABASE_URL, 4);
  const app = await erstelleApp({ konfiguration, db, logStream, plugins: [testAnmeldung] });
  return {
    app,
    db,
    konfiguration,
    logs: () => logs,
    schliessen: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function testMandant(
  u: TestUmgebung,
  orgs: string[] = [TEST_ORG],
): Promise<{ mandantId: string; token: string }> {
  const e = await mandantAnlegen(u.db, u.konfiguration.SEATMETER_MASTER_KEY, {
    slug: `t-${randomUUID()}`,
    name: 'Testmandant',
    orgs,
  });
  if (!e.token) throw new Error('Token fehlt');
  return { mandantId: e.mandantId, token: e.token };
}

export interface FixtureOptionen {
  jetzt?: Date;
  requestId?: string;
}

/** Lädt eine Fixture und ersetzt die Platzhalter (siehe fixtures/otlp/README.md). */
export function fixture(name: string, o: FixtureOptionen = {}): Record<string, unknown> {
  const jetzt = o.jetzt ?? new Date();
  const nano = (d: Date) => (BigInt(d.getTime()) * 1_000_000n).toString();
  const text = readFileSync(new URL(`./fixtures/otlp/${name}`, import.meta.url), 'utf8')
    .replaceAll('{{JETZT_NANO}}', nano(jetzt))
    .replaceAll('{{START_NANO}}', nano(new Date(jetzt.getTime() - 60_000)))
    .replaceAll('{{JETZT_ISO}}', jetzt.toISOString())
    .replaceAll('{{REQUEST_ID}}', o.requestId ?? 'req_011FIXTURE0000000001');
  return JSON.parse(text) as Record<string, unknown>;
}

export async function otlpSenden(
  u: TestUmgebung,
  art: OtlpArt,
  token: string,
  koerper: Record<string, unknown>,
  format: 'json' | 'protobuf' = 'json',
) {
  return u.app.inject({
    method: 'POST',
    url: `/otlp/v1/${art}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': format === 'json' ? 'application/json' : 'application/x-protobuf',
    },
    payload:
      format === 'json' ? JSON.stringify(koerper) : Buffer.from(protobufKodieren(art, koerper)),
  });
}

/**
 * Legt einen Benutzer mit Rolle im Mandanten an und liefert den Header für die Test-Anmeldung
 * (Plugin-Provider; das Modul auth liest die Rollen aus der Datenbank).
 */
export async function adminKopf(
  u: TestUmgebung,
  mandantId: string,
  rolle: 'mandanten_admin' | 'controller' = 'mandanten_admin',
): Promise<Record<string, string>> {
  const benutzer = await u.db
    .insertInto('benutzer')
    .values({ benutzername: `test-${randomUUID()}`, login: 'lokal' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await u.db
    .insertInto('rolle')
    .values({ mandant_id: mandantId, benutzer_id: benutzer.id, rolle })
    .execute();
  const b: Benutzerkontext = { benutzerId: benutzer.id, mandantId, rollen: [rolle] };
  return { 'x-test-benutzer': JSON.stringify(b) };
}
