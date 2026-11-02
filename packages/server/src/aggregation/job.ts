// Tagesaggregat (Architektur §2.3, §3.1 `tag_aggregat`, §5): baut je Mandant und Tag die Summen je
// (tag, person, projekt, model, speed, auth_klasse) aus `anfrage` neu auf. Der Schattenpreis wird je
// Anfrage mit dem am Anfragetag gültigen Preis gerechnet (`schattenpreis` aus @seatmeter/shared) und
// summiert; `abo_anteil` bleibt 1,0 (Abzug der Überschreitung kommt mit dem Abgleich, ee/Phase 4).
import { schattenpreis, type AuthKlasse, type PreisZeile } from '@seatmeter/shared';
import { sql, type Insertable, type Transaction } from 'kysely';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank, TagAggregatTabelle } from '../db/schema.js';
import { aggregiereIssueMonate } from '../issues/aggregat.js';
import type { PluginKontext } from '../plugin.js';
import { ladeEffektivePreistabelle } from '../preise/tabelle.js';
import { aggregationSperren } from './sperre.js';
import { heuteIn, plusTage, tageZwischen } from './tage.js';

/** Fenster des nächtlichen Laufs: heute und die 34 Tage davor (35 Tage). */
export const AGGREGATION_TAGE = 35;

export interface AggregationErgebnis {
  tage: number;
  zeilen: number;
  anfragen: number;
  /** Anfragen ohne passende Preiszeile (Schattenpreis 0, Datenqualität). */
  ohne_preis: number;
  /** Neu aufgebaute Monate im Issue-Aggregat (`issue_aggregat`). */
  issue_monate: number;
}

function preisVersion(p: PreisZeile): string {
  return `${p.mandant_id === null ? 'global' : 'mandant'}:${p.modell_praefix}@${p.gueltig_ab}`;
}

interface Summe {
  werte: Insertable<TagAggregatTabelle> & {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cache_write_1h: number;
    web_search: number;
    anfragen: number;
    schatten_usd_micros: number;
  };
  versionen: Set<string>;
}

export type TagZeile = Summe['werte'] & { preis_version: string | null };

const JE_SEITE = 1_000;

interface AnfrageZeile {
  ts: Date;
  person_id: string | null;
  projekt_id: string | null;
  model: string;
  speed: string | null;
  inference_geo: string | null;
  auth_klasse: AuthKlasse;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number | null;
  web_search: number;
}

/**
 * Die Zeilen eines Tages aus `anfrage`, wie sie in `tag_aggregat` gehören. Einzige Rechnung für den nächtlichen und den
 * häufigen Lauf, damit beide dasselbe ergeben. Gezählt werden nur Anfragen mit `zaehlt_als_abo` (Architektur §4).
 */
export async function tagBerechnen(
  trx: Transaction<Datenbank>,
  mandantId: string,
  tag: string,
  preise: PreisZeile[],
  annahme: '5m' | '1h',
): Promise<{ zeilen: TagZeile[]; anfragen: number; ohne_preis: number }> {
  let anfragen = 0;
  let ohnePreis = 0;
  const gruppen = new Map<string, Summe>();
  // Seitenweise über einen Cursor: Hunderttausende Zeilen auf einmal hielten den Prozess an, in dem auch Push und Ingest laufen.
  await sql`
    DECLARE tag_anfragen NO SCROLL CURSOR FOR
    SELECT ts, person_id, projekt_id, model, speed, inference_geo, auth_klasse, input, output, cache_read, cache_write,
      cache_write_1h, web_search
    FROM anfrage WHERE tag = ${tag}::date AND zaehlt_als_abo`.execute(trx);
  for (;;) {
    const seite =
      await sql<AnfrageZeile>`FETCH ${sql.raw(String(JE_SEITE))} FROM tag_anfragen`.execute(trx);
    for (const a of seite.rows) {
      anfragen += 1;
      const speed = a.speed ?? 'normal';
      const schluessel = [a.person_id, a.projekt_id, a.model, speed, a.auth_klasse].join('|');
      let g = gruppen.get(schluessel);
      if (!g) {
        g = {
          werte: {
            mandant_id: mandantId,
            tag,
            person_id: a.person_id,
            projekt_id: a.projekt_id,
            model: a.model,
            speed,
            auth_klasse: a.auth_klasse,
            input: 0,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
            web_search: 0,
            anfragen: 0,
            schatten_usd_micros: 0,
            preis_version: null,
            abo_anteil: '1',
          },
          versionen: new Set(),
        };
        gruppen.set(schluessel, g);
      }
      const s = schattenpreis(
        {
          model: a.model,
          ts: a.ts,
          input: a.input,
          output: a.output,
          cache_read: a.cache_read,
          cache_write: a.cache_write,
          cache_write_1h: a.cache_write_1h,
          speed: a.speed,
          inference_geo: a.inference_geo,
        },
        preise,
        annahme,
      );
      const w = g.werte;
      w.input += a.input;
      w.output += a.output;
      w.cache_read += a.cache_read;
      w.cache_write += a.cache_write;
      // 1h-Anteil wie im Schattenpreis: bekannt (Quelle B) oder nach cache_write_annahme.
      w.cache_write_1h += a.cache_write_1h ?? (annahme === '1h' ? a.cache_write : 0);
      w.web_search += a.web_search;
      w.anfragen += 1;
      if (s) {
        w.schatten_usd_micros += s.usdMicros;
        g.versionen.add(preisVersion(s.preis));
      } else {
        ohnePreis += 1;
      }
    }
    if (seite.rows.length < JE_SEITE) break;
  }
  await sql`CLOSE tag_anfragen`.execute(trx);
  return {
    zeilen: [...gruppen.values()].map((g) => ({
      ...g.werte,
      preis_version: g.versionen.size > 0 ? [...g.versionen].sort().join(',') : null,
    })),
    anfragen,
    ohne_preis: ohnePreis,
  };
}

