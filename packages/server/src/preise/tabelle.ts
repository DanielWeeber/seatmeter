// Preistabelle aus der DB (Architektur §2.5): Abbildung Tabelle `preis` ↔ `PreisZeile` aus
// @seatmeter/shared, Seed der globalen Zeilen und effektive Tabelle je Mandant.
import { PREIS_SEED, type PreisZeile, type PreisSaetze } from '@seatmeter/shared';
import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Datenbank, PreisTabelle } from '../db/schema.js';

export type PreisDbZeile = Selectable<PreisTabelle>;

const zahl = (wert: string | number): number => Number(wert);
const zahlOderNull = (wert: string | number | null): number | null =>
  wert === null ? null : Number(wert);

export function zeileAusDb(z: PreisDbZeile): PreisZeile {
  const lang: PreisSaetze | null =
    z.lang_input !== null &&
    z.lang_output !== null &&
    z.lang_cache_read !== null &&
    z.lang_cache_write_5m !== null &&
    z.lang_cache_write_1h !== null
      ? {
          input: zahl(z.lang_input),
          output: zahl(z.lang_output),
          cache_read: zahl(z.lang_cache_read),
          cache_write_5m: zahl(z.lang_cache_write_5m),
          cache_write_1h: zahl(z.lang_cache_write_1h),
        }
      : null;
  return {
    mandant_id: z.mandant_id,
    modell_praefix: z.modell_praefix,
    gueltig_ab: z.gueltig_ab,
    saetze: {
      input: zahl(z.input),
      output: zahl(z.output),
      cache_read: zahl(z.cache_read),
      cache_write_5m: zahl(z.cache_write_5m),
      cache_write_1h: zahl(z.cache_write_1h),
    },
    fast_input: zahlOderNull(z.fast_input),
    fast_output: zahlOderNull(z.fast_output),
    prompt_schwelle_tokens: z.prompt_schwelle_tokens,
    lang,
    geo_us_faktor: zahl(z.geo_us_faktor),
    quelle_url: z.quelle_url,
    geprueft_am: z.geprueft_am,
  };
}

/** Spaltenwerte für INSERT/UPDATE aus einer `PreisZeile` (ohne id). */
export function dbWerte(z: PreisZeile): Omit<Insertable<PreisTabelle>, 'id'> {
  return {
    mandant_id: z.mandant_id,
    modell_praefix: z.modell_praefix.trim().toLowerCase(),
    gueltig_ab: z.gueltig_ab,
    input: z.saetze.input,
    output: z.saetze.output,
    cache_read: z.saetze.cache_read,
    cache_write_5m: z.saetze.cache_write_5m,
    cache_write_1h: z.saetze.cache_write_1h,
    fast_input: z.fast_input,
    fast_output: z.fast_output,
    prompt_schwelle_tokens: z.prompt_schwelle_tokens,
    lang_input: z.lang?.input ?? null,
    lang_output: z.lang?.output ?? null,
    lang_cache_read: z.lang?.cache_read ?? null,
    lang_cache_write_5m: z.lang?.cache_write_5m ?? null,
    lang_cache_write_1h: z.lang?.cache_write_1h ?? null,
    geo_us_faktor: z.geo_us_faktor,
    quelle_url: z.quelle_url,
    geprueft_am: z.geprueft_am,
  };
}

/**
 * Upsert der globalen Startwerte (mandant_id NULL) aus `PREIS_SEED`. Läuft als Eigentümer, weil die
 * Anwendungsrolle globale Zeilen nicht schreiben darf; Mandanten-Zeilen bleiben unberührt.
 */
export async function preiseSeedEinspielen(db: Kysely<Datenbank>): Promise<number> {
  let anzahl = 0;
  for (const zeile of PREIS_SEED) {
    const werte = dbWerte(zeile);
    // Schlüsselspalten bleiben, alle Sätze werden auf den Seed-Stand gebracht.
    const { mandant_id: _m, modell_praefix: _p, gueltig_ab: _g, ...saetze } = werte;
    await db
      .insertInto('preis')
      .values(werte)
      .onConflict((oc) =>
        oc.columns(['mandant_id', 'modell_praefix', 'gueltig_ab']).doUpdateSet(saetze),
      )
      .execute();
    anzahl++;
  }
  return anzahl;
}

/** Präfixe ohne Groß-/Kleinschreibung. */
const schluessel = (praefix: string) => praefix.trim().toLowerCase();

/**
 * Effektive Tabelle eines Mandanten: Hat der Mandant für einen Präfix eigene Zeilen, entfallen die
 * globalen Zeilen dieses Präfixes (alle `gueltig_ab`). Danach gilt `findePreis` (längster Präfix).
 */
export function effektivePreistabelle<T extends Pick<PreisZeile, 'mandant_id' | 'modell_praefix'>>(
  zeilen: readonly T[],
): T[] {
  const eigene = new Set(
    zeilen.filter((z) => z.mandant_id !== null).map((z) => schluessel(z.modell_praefix)),
  );
  return zeilen.filter((z) => z.mandant_id !== null || !eigene.has(schluessel(z.modell_praefix)));
}

/** Liest globale und eigene Zeilen (RLS: Policy `preis_lesen`) innerhalb von `withMandant`. */
export async function ladePreiszeilen(trx: Kysely<Datenbank>): Promise<PreisDbZeile[]> {
  return trx
    .selectFrom('preis')
    .selectAll()
    .orderBy('modell_praefix')
    .orderBy('gueltig_ab')
    .execute();
}

/** Effektive Preistabelle des Mandanten der Transaktion für `schattenpreis`. */
export async function ladeEffektivePreistabelle(trx: Kysely<Datenbank>): Promise<PreisZeile[]> {
  return effektivePreistabelle((await ladePreiszeilen(trx)).map(zeileAusDb));
}
