// Hilfen für API-Tests: Konfiguration, Mandanten, Personen, Projekte und Sitzungen direkt in der DB.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Rolle } from '@seatmeter/shared';
import { ladeKonfiguration, type Konfiguration } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { sha256, zufallsToken } from '../src/krypto.js';

export const MASTER_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

export function testKonfiguration(url: string, extra: Record<string, string> = {}): Konfiguration {
  return ladeKonfiguration({
    DATABASE_URL: url,
    SEATMETER_MASTER_KEY: MASTER_KEY_B64,
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

export async function legeMandantAn(
  db: Db,
  werte: { auswertungsstufe?: number; klarnamen_aktiv?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('mandant')
    .values({ id, name: `Test ${id.slice(0, 8)}`, slug: `t-${id}`, ...werte })
    .execute();
  return id;
}

export async function legePersonAn(db: Db, mandantId: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('person')
    .values({
      id,
      mandant_id: mandantId,
      pseudonym: `P-${randomBytes(4).toString('hex').toUpperCase()}`,
      key_konto: randomBytes(32),
    })
    .execute();
  return id;
}

export async function legeProjektAn(db: Db, mandantId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('projekt')
    .values({
      id,
      mandant_id: mandantId,
      projekt_key: randomBytes(32),
      url_norm: `https://git.example.org/test/${name}`,
      repo_name: name,
      owner: 'test',
      provider: 'gitea',
    })
    .execute();
  return id;
}

export interface TestSitzung {
  benutzerId: string;
  headers: { cookie: string; 'x-seatmeter-csrf': string };
}

/** Benutzer mit Rolle und gültiger Sitzung anlegen (ohne Passwort-Anmeldung). */
export async function meldeAn(
  db: Db,
  mandantId: string,
  rolle: Rolle,
  projektIds: string[] | null = null,
): Promise<TestSitzung> {
  const b = await db
    .insertInto('benutzer')
    .values({ benutzername: `test-${randomUUID()}`, login: 'lokal' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('rolle')
    .values({ mandant_id: mandantId, benutzer_id: b.id, rolle, projekt_ids: projektIds })
    .execute();
  const token = zufallsToken();
  const csrf = zufallsToken(24);
  await db
    .insertInto('benutzer_sitzung')
    .values({
      token_sha256: sha256(token),
      benutzer_id: b.id,
      mandant_id: mandantId,
      csrf,
      laeuft_ab: new Date(Date.now() + 3600_000),
    })
    .execute();
  return {
    benutzerId: b.id,
    headers: {
      cookie: `seatmeter_sitzung=${token}; seatmeter_csrf=${csrf}`,
      'x-seatmeter-csrf': csrf,
    },
  };
}