/**
 * Baut `tag_aggregat` für die Tage `von` bis `bis` (Mandanten-Zeitzone, einschließlich) neu auf.
 * Je Tag eine Transaktion: alte Zeilen des Tages löschen, neue schreiben.
 */
export async function aggregiereTage(
  db: Db,
  mandantId: string,
  von: string,
  bis: string,
): Promise<AggregationErgebnis> {
  const { preise, annahme } = await withMandant(db, mandantId, async (trx) => {
    const m = await trx
      .selectFrom('mandant')
      .select('cache_write_annahme')
      .executeTakeFirstOrThrow();
    return { preise: await ladeEffektivePreistabelle(trx), annahme: m.cache_write_annahme };
  });
  const ergebnis: AggregationErgebnis = {
    tage: 0,
    zeilen: 0,
    anfragen: 0,
    ohne_preis: 0,
    issue_monate: 0,
  };

  for (const tag of tageZwischen(von, bis)) {
    await withMandant(db, mandantId, async (trx) => {
      await aggregationSperren(trx, mandantId);
      const t = await tagBerechnen(trx, mandantId, tag, preise, annahme);
      await trx.deleteFrom('tag_aggregat').where('tag', '=', tag).execute();
      for (let i = 0; i < t.zeilen.length; i += 500) {
        await trx
          .insertInto('tag_aggregat')
          .values(t.zeilen.slice(i, i + 500))
          .execute();
      }
      ergebnis.tage += 1;
      ergebnis.zeilen += t.zeilen.length;
      ergebnis.anfragen += t.anfragen;
      ergebnis.ohne_preis += t.ohne_preis;
    });
  }
  // Issue-Aggregat je berührtem Monat (nur Monate, deren Einzelanfragen noch vollständig vorliegen).
  const { ab } = await aeltesterNeuaufbauTag(db, mandantId);
  const issues = await aggregiereIssueMonate(db, mandantId, von, bis, { preise, annahme, ab });
  ergebnis.issue_monate = issues.monate.length;
  return ergebnis;
}

/** Ältester Tag, den ein Neuaufbau anfassen darf: davor können Einzelanfragen gelöscht sein. */
export async function aeltesterNeuaufbauTag(
  db: Db,
  mandantId: string,
): Promise<{ heute: string; ab: string }> {
  return withMandant(db, mandantId, async (trx) => {
    const m = await trx
      .selectFrom('mandant')
      .select(['zeitzone', 'aufbewahrung_anfrage_tage'])
      .executeTakeFirstOrThrow();
    const heute = heuteIn(m.zeitzone);
    return { heute, ab: plusTage(heute, -(m.aufbewahrung_anfrage_tage - 1)) };
  });
}

/** Job `aggregation.tag`: alle Mandanten, letzte 35 Tage. */
export async function aggregationTagJob(
  ctx: PluginKontext,
  jetzt: Date = new Date(),
): Promise<{ mandanten: number } & AggregationErgebnis> {
  // Mandantenliste als Eigentümer (Systemjob); die Arbeit selbst läuft je Mandant mit RLS.
  const mandanten = await ctx.db.selectFrom('mandant').select(['id', 'zeitzone']).execute();
  const summe = { mandanten: 0, tage: 0, zeilen: 0, anfragen: 0, ohne_preis: 0, issue_monate: 0 };
  for (const m of mandanten) {
    const bis = heuteIn(m.zeitzone, jetzt);
    const e = await aggregiereTage(ctx.db, m.id, plusTage(bis, -(AGGREGATION_TAGE - 1)), bis);
    summe.mandanten += 1;
    summe.tage += e.tage;
    summe.zeilen += e.zeilen;
    summe.anfragen += e.anfragen;
    summe.ohne_preis += e.ohne_preis;
    summe.issue_monate += e.issue_monate;
  }
  return summe;
}
