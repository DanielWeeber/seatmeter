// Anzeigetexte der Projekt-Hinweise.
import type { HinweisRegeln, HinweisTyp } from '@seatmeter/shared';

export const HINWEIS_TYP_TEXT: Record<HinweisTyp, string> = {
  cache_write: 'Prompt-Caching prüfen',
  fast_mode: 'Fast-Mode-Anteil',
  opus_anteil: 'Opus-Anteil hoch',
  sitze_ungenutzt: 'Ungenutzte Sitze',
  unzugeordnet: 'Sitzungen ohne Git-Remote',
  modell_ohne_preis: 'Modell ohne Preis',
  prognose_ueber_budget: 'Prognose über Budget',
};

export const REGEL_TEXT: Record<keyof HinweisRegeln, string> = {
  cache_write_prozent: 'Cache-Schreibanteil ab (%)',
  fast_prozent: 'Fast-Mode-Anteil ab (%)',
  opus_prozent: 'Opus-Anteil ab (%)',
  unzugeordnet_prozent: 'Anteil „unzugeordnet“ ab (%)',
  mindest_usd: 'Mindest-Schattenpreis je Projekt (USD)',
};

export const REGEL_FELDER = Object.keys(REGEL_TEXT) as (keyof HinweisRegeln)[];
