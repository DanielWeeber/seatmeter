// Wechselkurs je Mandant und Monat (Architektur §0 „EZB-Monatsmittel“, §3.1 `kurs`, §5).
// Quelle `ezb`: EZB Data API, Reihe EXR (USD je 1 EUR); gespeichert wird der Kehrwert `usd_eur`
// (EUR je 1 USD, 6 Nachkommastellen). Das Monatsmittel (Frequenz M) ist endgültig; fehlt es noch
// (laufender Monat, Vormonat kurz nach Monatsende), gilt das Mittel der bisherigen Tageskurse
// (Frequenz D) als „vorläufig“. Quelle `manuell` (Mandanten-Admin) geht immer vor und wird vom
// EZB-Abruf nie überschrieben; ein endgültiger EZB-Wert wird nie durch einen vorläufigen ersetzt.
import type { Kurs } from '@seatmeter/shared';
import { sql, type Transaction } from 'kysely';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import { heuteIn } from '../aggregation/tage.js';

type Trx = Transaction<Datenbank>;

export const EZB_BASIS = 'https://data-api.ecb.europa.eu/service/data/EXR';
export const EZB_MONAT_URL = `${EZB_BASIS}/M.USD.EUR.SP00.A?format=jsondata&lastNObservations=3`;
export const ezbTagUrl = (ab: string) =>
  `${EZB_BASIS}/D.USD.EUR.SP00.A?format=jsondata&startPeriod=${ab}`;

export type FetchFunktion = (url: string, init?: RequestInit) => Promise<Response>;

/** Monat `JJJJ-MM` → Tabellenschlüssel `JJJJ-MM-01`. */
export const monatsTag = (monat: string) => `${monat}-01`;

