// Job `hinweise.erzeugen` (täglich): Projekt-Hinweise des laufenden Monats je Mandant neu berechnen.
// Ein Hinweis je (Monat, Projekt, Typ): vorhandene werden aktualisiert (Text, Wert), erledigte bleiben
// erledigt; offene Hinweise, deren Regel nicht mehr greift, werden gelöscht.
import {
  hinweisRegelnSchema,
  schattenpreis,
  type Hinweis,
  type HinweisRegeln,
  type HinweisTyp,
} from '@seatmeter/shared';
import { heuteIn, monatsGrenzen } from '../aggregation/tage.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import { kalkuliereMonat } from '../kalkulation/rechnen.js';
import type { PluginKontext } from '../plugin.js';
import { ladeEffektivePreistabelle } from '../preise/tabelle.js';
import { sql, type Transaction } from 'kysely';
import { berechneStaende, budgetName, einheit, ladeBudgets } from '../budgets/stand.js';
import { erzeugeHinweise, type ProjektSummen } from './regeln.js';

type Trx = Transaction<Datenbank>;

export async function ladeRegeln(trx: Trx): Promise<HinweisRegeln> {
  const z = await trx.selectFrom('ee_einstellung').select('hinweise').executeTakeFirst();
  return hinweisRegelnSchema.parse(z?.hinweise ?? {});
}

/** Monatssummen je Projekt aus `tag_aggregat` (nur Abo-Zeilen). */
export async function projektSummen(trx: Trx, monat: string): Promise<ProjektSummen[]> {
  const { von, bisExklusiv } = monatsGrenzen(monat);
  const m = await trx.selectFrom('mandant').select('cache_write_annahme').executeTakeFirstOrThrow();
  const tabelle = await ladeEffektivePreistabelle(trx);
  const zeilen = await trx
    .selectFrom('tag_aggregat')
    .select([
      'tag',
      'projekt_id',
      'model',
      'speed',
      'cache_write',
      'cache_write_1h',
      'schatten_usd_micros',
      'preis_version',
    ])
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .execute();
  const je = new Map<string, ProjektSummen>();
  for (const z of zeilen) {
    const k = z.projekt_id ?? '';
    const s =
      je.get(k) ??
      ({
        projektId: z.projekt_id,
        schattenUsdMicros: 0,
        cacheWriteUsdMicros: 0,
        fastUsdMicros: 0,
        opusUsdMicros: 0,
        modelleOhnePreis: [],
      } satisfies ProjektSummen);
    const schatten = Number(z.schatten_usd_micros);
    s.schattenUsdMicros += schatten;
    if (z.speed === 'fast') s.fastUsdMicros += schatten;
    if (/^claude-opus/i.test(z.model)) s.opusUsdMicros += schatten;
    if (!z.preis_version) {
      if (!s.modelleOhnePreis.includes(z.model)) s.modelleOhnePreis.push(z.model);
    } else if (Number(z.cache_write) > 0) {
      const cw = schattenpreis(
        {
          model: z.model,
          ts: z.tag,
          input: 0,
          output: 0,
          cache_read: 0,
          cache_write: Number(z.cache_write),
          cache_write_1h: Math.min(Number(z.cache_write_1h), Number(z.cache_write)),
          speed: z.speed,
        },
        tabelle,
        m.cache_write_annahme,
      );
      s.cacheWriteUsdMicros += cw?.usdMicros ?? 0;
    }
    je.set(k, s);
  }
  return [...je.values()];
}

export interface HinweisLauf {
  monat: string;
  hinweise: number;
  neu: number;
  entfernt: number;
}

