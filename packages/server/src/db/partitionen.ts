// Monatspartitionen der Tabelle `anfrage` (Architektur §3.1, §3.5: Löschen per DROP PARTITION).
// Jobs rufen `anfragePartitionenAnlegen` täglich auf; das ist idempotent.
import { sql, type Kysely } from 'kysely';
import { APP_ROLLE } from './konstanten.js';

/** Erster Tag des Monats (UTC) zu einem Zeitpunkt. */
export function monatsanfang(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function plusMonate(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** Name der Partition, z. B. `anfrage_2026_10`. */
export function partitionsName(monat: Date): string {
  const m = monatsanfang(monat);
  return `anfrage_${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface PartitionOptionen {
  /** Erster Monat (Standard: laufender Monat). */
  ab?: Date;
  /** Anzahl Monate ab `ab` (Standard 2: laufender und nächster Monat). */
  monate?: number;
}

/**
 * Legt fehlende Monatspartitionen an und gibt ihre Namen zurück. Die Anwendungsrolle bekommt auf
 * Partitionen keine Rechte: Zugriff nur über die Elterntabelle, deren RLS-Policy dann greift.
 */
export async function anfragePartitionenAnlegen<DB>(
  db: Kysely<DB>,
  optionen: PartitionOptionen = {},
): Promise<string[]> {
  const start = monatsanfang(optionen.ab ?? new Date());
  const anzahl = optionen.monate ?? 2;
  const namen: string[] = [];
  for (let i = 0; i < anzahl; i++) {
    const von = plusMonate(start, i);
    const bis = plusMonate(start, i + 1);
    const name = partitionsName(von);
    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF anfrage
           FOR VALUES FROM ('${von.toISOString()}') TO ('${bis.toISOString()}');
         REVOKE ALL ON TABLE ${name} FROM ${APP_ROLLE};`,
      )
      .execute(db);
    namen.push(name);
  }
  return namen;
}
