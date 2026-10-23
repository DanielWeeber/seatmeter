// Startwerte der Preistabelle aus der offiziellen Preisseite (Stand 2026-10-22, Architektur §2.5, §13).
// Nicht aus CCAM übernommen. `gueltig_ab` 2026-01-01: Startwert für alle erfassten Anfragen; spätere
// Änderungen kommen als neue Zeile mit eigenem `gueltig_ab` dazu.
import { preisZeileSchema, type PreisZeile, type PreisSaetze } from './typen.js';

export const PREIS_QUELLE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PREIS_GEPRUEFT_AM = '2026-10-22';
export const PREIS_SEED_GUELTIG_AB = '2026-01-01';

interface SeedZeile {
  praefix: string;
  /** input, output, cache_read, cache_write_5m, cache_write_1h */
  saetze: [number, number, number, number, number];
  fast?: [number, number];
  /** Aufschlag `inference_geo = us` gilt ab Claude 4.6. */
  geoUs: boolean;
  lang?: { schwelle: number; saetze: [number, number, number, number, number] };
}

const satz = ([
  input,
  output,
  cache_read,
  cache_write_5m,
  cache_write_1h,
]: SeedZeile['saetze']): PreisSaetze => ({
  input,
  output,
  cache_read,
  cache_write_5m,
  cache_write_1h,
});

// Hinweis: Die Modell-IDs der 5.x-Familien (z. B. `claude-fable-5-1`) folgen dem Muster der
// bekannten IDs; gegen echte OTel-/Transkript-Werte prüfen (Datenqualität „Modell ohne Preis“).
const ZEILEN: SeedZeile[] = [
  { praefix: 'claude-fable-5-1', saetze: [10, 50, 0.25, 12.5, 20], geoUs: true },
  { praefix: 'claude-mythos-5-1', saetze: [10, 50, 0.25, 12.5, 20], geoUs: true },
  { praefix: 'claude-fable-5', saetze: [10, 50, 1, 12.5, 20], geoUs: true },
  { praefix: 'claude-mythos-5', saetze: [10, 50, 1, 12.5, 20], geoUs: true },
  { praefix: 'claude-opus-5-5', saetze: [4, 20, 0.2, 5, 8], fast: [8, 40], geoUs: true },
  { praefix: 'claude-opus-5', saetze: [5, 25, 0.5, 6.25, 10], fast: [10, 50], geoUs: true },
  { praefix: 'claude-opus-4-8', saetze: [5, 25, 0.5, 6.25, 10], fast: [10, 50], geoUs: true },
  { praefix: 'claude-opus-4-7', saetze: [5, 25, 0.5, 6.25, 10], geoUs: true },
  { praefix: 'claude-opus-4-6', saetze: [5, 25, 0.5, 6.25, 10], geoUs: true },
  { praefix: 'claude-opus-4-5', saetze: [5, 25, 0.5, 6.25, 10], geoUs: false },
  { praefix: 'claude-opus-4-1', saetze: [15, 75, 1.5, 18.75, 30], geoUs: false },
  { praefix: 'claude-opus-4', saetze: [15, 75, 1.5, 18.75, 30], geoUs: false },
  { praefix: 'claude-sonnet-5-5', saetze: [2, 10, 0.1, 2.5, 4], geoUs: true },
  { praefix: 'claude-sonnet-5', saetze: [2, 10, 0.2, 2.5, 4], geoUs: true },
  { praefix: 'claude-sonnet-4-6', saetze: [3, 15, 0.3, 3.75, 6], geoUs: true },
  { praefix: 'claude-sonnet-4-5', saetze: [3, 15, 0.3, 3.75, 6], geoUs: false },
  { praefix: 'claude-sonnet-4', saetze: [3, 15, 0.3, 3.75, 6], geoUs: false },
  {
    praefix: 'claude-haiku-5-5',
    saetze: [0.1, 0.5, 0.01, 0.125, 0.2],
    geoUs: true,
    lang: { schwelle: 100_000, saetze: [0.5, 2.5, 0.05, 0.625, 1] },
  },
  { praefix: 'claude-haiku-4-5', saetze: [1, 5, 0.1, 1.25, 2], geoUs: false },
  { praefix: 'claude-3-5-haiku', saetze: [0.8, 4, 0.08, 1, 1.6], geoUs: false },
];

/** Globale Startwerte (mandant_id = null). */
export const PREIS_SEED: readonly PreisZeile[] = ZEILEN.map((z) =>
  preisZeileSchema.parse({
    mandant_id: null,
    modell_praefix: z.praefix,
    gueltig_ab: PREIS_SEED_GUELTIG_AB,
    saetze: satz(z.saetze),
    fast_input: z.fast?.[0] ?? null,
    fast_output: z.fast?.[1] ?? null,
    prompt_schwelle_tokens: z.lang?.schwelle ?? null,
    lang: z.lang ? satz(z.lang.saetze) : null,
    geo_us_faktor: z.geoUs ? 1.1 : 1,
    quelle_url: PREIS_QUELLE_URL,
    geprueft_am: PREIS_GEPRUEFT_AM,
  }),
);
