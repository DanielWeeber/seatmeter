// Preistabelle (Architektur §2.5, Tabelle `preis` in §3.1). Alle Sätze in USD je 1 Mio. Tokens (MTok).
import { z } from 'zod';

const usdJeMTok = z.number().nonnegative();

export const preisSaetzeSchema = z.strictObject({
  input: usdJeMTok,
  output: usdJeMTok,
  cache_read: usdJeMTok,
  cache_write_5m: usdJeMTok,
  cache_write_1h: usdJeMTok,
});
export type PreisSaetze = z.infer<typeof preisSaetzeSchema>;

export const preisZeileSchema = z.strictObject({
  /** `null` = globale Zeile, sonst Mandanten-eigene Zeile (geht bei gleichem Präfix vor). */
  mandant_id: z.uuid().nullable().default(null),
  /** Modell-Präfix, klein geschrieben; der längste passende Präfix gewinnt. */
  modell_praefix: z.string().min(1).max(200),
  /** Erster Gültigkeitstag (`YYYY-MM-DD`, UTC). */
  gueltig_ab: z.iso.date(),
  saetze: preisSaetzeSchema,
  /** Fast-Mode-Sätze; die Cache-Sätze leiten sich mit denselben Multiplikatoren daraus ab. */
  fast_input: usdJeMTok.nullable().default(null),
  fast_output: usdJeMTok.nullable().default(null),
  /** Langkontext: ab mehr als so vielen Prompt-Tokens (input + cache_read + cache_write) gelten `lang`. */
  prompt_schwelle_tokens: z.int().positive().nullable().default(null),
  lang: preisSaetzeSchema.nullable().default(null),
  /** Aufschlag bei `inference_geo = us` (1,1 ab Claude 4.6, sonst 1,0). */
  geo_us_faktor: z.number().min(1).max(2).default(1),
  quelle_url: z.url(),
  geprueft_am: z.iso.date(),
});
export type PreisZeile = z.infer<typeof preisZeileSchema>;
export type PreisZeileEingabe = z.input<typeof preisZeileSchema>;