/** Monat um `delta` Monate verschoben (`JJJJ-MM`). */
export function plusMonate(monat: string, delta: number): string {
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(jahr, mon - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Liest eine SDMX-JSON-Antwort der EZB (`format=jsondata`): Zeitraum-ID (`JJJJ-MM` bzw.
 * `JJJJ-MM-TT`) → Wert der ersten Reihe. Wirft bei unbekanntem Aufbau.
 */
export function leseEzbReihe(json: unknown): Map<string, number> {
  const j = json as {
    dataSets?: { series?: Record<string, { observations?: Record<string, unknown[]> }> }[];
    structure?: { dimensions?: { observation?: { id?: string; values?: { id?: string }[] }[] } };
  };
  const reihen = j.dataSets?.[0]?.series;
  const zeiten = j.structure?.dimensions?.observation?.[0]?.values;
  if (!reihen || !zeiten) throw new Error('EZB-Antwort ohne dataSets/series bzw. Zeitdimension');
  const reihe = Object.values(reihen)[0];
  const aus = new Map<string, number>();
  for (const [index, beobachtung] of Object.entries(reihe?.observations ?? {})) {
    const zeit = zeiten[Number(index)]?.id;
    const wert = beobachtung[0];
    if (typeof zeit === 'string' && typeof wert === 'number' && Number.isFinite(wert) && wert > 0) {
      aus.set(zeit, wert);
    }
  }
  return aus;
}

export interface EzbMonatskurs {
  /** EUR je 1 USD, auf 6 Nachkommastellen gerundet. */
  usdEur: number;
  vorlaeufig: boolean;
}

const kehrwert = (usdJeEur: number) => Math.round((1 / usdJeEur) * 1_000_000) / 1_000_000;

async function ladeJson(fetchFn: FetchFunktion, url: string): Promise<unknown | null> {
  const antwort = await fetchFn(url, { headers: { accept: 'application/json' } });
  // 404 = keine Beobachtungen im Zeitraum (z. B. früh am Monatsersten).
  if (antwort.status === 404) return null;
  if (!antwort.ok) throw new Error(`EZB antwortet mit Status ${antwort.status}`);
  return antwort.json();
}

/**
 * Holt die Monatsmittel der letzten drei Monate (endgültig) und die Tageskurse ab dem Vormonat
 * (Mittel je Monat, vorläufig, nur wo das Monatsmittel noch fehlt).
 */
export async function holeEzbKurse(
  fetchFn: FetchFunktion,
  jetzt: Date = new Date(),
): Promise<Map<string, EzbMonatskurs>> {
  const laufend = jetzt.toISOString().slice(0, 7);
  const monate = await ladeJson(fetchFn, EZB_MONAT_URL);
  const tage = await ladeJson(fetchFn, ezbTagUrl(monatsTag(plusMonate(laufend, -1))));
  const aus = new Map<string, EzbMonatskurs>();

  const summen = new Map<string, { summe: number; n: number }>();
  for (const [tag, wert] of tage ? leseEzbReihe(tage) : new Map<string, number>()) {
    const s = summen.get(tag.slice(0, 7)) ?? { summe: 0, n: 0 };
    s.summe += wert;
    s.n += 1;
    summen.set(tag.slice(0, 7), s);
  }
  for (const [monat, s] of summen) {
    aus.set(monat, { usdEur: kehrwert(s.summe / s.n), vorlaeufig: true });
  }
  for (const [monat, wert] of monate ? leseEzbReihe(monate) : new Map<string, number>()) {
    aus.set(monat.slice(0, 7), { usdEur: kehrwert(wert), vorlaeufig: false });
  }
  return aus;
}

export interface KursAbrufErgebnis {
  mandanten: number;
  monate: number;
  geschrieben: number;
}

/**
 * Schreibt die EZB-Kurse für die Mandanten (Standard: alle) per Upsert. Manuelle Kurse bleiben,
 * endgültige EZB-Werte werden nicht durch vorläufige ersetzt.
 */
export async function kursEzbAktualisieren(
  db: Db,
  optionen: { fetch?: FetchFunktion; jetzt?: Date; mandanten?: string[] } = {},
): Promise<KursAbrufErgebnis> {
  const kurse = await holeEzbKurse(
    optionen.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    optionen.jetzt,
  );
  // Mandantenliste als Eigentümer (Systemjob); geschrieben wird je Mandant mit RLS.
  const mandanten =
    optionen.mandanten ?? (await db.selectFrom('mandant').select('id').execute()).map((m) => m.id);
  let geschrieben = 0;
  for (const mandantId of mandanten) {
    await withMandant(db, mandantId, async (trx) => {
      for (const [monat, k] of kurse) {
        const r = await trx
          .insertInto('kurs')
          .values({
            mandant_id: mandantId,
            monat: monatsTag(monat),
            usd_eur: k.usdEur.toFixed(6),
            quelle: 'ezb',
            vorlaeufig: k.vorlaeufig,
            aktualisiert: new Date(),
          })
          .onConflict((oc) =>
            oc
              .columns(['mandant_id', 'monat'])
              .doUpdateSet({
                usd_eur: k.usdEur.toFixed(6),
                vorlaeufig: k.vorlaeufig,
                aktualisiert: new Date(),
              })
              .where(
                sql<boolean>`kurs.quelle = 'ezb' AND (kurs.vorlaeufig OR NOT ${k.vorlaeufig})`,
              ),
          )
          .executeTakeFirst();
        geschrieben += Number(r.numInsertedOrUpdatedRows ?? 0);
      }
    });
  }
  return { mandanten: mandanten.length, monate: kurse.size, geschrieben };
}

/** Kurs eines Monats (`JJJJ-MM`) im Mandanten der Transaktion; ohne Zeile `usd_eur: null`. */
export async function ladeKurs(trx: Trx, monat: string): Promise<Kurs> {
  const z = await trx
    .selectFrom('kurs')
    .select(['usd_eur', 'quelle', 'vorlaeufig', 'aktualisiert'])
    .where('monat', '=', monatsTag(monat))
    .executeTakeFirst();
  if (!z) return { monat, usd_eur: null, quelle: null, vorlaeufig: false, aktualisiert: null };
  return {
    monat,
    usd_eur: Number(z.usd_eur),
    quelle: z.quelle,
    vorlaeufig: z.vorlaeufig,
    aktualisiert: new Date(z.aktualisiert).toISOString(),
  };
}

/** Alle Kurse des Mandanten, neuester Monat zuerst (höchstens 36). */
export async function ladeKurse(trx: Trx): Promise<Kurs[]> {
  const zeilen = await trx
    .selectFrom('kurs')
    .select(['monat', 'usd_eur', 'quelle', 'vorlaeufig', 'aktualisiert'])
    .orderBy('monat', 'desc')
    .limit(36)
    .execute();
  return zeilen.map((z) => ({
    monat: z.monat.slice(0, 7),
    usd_eur: Number(z.usd_eur),
    quelle: z.quelle,
    vorlaeufig: z.vorlaeufig,
    aktualisiert: new Date(z.aktualisiert).toISOString(),
  }));
}

/** Laufender Monat in der Zeitzone. */
export const laufenderMonat = (zeitzone: string, jetzt?: Date) =>
  heuteIn(zeitzone, jetzt).slice(0, 7);
