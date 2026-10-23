// Mandanten-Kontext für Row-Level-Security (Architektur §3, §6).
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from './db.js';
import { APP_ROLLE, MANDANT_GUC } from './konstanten.js';
import type { Datenbank } from './schema.js';

const mandantId = z.uuid();

/**
 * Führt `fn` in einer Transaktion aus, die als Anwendungsrolle (ohne BYPASSRLS) läuft und nur Zeilen
 * des Mandanten sieht: `SET LOCAL ROLE seatmeter_app` plus `SET LOCAL app.mandant_id`.
 * Alle Mandantenzugriffe der Module laufen hierüber.
 */
export async function withMandant<T>(
  db: Db,
  id: string,
  fn: (trx: Transaction<Datenbank>) => Promise<T>,
): Promise<T> {
  const geprueft = mandantId.parse(id);
  return db.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL ROLE ${APP_ROLLE}`).execute(trx);
    await sql`SELECT set_config(${MANDANT_GUC}, ${geprueft}, true)`.execute(trx);
    return fn(trx);
  });
}
