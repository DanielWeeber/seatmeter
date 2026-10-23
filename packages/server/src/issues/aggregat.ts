// Monatsaggregat je Issue-Schlüssel (Tabelle `issue_aggregat`): Summen je (Monat, Projekt,
// Schlüssel) aus `anfrage`, nur Abo-Nutzung. Eine Anfrage mit n Schlüsseln (Branch `ABC-1/ABC-2`) zählt
// zu je 1/n (ganzzahlig, Rest an die ersten Schlüssel); `sitzungen` = verschiedene Sitzungen im Monat.
// Aufgerufen vom Tagesaggregat (`aggregiereTage`) für jeden berührten Monat.
import { aufteilen, schattenpreis, schluesselFiltern, type PreisZeile } from '@seatmeter/shared';
import { sql, type Insertable } from 'kysely';
import { monatsGrenzen } from '../aggregation/tage.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { IssueAggregatTabelle } from '../db/schema.js';

export interface IssueAggregatErgebnis {
  /** Neu aufgebaute Monate (`JJJJ-MM`). */
  monate: string[];
  /** Monate, deren Beginn vor der Anfrage-Aufbewahrung liegt (Stand bleibt eingefroren). */
  eingefroren: string[];
  zeilen: number;
}

export interface IssueAggregatOptionen {
  preise: PreisZeile[];
  annahme: '5m' | '1h';
  /** Ältester Tag mit vollständigen Einzelanfragen (Aufbewahrung). */
  ab: string;
}

/** Monate `JJJJ-MM`, die der Zeitraum `von`..`bis` berührt. */
export function monateZwischen(von: string, bis: string): string[] {
  const aus: string[] = [];
  let m = von.slice(0, 7);
  const ende = bis.slice(0, 7);
  while (m <= ende) {
    aus.push(m);
    const [j, mo] = m.split('-').map(Number) as [number, number];
    m = new Date(Date.UTC(j, mo, 1)).toISOString().slice(0, 7);
  }
  return aus;
}

type Zeile = Insertable<IssueAggregatTabelle> & {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  web_search: number;
  anfragen: number;
  schatten_usd_micros: number;
};

/**
 * Baut `issue_aggregat` für alle Monate neu auf, die `von`..`bis` berührt. Ein Monat wird nur neu
 * aufgebaut, wenn alle seine Einzelanfragen noch vorliegen (Monatsbeginn ≥ `ab`); sonst bleibt sein
 * Stand stehen. Je Monat eine Transaktion: Zeilen löschen, neu schreiben.
 */
export async function aggregiereIssueMonate(
  db: Db,
  mandantId: string,
  von: string,
  bis: string,
  o: IssueAggregatOptionen,
): Promise<IssueAggregatErgebnis> {
  const ergebnis: IssueAggregatErgebnis = { monate: [], eingefroren: [], zeilen: 0 };
  for (const monat of monateZwischen(von, bis)) {
    const g = monatsGrenzen(monat);
    if (g.von < o.ab) {
      ergebnis.eingefroren.push(monat);
      continue;
    }
    await withMandant(db, mandantId, async (trx) => {
      const m = await trx.selectFrom('mandant').select('issue_praefixe').executeTakeFirstOrThrow();
      const anfragen = await trx
        .selectFrom('anfrage')
        .select([
          'ts',
          'session_id',
          'projekt_id',
          'model',
          'speed',
          'inference_geo',
          'input',
          'output',
          'cache_read',
          'cache_write',
          'cache_write_1h',
          'web_search',
          'issue_schluessel',
        ])
        .where('tag', '>=', g.von)
        .where('tag', '<', g.bisExklusiv)
        .where('zaehlt_als_abo', '=', true)
        .where(sql<boolean>`cardinality(issue_schluessel) > 0`)
        .execute();

      const gruppen = new Map<string, { zeile: Zeile; sitzungen: Set<string> }>();
      for (const a of anfragen) {
        const schluessel = schluesselFiltern(a.issue_schluessel ?? [], m.issue_praefixe);
        if (schluessel.length === 0) continue;
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
          o.preise,
          o.annahme,
        );
        const n = schluessel.length;
        const teile = {
          input: aufteilen(a.input, n),
          output: aufteilen(a.output, n),
          cache_read: aufteilen(a.cache_read, n),
          cache_write: aufteilen(a.cache_write, n),
          // 1h-Anteil wie im Tagesaggregat: bekannt (Quelle B) oder nach cache_write_annahme.
          cache_write_1h: aufteilen(
            a.cache_write_1h ?? (o.annahme === '1h' ? a.cache_write : 0),
            n,
          ),
          web_search: aufteilen(a.web_search, n),
          schatten: aufteilen(s?.usdMicros ?? 0, n),
        };
        schluessel.forEach((k, i) => {
          const id = `${a.projekt_id ?? ''}|${k}`;
          let gr = gruppen.get(id);
          if (!gr) {
            gr = {
              zeile: {
                mandant_id: mandantId,
                monat: g.von,
                projekt_id: a.projekt_id,
                schluessel: k,
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: 0,
                web_search: 0,
                anfragen: 0,
                schatten_usd_micros: 0,
              },
              sitzungen: new Set(),
            };
            gruppen.set(id, gr);
          }
          const z = gr.zeile;
          z.input += teile.input[i] ?? 0;
          z.output += teile.output[i] ?? 0;
          z.cache_read += teile.cache_read[i] ?? 0;
          z.cache_write += teile.cache_write[i] ?? 0;
          z.cache_write_1h += teile.cache_write_1h[i] ?? 0;
          z.web_search += teile.web_search[i] ?? 0;
          z.schatten_usd_micros += teile.schatten[i] ?? 0;
          z.anfragen += 1;
          if (a.session_id) gr.sitzungen.add(a.session_id);
        });
      }

      await trx.deleteFrom('issue_aggregat').where('monat', '=', g.von).execute();
      const zeilen = [...gruppen.values()].map((gr) => ({
        ...gr.zeile,
        sitzungen: gr.sitzungen.size,
      }));
      for (let i = 0; i < zeilen.length; i += 500) {
        await trx
          .insertInto('issue_aggregat')
          .values(zeilen.slice(i, i + 500))
          .execute();
      }
      ergebnis.monate.push(monat);
      ergebnis.zeilen += zeilen.length;
    });
  }
  return ergebnis;
}
