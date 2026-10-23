// API-Vertrag des Abgleichs (Kern seit 2026-10-24, vorher ee; Architektur §2.6): Enterprise Analytics API und Team-Spend-CSV.
// Zusammenfassungen enthalten nie Personendaten (nur Zähler und Tagessummen).
import { z } from 'zod';

const tag = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Tag als JJJJ-MM-TT');

export const analyticsKeyEingabeSchema = z.strictObject({
  key: z.string().trim().min(20).max(500),
});

export const abgleichZeitraumSchema = z.object({ von: tag.optional(), bis: tag.optional() });

export const ABGLEICH_STATUS = ['laeuft', 'ok', 'abweichung', 'fehler'] as const;

export const abgleichTagSchema = z.object({
  tag,
  tokens_quelle: z.number(),
  tokens_seatmeter: z.number(),
  abweichung_prozent: z.number().nullable(),
});

export const abgleichZusammenfassungSchema = z.object({
  schwelle_prozent: z.number(),
  /** Personentage der Quelle (Analytics API bzw. CSV). */
  personentage_quelle: z.int(),
  /** Davon einer Person in seatmeter zugeordnet. */
  zugeordnet: z.int(),
  ohne_zuordnung: z.int(),
  /** Zugeordnete Personentage, deren Tokens um mehr als die Schwelle abweichen. */
  abweichend: z.int(),
  innerhalb: z.int(),
  /** Personentage mit Abo-Nutzung in seatmeter, die in der Quelle fehlen. */
  nur_seatmeter: z.int(),
  tokens_quelle: z.number(),
  tokens_seatmeter: z.number(),
  /** Tokens seatmeter / Tokens Quelle in Prozent (zugeordnete Personentage). */
  abdeckung_prozent: z.number().nullable(),
  ueberschreitung_zeilen: z.int(),
  ueberschreitung_usd_micros: z.number(),
  tage: z.array(abgleichTagSchema),
});
export type AbgleichZusammenfassung = z.infer<typeof abgleichZusammenfassungSchema>;

export const abgleichLaufSchema = z.object({
  id: z.uuid(),
  quelle: z.enum(['api', 'csv']),
  von: tag,
  bis: tag,
  status: z.enum(ABGLEICH_STATUS),
  ausloeser: z.enum(['plan', 'einmal', 'api']),
  gestartet: z.string(),
  beendet: z.string().nullable(),
  zeilen: z.int(),
  fehler: z.string().nullable(),
  zusammenfassung: abgleichZusammenfassungSchema.nullable(),
});
export type AbgleichLauf = z.infer<typeof abgleichLaufSchema>;

export const abgleichLaeufeSchema = z.object({ laeufe: z.array(abgleichLaufSchema) });
export type AbgleichLaeufe = z.infer<typeof abgleichLaeufeSchema>;

export const abgleichStatusSchema = z.object({
  plan: z.string(),
  key_gesetzt: z.boolean(),
  key_geaendert: z.string().nullable(),
  letzter_lauf: abgleichLaufSchema.nullable(),
});
export type AbgleichStatus = z.infer<typeof abgleichStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Team-CSV (Spaltenformat nicht verifiziert: tolerante Erkennung mit Zuordnungsschritt)

export const CSV_FELDER = [
  'email',
  'tag',
  'modell',
  'amount',
  'list_amount',
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const;
export type CsvFeld = (typeof CSV_FELDER)[number];

/** Zuordnung Feld → Spaltenname der CSV (`null` = nicht vorhanden). */
export const csvZuordnungSchema = z.partialRecord(
  z.enum(CSV_FELDER),
  z.string().max(200).nullable(),
);
export type CsvZuordnung = z.infer<typeof csvZuordnungSchema>;

export const CSV_BETRAG_EINHEITEN = ['usd', 'cent'] as const;

export const csvEingabeSchema = z.strictObject({
  csv: z.string().min(1).max(20_000_000),
  /** Überschreibt die erkannte Zuordnung feldweise. */
  zuordnung: csvZuordnungSchema.optional(),
  /** Einheit der Beträge; Standard: USD mit Dezimalstellen. */
  betrag_einheit: z.enum(CSV_BETRAG_EINHEITEN).optional(),
});
export type CsvEingabe = z.input<typeof csvEingabeSchema>;

export const csvVorschauSchema = z.object({
  trennzeichen: z.string(),
  spalten: z.array(z.string()),
  zuordnung: z.record(z.string(), z.string().nullable()),
  betrag_einheit: z.enum(CSV_BETRAG_EINHEITEN),
  zeilen: z.int(),
  gueltig: z.int(),
  zugeordnet: z.int(),
  ohne_zuordnung: z.int(),
  tage: z.object({ von: tag.nullable(), bis: tag.nullable() }),
  summe_usd: z.number(),
  /** Erste Zeilen mit maskierter E-Mail (nur zur Kontrolle der Zuordnung). */
  beispiel: z.array(z.record(z.string(), z.string())),
  fehler: z.array(z.string()),
});
export type CsvVorschau = z.infer<typeof csvVorschauSchema>;
