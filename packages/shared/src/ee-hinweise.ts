// API-Vertrag der Projekt-Hinweise (ee, Festlegung 2026-10-22: Projekt-Hinweise ee, Datenqualität frei).
import { z } from 'zod';
import { monatSchema } from './dashboard.js';

export const HINWEIS_TYPEN = [
  'cache_write',
  'fast_mode',
  'opus_anteil',
  'sitze_ungenutzt',
  'unzugeordnet',
  'modell_ohne_preis',
  'prognose_ueber_budget',
] as const;
export type HinweisTyp = (typeof HINWEIS_TYPEN)[number];

const regelFelder = {
  /** Anteil der Cache-Schreibkosten am Schattenpreis eines Projekts. */
  cache_write_prozent: z.number().min(1).max(100),
  /** Anteil der Fast-Mode-Kosten am Schattenpreis. */
  fast_prozent: z.number().min(1).max(100),
  /** Anteil der Opus-Kosten am Schattenpreis („Sonnet würde reichen“ prüfen). */
  opus_prozent: z.number().min(1).max(100),
  /** Anteil „unzugeordnet“ am gesamten Schattenpreis. */
  unzugeordnet_prozent: z.number().min(0.1).max(100),
  /** Hinweise erst ab diesem Schattenpreis je Projekt und Monat (USD), gegen Rauschen. */
  mindest_usd: z.number().min(0).max(100_000),
};

/** Schwellen der Hinweis-Regeln je Mandant (Prozent), mit Standardwerten. */
export const hinweisRegelnSchema = z.strictObject({
  cache_write_prozent: regelFelder.cache_write_prozent.default(60),
  fast_prozent: regelFelder.fast_prozent.default(20),
  opus_prozent: regelFelder.opus_prozent.default(80),
  unzugeordnet_prozent: regelFelder.unzugeordnet_prozent.default(5),
  mindest_usd: regelFelder.mindest_usd.default(5),
});
export type HinweisRegeln = z.output<typeof hinweisRegelnSchema>;
/** Änderung einzelner Schwellen (PUT): nur gesendete Felder ändern sich, ohne Standardwerte. */
export const hinweisRegelnEingabeSchema = z.strictObject({
  cache_write_prozent: regelFelder.cache_write_prozent.optional(),
  fast_prozent: regelFelder.fast_prozent.optional(),
  opus_prozent: regelFelder.opus_prozent.optional(),
  unzugeordnet_prozent: regelFelder.unzugeordnet_prozent.optional(),
  mindest_usd: regelFelder.mindest_usd.optional(),
});

export const hinweisSchema = z.object({
  id: z.uuid(),
  monat: monatSchema,
  projekt_id: z.uuid().nullable(),
  projekt_name: z.string().nullable(),
  typ: z.enum(HINWEIS_TYPEN),
  text: z.string(),
  wert: z.number().nullable(),
  erstellt: z.string(),
  aktualisiert: z.string(),
  erledigt: z.string().nullable(),
});
export type Hinweis = z.infer<typeof hinweisSchema>;

export const hinweisListeSchema = z.object({
  monat: monatSchema,
  hinweise: z.array(hinweisSchema),
  regeln: hinweisRegelnSchema,
});
export type HinweisListe = z.infer<typeof hinweisListeSchema>;
