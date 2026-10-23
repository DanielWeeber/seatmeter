// Mandanten-Kontext für eine Ingest-Transaktion: Zeitzone, Aufbewahrung, Org-Positivliste, Salts.
// Dazu Partitionen für `anfrage` bei Bedarf anlegen und Tageswerte in der Mandanten-Zeitzone.
import { sql, type Transaction } from 'kysely';
import type { AuthKlasse } from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { anfragePartitionenAnlegen, monatsanfang } from '../db/partitionen.js';
import type { Datenbank } from '../db/schema.js';
import { mandantSaltsLaden, type MandantSalts } from './geheimnis.js';

export interface MandantKontext extends MandantSalts {
  mandantId: string;
  zeitzone: string;
  aufbewahrungTage: number;
  /** Org-UUIDs (klein geschrieben) aus `anthropic_org`. */
  orgs: Set<string>;
  /** Positivliste der Projektschlüssel für Issue-Schlüssel (`mandant.issue_praefixe`); `null` = alle. */
  issuePraefixe: string[] | null;
}

export async function mandantKontextLaden(
  trx: Transaction<Datenbank>,
  masterKey: Buffer,
  mandantId: string,
): Promise<MandantKontext> {
  const mandant = await trx
    .selectFrom('mandant')
    .select(['zeitzone', 'aufbewahrung_anfrage_tage', 'issue_praefixe'])
    .where('id', '=', mandantId)
    .executeTakeFirstOrThrow();
  const orgs = await trx
    .selectFrom('anthropic_org')
    .select('org_uuid')
    .where('mandant_id', '=', mandantId)
    .execute();
  const salts = await mandantSaltsLaden(trx, masterKey, mandantId);
  return {
    mandantId,
    zeitzone: mandant.zeitzone,
    aufbewahrungTage: mandant.aufbewahrung_anfrage_tage,
    orgs: new Set(orgs.map((o) => o.org_uuid.toLowerCase())),
    issuePraefixe: mandant.issue_praefixe,
    ...salts,
  };
}

const formatierer = new Map<string, Intl.DateTimeFormat>();

/** Kalendertag `YYYY-MM-DD` eines Zeitpunkts in der Zeitzone des Mandanten. */
export function tagIn(zeitzone: string, zeit: Date): string {
  let f = formatierer.get(zeitzone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zeitzone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatierer.set(zeitzone, f);
  }
  return f.format(zeit);
}

const TAG_MS = 86_400_000;

/**
 * Zeitfenster, in dem Einzelanfragen angenommen werden: nicht älter als die Aufbewahrung
 * (sonst löscht der nächste Lauf sie sofort) und höchstens einen Tag in der Zukunft (Uhrabweichung).
 */
export function imAnnahmefenster(ts: Date, aufbewahrungTage: number, jetzt = new Date()): boolean {
  const t = ts.getTime();
  if (!Number.isFinite(t)) return false;
  return t >= jetzt.getTime() - aufbewahrungTage * TAG_MS && t <= jetzt.getTime() + TAG_MS;
}

const bekannteMonate = new Set<string>();

/**
 * Legt die Monatspartitionen für die Zeitpunkte an, falls sie fehlen (Eigentümer-Verbindung,
 * serialisiert über ein Advisory-Lock). Bereits geprüfte Monate merkt sich der Prozess.
 */
export async function partitionenSicherstellen(db: Db, zeiten: Iterable<Date>): Promise<void> {
  const fehlend = new Map<string, Date>();
  for (const t of zeiten) {
    const m = monatsanfang(t);
    const k = m.toISOString();
    if (!bekannteMonate.has(k)) fehlend.set(k, m);
  }
  if (fehlend.size === 0) return;
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('seatmeter:partitionen', 0))`.execute(
      trx,
    );
    for (const m of fehlend.values())
      await anfragePartitionenAnlegen<Datenbank>(trx, { ab: m, monate: 1 });
  });
  for (const k of fehlend.keys()) bekannteMonate.add(k);
}

/** Ergebnis der Abo-Regel (Architektur §4) samt Zähler, in dem ein verworfener Datensatz landet. */
export function verwerfZaehler(klasse: AuthKlasse): 'verworfen_api' | 'verworfen_fremd_org' | null {
  switch (klasse) {
    case 'abo':
      return null;
    case 'api':
    case 'provider':
      return 'verworfen_api';
    // „unbekannt“ (Org nicht bestätigt) zählt mit unter „fremde Org“.
    case 'fremd_org':
    case 'unbekannt':
      return 'verworfen_fremd_org';
  }
}