/** Berechnet die Hinweise eines Monats für den Mandanten der Transaktion neu. */
export async function hinweiseErzeugen(
  trx: Trx,
  monat: string,
  jetzt: Date = new Date(),
): Promise<HinweisLauf> {
  const regeln = await ladeRegeln(trx);
  const projekte = await projektSummen(trx, monat);
  const kalk = await kalkuliereMonat(trx, monat, null, jetzt);
  const ungenutzt = kalk.zeilen.find((z) => z.topf === 'ungenutzt')?.projektpreis_usd_micros ?? 0;
  const budgets = await ladeBudgets(trx, null, true);
  const staende = await berechneStaende(trx, monat, budgets, jetzt);
  const neu = erzeugeHinweise({
    projekte,
    ungenutztUsdMicros: ungenutzt,
    regeln,
    budgets: budgets.flatMap((b) => {
      const s = staende.get(b.id);
      return s?.prognose === null || s?.prognose === undefined
        ? []
        : [
            {
              projektId: b.projekt_id,
              name: budgetName(b),
              betrag: b.betrag,
              prognose: s.prognose,
              einheit: einheit(b),
            },
          ];
    }),
  });

  const monatTag = `${monat}-01`;
  let angelegt = 0;
  for (const h of neu) {
    const r = await trx
      .insertInto('hinweis')
      .values({
        mandant_id: sql<string>`app_mandant_id()`,
        monat: monatTag,
        projekt_id: h.projektId,
        typ: h.typ,
        text: h.text,
        wert: h.wert,
      })
      .onConflict((oc) =>
        oc.columns(['mandant_id', 'monat', 'projekt_id', 'typ']).doUpdateSet({
          text: h.text,
          wert: h.wert,
          aktualisiert: jetzt,
        }),
      )
      .returning(sql<boolean>`(xmax = 0)`.as('eingefuegt'))
      .executeTakeFirstOrThrow();
    if (r.eingefuegt) angelegt += 1;
  }
  const behalten = new Set(neu.map((h) => `${h.projektId ?? ''}|${h.typ}`));
  const offen = await trx
    .selectFrom('hinweis')
    .select(['id', 'projekt_id', 'typ'])
    .where('monat', '=', monatTag)
    .where('erledigt', 'is', null)
    .execute();
  const weg = offen.filter((o) => !behalten.has(`${o.projekt_id ?? ''}|${o.typ}`)).map((o) => o.id);
  if (weg.length) await trx.deleteFrom('hinweis').where('id', 'in', weg).execute();
  return { monat, hinweise: neu.length, neu: angelegt, entfernt: weg.length };
}

/** Job über alle Mandanten: laufender Monat in der Mandanten-Zeitzone. */
export async function hinweiseJob(ctx: PluginKontext, jetzt: Date = new Date()) {
  const mandanten = await ctx.db.selectFrom('mandant').select(['id', 'zeitzone']).execute();
  const summe = { mandanten: 0, hinweise: 0, neu: 0, entfernt: 0 };
  for (const m of mandanten) {
    const monat = heuteIn(m.zeitzone, jetzt).slice(0, 7);
    const r = await withMandant(ctx.db, m.id, (trx) => hinweiseErzeugen(trx, monat, jetzt));
    summe.mandanten += 1;
    summe.hinweise += r.hinweise;
    summe.neu += r.neu;
    summe.entfernt += r.entfernt;
  }
  return summe;
}

export function hinweisDto(z: {
  id: string;
  monat: string;
  projekt_id: string | null;
  projekt_name: string | null;
  typ: string;
  text: string;
  wert: string | null;
  erstellt: Date;
  aktualisiert: Date;
  erledigt: Date | null;
}): Hinweis {
  return {
    id: z.id,
    monat: z.monat.slice(0, 7),
    projekt_id: z.projekt_id,
    projekt_name: z.projekt_name,
    typ: z.typ as HinweisTyp,
    text: z.text,
    wert: z.wert === null ? null : Number(z.wert),
    erstellt: new Date(z.erstellt).toISOString(),
    aktualisiert: new Date(z.aktualisiert).toISOString(),
    erledigt: z.erledigt ? new Date(z.erledigt).toISOString() : null,
  };
}
