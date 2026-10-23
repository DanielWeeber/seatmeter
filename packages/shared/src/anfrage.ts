// Normalisierter Anfrage-Datensatz (Architektur §3.1, Tabelle `anfrage`).
// Kleinste Zähleinheit: ein API-Request von Claude Code. Enthält nur Zähler und Metadaten, nie Inhalte.
import { z } from 'zod';

/** Auth-Klasse einer Sitzung bzw. Anfrage (Architektur §4). */
export const authKlasseSchema = z.enum(['abo', 'api', 'provider', 'fremd_org', 'unbekannt']);
export type AuthKlasse = z.infer<typeof authKlasseSchema>;

/** Quellen als Bitmaske: A (OTel) = 1, B (Agent) = 2. */
export const QUELLE_A = 1;
export const QUELLE_B = 2;

const tokenAnzahl = z.int().nonnegative();

/**
 * Festgelegter Wert für Anfragen ohne Fast-Modus (`fast` = Fast-Modus). Claude Code meldet ihn in der
 * Telemetrie (Quelle A, Ereignis `api_request`) als `normal`; die Transkripte (Quelle B,
 * `message.usage.speed` der Messages API) schreiben dafür `standard`. Gespeichert wird `normal`
 * (wie der Standard von `tag_aggregat.speed`).
 */
export const SPEED_NORMAL = 'normal';
export const SPEED_FAST = 'fast';

/** Bildet die Schreibweise der Transkripte (`standard`) auf `normal` ab; andere Werte bleiben. */
export function normalisiereSpeed(wert: string | null): string | null {
  return wert === 'standard' ? SPEED_NORMAL : wert;
}

export const anfrageSchema = z.object({
  mandant_id: z.uuid(),
  /** `request_id` (`req_…`), sonst `msg:<message.id>` (Architektur §3.4). */
  anfrage_key: z.string().min(1).max(200),
  ts: z.coerce.date(),
  /** Kalendertag in der Mandanten-Zeitzone, `YYYY-MM-DD`. */
  tag: z.iso.date(),
  session_id: z.string().min(1).max(200).nullable(),
  person_id: z.uuid().nullable(),
  /** `null` = Topf „unzugeordnet“. */
  projekt_id: z.uuid().nullable(),
  model: z.string().min(1).max(200),
  speed: z.string().max(50).nullable(),
  inference_geo: z.string().max(50).nullable(),
  service_tier: z.string().max(50).nullable(),
  query_source: z.string().max(100).nullable(),
  ist_subagent: z.boolean().nullable(),
  input: tokenAnzahl,
  output: tokenAnzahl,
  cache_read: tokenAnzahl,
  /** Summe aller Cache-Schreibvorgänge (5m + 1h). */
  cache_write: tokenAnzahl,
  /** Anteil 1h an `cache_write`; nur aus Quelle B bekannt. */
  cache_write_1h: tokenAnzahl.nullable(),
  web_search: tokenAnzahl,
  quellen: z.int().min(0).max(3),
  auth_klasse: authKlasseSchema,
  zaehlt_als_abo: z.boolean(),
  cc_kosten_usd_micros: z.int().nonnegative().nullable(),
  /** Tokens aus A und B weichen voneinander ab. */
  abweichung_ab: z.boolean(),
});
export type Anfrage = z.infer<typeof anfrageSchema>;
