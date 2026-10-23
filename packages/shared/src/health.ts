// Antwortteile von `GET /api/health/ingest` (Server-Modul health, Werte aus ingest-gemeinsam/status.ts),
// die Monitoring-Bedingungen (Gatus) und Dashboard gemeinsam lesen. Mandantenübergreifend, nur Zähler.
import { z } from 'zod';

/** Lebenszeichen gilt als frisch, wenn es jünger ist als diese Stunden (Heartbeat alle 5–15 min). */
export const HEARTBEAT_FRISCH_STUNDEN = 2;
/** Ein Rechner zählt als aktiv, wenn sein letztes Lebenszeichen jünger ist als diese Stunden. */
export const AGENT_AKTIV_STUNDEN = 48;

const stunden = z.number().min(0);
const ganzeStunden = z.int().min(0);

/**
 * Stand der Agenten (Quelle B) über alle nicht widerrufenen Rechner. Grundlage ist
 * `rechner.zuletzt_gesehen`, das jeder Push und jeder Heartbeat setzt.
 */
export const ingestAgentenSchema = z.strictObject({
  /** Registrierte, nicht widerrufene Rechner. */
  gesamt: z.int().min(0),
  /** Davon mit Lebenszeichen in den letzten 48 h (Bedingung `[BODY].agenten.aktiv_48h > 0`). */
  aktiv_48h: z.int().min(0),
  /** Stunden seit dem ältesten bzw. jüngsten Lebenszeichen (eine Nachkommastelle), `null` ohne Rechner. */
  aeltester_heartbeat_stunden: stunden.nullable(),
  juengster_heartbeat_stunden: stunden.nullable(),
  /**
   * Ganze Stunden ohne Lieferung von Quelle B, obwohl ein Agent in den letzten 2 h ein Lebenszeichen
   * geschickt hat; `0`, wenn kein Agent frisch ist. Hat B noch nie geliefert, zählt die Zeit ab der
   * Registrierung des ältesten frischen Rechners.
   */
  stille_trotz_heartbeat_stunden: ganzeStunden,
  /**
   * Ganze Stunden, über die Quelle A für Personen mit Agent-Daten Anfragen geliefert hat, zu denen B
   * nichts nachgeliefert hat (A-Anfragen ohne B-Gegenstück nach der jüngsten B-Anfrage derselben
   * Person, letzte 30 Tage). Arbeitet niemand, liefert auch A nichts: der Wert wächst nachts und am
   * Wochenende nicht.
   */
  luecke_zu_a_stunden: ganzeStunden,
});
export type IngestAgenten = z.infer<typeof ingestAgentenSchema>;

/** Schlüsselarten des Ingest-Ratenlimits (Server ingest-gemeinsam/ratenlimit.ts). */
export const RATENLIMIT_ARTEN = [
  'ip',
  'fehlversuch',
  'token',
  'rechner',
  'enroll',
  'enroll_fehlversuch',
] as const;

/**
 * `ratenlimit` in `/api/health/ingest`: abgelehnte Anfragen (429) der letzten 24 h je Schlüsselart,
 * im Speicher des Servers gezählt (nach einem Neustart ab `seit`). Je Quelle steht die Summe in
 * `quellen.<a|b>.abgelehnt_429_24h`.
 */
export const ingestRatenlimitStandSchema = z.strictObject({
  seit: z.iso.datetime(),
  abgelehnt_429_24h_je_art: z.strictObject(
    Object.fromEntries(RATENLIMIT_ARTEN.map((a) => [a, z.int().min(0)])) as Record<
      (typeof RATENLIMIT_ARTEN)[number],
      z.ZodInt
    >,
  ),
});
export type IngestRatenlimitStand = z.infer<typeof ingestRatenlimitStandSchema>;

/** Zähler des heutigen Tages je Quelle (Annahmetag in der Zeitzone des jeweiligen Mandanten). */
export const ingestHeuteSchema = z.object({
  angenommen: z.number(),
  verworfen_inhalt: z.number(),
  verworfen_api: z.number(),
  verworfen_fremd_org: z.number(),
  unzugeordnet: z.number(),
});

/** Werte je Quelle in `GET /api/health/ingest` (Server: ingest-gemeinsam/status.ts). */
export const ingestQuelleStatusSchema = z.object({
  /** Letzte Annahme (ISO) laut `ingest_statistik.zuletzt` oder `null`. */
  letzte_annahme: z.string().nullable(),
  /** Stunden seit der letzten Annahme, `null` = noch nie geliefert (Monitoring: `< 24`). */
  stille_stunden: z.number().nullable(),
  /** Anfragen mit Zeitstempel in den letzten 24 h, an denen die Quelle beteiligt ist. */
  anfragen_24h: z.number(),
  /** Vom Ratenlimit abgelehnte Anfragen (429) der letzten 24 h, im Speicher gezählt (ab `ratenlimit.seit`). */
  abgelehnt_429_24h: z.number(),
  heute: ingestHeuteSchema,
});
export type IngestQuelleStatus = z.infer<typeof ingestQuelleStatusSchema>;

/** `GET /api/health/ingest` (immer 200 mit Werten; 503 nur ohne Datenbank). */
export const ingestHealthSchema = z.object({
  status: z.literal('ok'),
  quellen: z.object({ a: ingestQuelleStatusSchema, b: ingestQuelleStatusSchema }),
  agenten: ingestAgentenSchema,
  ratenlimit: ingestRatenlimitStandSchema,
});
export type IngestHealth = z.infer<typeof ingestHealthSchema>;
