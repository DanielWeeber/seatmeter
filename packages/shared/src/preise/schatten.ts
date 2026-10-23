// Preissuche (längster Präfix, `gueltig_ab`) und Schattenpreis einer Anfrage (Architektur §2.5, §5).
// Gerechnet wird ganzzahlig (BigInt) in Mikro-USD; gerundet wird einmal je Anfrage (kaufmännisch).
import type { PreisSaetze, PreisZeile } from './typen.js';

export type CacheWriteAnnahme = '1h' | '5m';

export interface SchattenEingabe {
  model: string;
  /** Zeitpunkt der Anfrage; maßgeblich für `gueltig_ab` (UTC-Tag). */
  ts: Date | string;
  input: number;
  output: number;
  cache_read: number;
  /** Summe der Cache-Schreibvorgänge (5m + 1h). */
  cache_write: number;
  /** Anteil 1h an `cache_write`, falls bekannt (nur Quelle B). */
  cache_write_1h?: number | null;
  speed?: string | null;
  inference_geo?: string | null;
}

export interface SchattenErgebnis {
  usdMicros: number;
  preis: PreisZeile;
  langkontext: boolean;
  fast: boolean;
}

function tagVon(ts: Date | string): string {
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Sucht die passende Preiszeile: Präfix passt (ohne Groß-/Kleinschreibung), `gueltig_ab` ≤ Tag;
 * der längste Präfix gewinnt, dann das jüngste `gueltig_ab`, dann die Mandanten-Zeile vor der globalen.
 */
export function findePreis(
  tabelle: readonly PreisZeile[],
  model: string,
  ts: Date | string,
): PreisZeile | null {
  const name = model.trim().toLowerCase();
  const tag = tagVon(ts);
  let beste: PreisZeile | null = null;
  for (const zeile of tabelle) {
    const praefix = zeile.modell_praefix.toLowerCase();
    if (!name.startsWith(praefix) || zeile.gueltig_ab > tag) continue;
    if (beste === null) {
      beste = zeile;
      continue;
    }
    const laenge = praefix.length - beste.modell_praefix.length;
    if (laenge > 0) beste = zeile;
    else if (laenge === 0) {
      if (zeile.gueltig_ab > beste.gueltig_ab) beste = zeile;
      else if (
        zeile.gueltig_ab === beste.gueltig_ab &&
        zeile.mandant_id !== null &&
        beste.mandant_id === null
      )
        beste = zeile;
    }
  }
  return beste;
}

/** USD je MTok → Mikro-USD je MTok (ganzzahlig). */
function mikro(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

/** Ganzzahlige Division mit kaufmännischer Rundung (nur für nichtnegative Werte). */
export function teileGerundet(zaehler: bigint, nenner: bigint): bigint {
  return (zaehler * 2n + nenner) / (nenner * 2n);
}

function tokens(n: number | null | undefined): bigint {
  if (n === null || n === undefined) return 0n;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Ungültige Tokenzahl: ${n}`);
  return BigInt(n);
}

/**
 * Schattenpreis einer Anfrage in Mikro-USD:
 * S(r) = Σ_k n_k · p_k(m,t) / 10^6 · f_geo, mit Fast-Sätzen statt Basis bei `speed = fast`.
 * Fehlt die 5m/1h-Aufteilung, gilt `cacheWriteAnnahme` (Standard 1h). `null`, wenn kein Preis passt.
 */
export function schattenpreis(
  anfrage: SchattenEingabe,
  tabelle: readonly PreisZeile[],
  cacheWriteAnnahme: CacheWriteAnnahme = '1h',
): SchattenErgebnis | null {
  const preis = findePreis(tabelle, anfrage.model, anfrage.ts);
  if (!preis) return null;

  const nInput = tokens(anfrage.input);
  const nOutput = tokens(anfrage.output);
  const nRead = tokens(anfrage.cache_read);
  const nWrite = tokens(anfrage.cache_write);
  let nWrite1h: bigint;
  if (anfrage.cache_write_1h !== null && anfrage.cache_write_1h !== undefined) {
    nWrite1h = tokens(anfrage.cache_write_1h);
    if (nWrite1h > nWrite) throw new Error('cache_write_1h größer als cache_write');
  } else {
    nWrite1h = cacheWriteAnnahme === '1h' ? nWrite : 0n;
  }
  const nWrite5m = nWrite - nWrite1h;

  const promptTokens = nInput + nRead + nWrite;
  const langkontext =
    preis.prompt_schwelle_tokens !== null &&
    preis.lang !== null &&
    promptTokens > BigInt(preis.prompt_schwelle_tokens);
  const basis: PreisSaetze = langkontext && preis.lang ? preis.lang : preis.saetze;

  let rInput = mikro(basis.input);
  let rOutput = mikro(basis.output);
  let rRead = mikro(basis.cache_read);
  let rWrite5m = mikro(basis.cache_write_5m);
  let rWrite1h = mikro(basis.cache_write_1h);

  const fast = anfrage.speed === 'fast' && preis.fast_input !== null && preis.fast_output !== null;
  if (fast && preis.fast_input !== null && preis.fast_output !== null) {
    // Cache-Multiplikatoren wirken auf die Fast-Sätze (Verhältnis zum Basis-Input bleibt gleich).
    const fastInput = mikro(preis.fast_input);
    const umrechnen = (r: bigint) => (rInput === 0n ? 0n : teileGerundet(r * fastInput, rInput));
    rRead = umrechnen(rRead);
    rWrite5m = umrechnen(rWrite5m);
    rWrite1h = umrechnen(rWrite1h);
    rInput = fastInput;
    rOutput = mikro(preis.fast_output);
  }

  // Summe in Mikro-USD · 10^6 (Tokens · Mikro-USD je MTok).
  const summe =
    nInput * rInput + nOutput * rOutput + nRead * rRead + nWrite5m * rWrite5m + nWrite1h * rWrite1h;
  const geoPromille =
    anfrage.inference_geo === 'us' ? BigInt(Math.round(preis.geo_us_faktor * 1000)) : 1000n;
  const usdMicros = teileGerundet(summe * geoPromille, 1_000_000n * 1000n);

  return { usdMicros: Number(usdMicros), preis, langkontext, fast };
}
