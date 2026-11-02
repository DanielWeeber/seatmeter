// Sperre je Mandant um alles, was `tag_aggregat` und `issue_aggregat` schreibt oder für einen Abschluss liest: Nächtlicher Lauf,
// Neuaufbau auf Anforderung und Monatsabschluss warten aufeinander, der häufige Lauf `aggregation.nah` überspringt den Mandanten.
import { sql, type Transaction } from 'kysely';
import type { Datenbank } from '../db/schema.js';

const schluessel = (mandantId: string) => `seatmeter:aggregation:${mandantId}`;

export async function aggregationSperren(
  trx: Transaction<Datenbank>,
  mandantId: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${schluessel(mandantId)}, 0))`.execute(
    trx,
  );
}

/** `false`: Jemand anderes arbeitet gerade an diesem Mandanten. Gilt bis zum Ende der Transaktion. */
export async function aggregationSperreVersuchen(
  trx: Transaction<Datenbank>,
  mandantId: string,
): Promise<boolean> {
  const r = await sql<{
    ok: boolean;
  }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${schluessel(mandantId)}, 0)) AS ok`.execute(
    trx,
  );
  return r.rows[0]?.ok === true;
}
