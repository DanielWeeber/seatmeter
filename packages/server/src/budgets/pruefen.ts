// Job `budgets.pruefen` (stündlich): je Mandant und aktivem Budget Verbrauch bzw. Prognose des laufenden
// Monats gegen die Schwellen prüfen. Je (Budget, Periode, Schwelle) entsteht höchstens ein Alarm
// (UNIQUE + ON CONFLICT DO NOTHING), auch über wiederholte Läufe und nach dem Quittieren. Zugestellt wird
// nach dem Anlegen über alle aktiven Kanäle; Fehlschläge werden bis zu 5-mal in späteren Läufen wiederholt.
import type { Alarm } from '@seatmeter/shared';
import { heuteIn } from '../aggregation/tage.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import type { PluginKontext } from '../plugin.js';
import { sql, type Transaction } from 'kysely';
import {
  kanalDaten,
  ladeKanaele,
  zustellen,
  ZustellFehler,
  type AlarmNachricht,
  type KanalDaten,
  type ZustellOptionen,
} from './kanal.js';
import { erreichteSchwellen } from './prognose.js';
import { berechneStaende, budgetName, einheit, ladeBudgets } from './stand.js';

type Trx = Transaction<Datenbank>;
export const MAX_ZUSTELLVERSUCHE = 5;

export interface PruefErgebnis {
  mandanten: number;
  budgets: number;
  neue_alarme: number;
  zugestellt: number;
  fehler: number;
  ohne_kanal: number;
}

function zahlText(wert: number, einheitText: string): string {
  const text = new Intl.NumberFormat('de-DE', {
    maximumFractionDigits: einheitText === 'Tokens' ? 0 : 2,
    minimumFractionDigits: einheitText === 'Tokens' ? 0 : 2,
  }).format(wert);
  return einheitText === 'EUR'
    ? `${text} €`
    : einheitText === 'USD'
      ? `${text} $`
      : `${text} Tokens`;
}

export function alarmDto(z: {
  id: string;
  budget_id: string;
  bezeichnung: string | null;
  projekt_id: string | null;
  projekt_name: string | null;
  basis: 'projektpreis' | 'tokens';
  waehrung: string;
  periode: string;
  schwelle: number;
  prozent: string | null;
  wert: string;
  betrag: string | null;
  ausgeloest: Date;
  quittiert: Date | null;
  zustellung: Alarm['zustellung'];
  zustellfehler: string | null;
}): Alarm {
  return {
    id: z.id,
    budget_id: z.budget_id,
    budget_name: budgetName(z),
    projekt_id: z.projekt_id,
    monat: z.periode.slice(0, 7),
    schwelle: z.schwelle,
    prozent: z.prozent === null ? null : Number(z.prozent),
    wert: Number(z.wert),
    betrag: z.betrag === null ? null : Number(z.betrag),
    einheit: einheit({ basis: z.basis, waehrung: z.waehrung === 'USD' ? 'USD' : 'EUR' }),
    ausgeloest: new Date(z.ausgeloest).toISOString(),
    quittiert: z.quittiert ? new Date(z.quittiert).toISOString() : null,
    zustellung: z.zustellung,
    zustellfehler: z.zustellfehler,
  };
}

/** Alarme mit Budget- und Projektangaben (für Liste, Quittieren und Zustellung). */
export function alarmAbfrage(trx: Trx) {
  return trx
    .selectFrom('alarm as a')
    .innerJoin('budget as b', 'b.id', 'a.budget_id')
    .leftJoin('projekt as p', 'p.id', 'b.projekt_id')
    .select([
      'a.id',
      'a.budget_id',
      'b.bezeichnung',
      'b.projekt_id',
      sql<
        string | null
      >`coalesce(p.anzeigename, p.owner || '/' || p.repo_name, p.repo_name, p.url_norm)`.as(
        'projekt_name',
      ),
      'b.basis',
      'b.waehrung',
      'a.periode',
      'a.schwelle',
      'a.prozent',
      'a.wert',
      'a.betrag',
      'a.prognose',
      'a.ausgeloest',
      'a.quittiert',
      'a.zustellung',
      'a.zustellfehler',
      'a.zustellversuche',
    ]);
}

export function nachrichtFuer(
  a: Alarm,
  prognose: number | null,
  publicUrl: string | undefined,
): AlarmNachricht {
  const link = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/budgets?monat=${a.monat}` : null;
  const zeilen = [
    `Budget: ${a.budget_name}, Monat ${a.monat}`,
    `Verbrauch: ${zahlText(a.wert, a.einheit)}${a.betrag !== null ? ` von ${zahlText(a.betrag, a.einheit)}` : ''}${a.prozent !== null ? ` (${a.prozent.toLocaleString('de-DE')} %)` : ''}`,
  ];
  if (prognose !== null) zeilen.push(`Prognose Monatsende: ${zahlText(prognose, a.einheit)}`);
  zeilen.push('Du: im Dashboard prüfen und quittieren');
  return {
    schluessel: `seatmeter|budget|${a.budget_id}|${a.monat}|${a.schwelle}`,
    titel: `Budget-Alarm ${a.schwelle} %`,
    zeilen,
    link,
    daten: { alarm: a, prognose },
  };
}

/** Legt fehlende Alarme des laufenden Monats an; Rückgabe: Anzahl Budgets und neue Alarme. */
export async function alarmeAnlegen(
  trx: Trx,
  jetzt: Date,
): Promise<{ budgets: number; neu: number }> {
  const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
  const monat = heuteIn(m.zeitzone, jetzt).slice(0, 7);
  const budgets = await ladeBudgets(trx, null, true);
  const staende = await berechneStaende(trx, monat, budgets, jetzt);
  let neu = 0;
  for (const b of budgets) {
    const s = staende.get(b.id);
    if (!s || s.verbrauch === null) continue;
    const mess = b.ausloeser === 'prognose' ? s.prognose_prozent : s.prozent;
    if (mess === null) continue;
    for (const schwelle of erreichteSchwellen(mess, b.schwellen)) {
      const angelegt = await trx
        .insertInto('alarm')
        .values({
          mandant_id: sql<string>`app_mandant_id()`,
          budget_id: b.id,
          periode: `${monat}-01`,
          schwelle,
          wert: s.verbrauch,
          prozent: s.prozent,
          betrag: b.betrag,
          prognose: s.prognose,
          ausgeloest: jetzt,
        })
        .onConflict((oc) => oc.columns(['budget_id', 'periode', 'schwelle']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (angelegt) neu += 1;
    }
  }
  return { budgets: budgets.length, neu };
}

/** Stellt offene bzw. fehlgeschlagene Alarme zu (nicht quittiert, höchstens MAX_ZUSTELLVERSUCHE). */
export async function alarmeZustellen(
  ctx: PluginKontext,
  mandantId: string,
  jetzt: Date,
  o: ZustellOptionen = {},
): Promise<{ zugestellt: number; fehler: number; ohne_kanal: number }> {
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;
  const { offen, kanaele } = await withMandant(ctx.db, mandantId, async (trx) => {
    const offen = await alarmAbfrage(trx)
      .where('a.zustellung', 'in', ['offen', 'fehler'])
      .where('a.zustellversuche', '<', MAX_ZUSTELLVERSUCHE)
      .where('a.quittiert', 'is', null)
      .orderBy('a.ausgeloest')
      .execute();
    const kanaele: KanalDaten[] = (await ladeKanaele(trx, true)).map((k) =>
      kanalDaten(masterKey, k),
    );
    return { offen, kanaele };
  });
  const z = { zugestellt: 0, fehler: 0, ohne_kanal: 0 };
  for (const zeile of offen) {
    const a = alarmDto(zeile);
    let zustellung: Alarm['zustellung'];
    let meldung: string | null = null;
    if (kanaele.length === 0) {
      zustellung = 'ohne_kanal';
      z.ohne_kanal += 1;
    } else {
      const fehler: string[] = [];
      const n = nachrichtFuer(
        a,
        zeile.prognose === null ? null : Number(zeile.prognose),
        ctx.konfiguration.SEATMETER_PUBLIC_URL,
      );
      for (const k of kanaele) {
        try {
          await zustellen(k, n, o);
        } catch (e) {
          fehler.push(
            `${k.bezeichnung}: ${e instanceof ZustellFehler ? e.message : 'Fehler beim Zustellen'}`,
          );
        }
      }
      zustellung = fehler.length === 0 ? 'zugestellt' : 'fehler';
      meldung = fehler.length ? fehler.join('; ').slice(0, 500) : null;
      if (fehler.length) z.fehler += 1;
      else z.zugestellt += 1;
    }
    await withMandant(ctx.db, mandantId, (trx) =>
      trx
        .updateTable('alarm')
        .set((eb) => ({
          zustellung,
          zustellfehler: meldung,
          zustellversuche: eb('zustellversuche', '+', zustellung === 'ohne_kanal' ? 0 : 1),
          zugestellt: zustellung === 'zugestellt' ? jetzt : null,
        }))
        .where('id', '=', a.id)
        .execute(),
    );
  }
  return z;
}

/** Ein Lauf über alle Mandanten (Job `budgets.pruefen`). */
export async function pruefeBudgets(
  ctx: PluginKontext,
  o: ZustellOptionen = {},
  jetzt: Date = new Date(),
  nurMandant?: string,
): Promise<PruefErgebnis> {
  const mandanten = nurMandant
    ? [{ id: nurMandant }]
    : await ctx.db.selectFrom('mandant').select('id').execute();
  const e: PruefErgebnis = {
    mandanten: 0,
    budgets: 0,
    neue_alarme: 0,
    zugestellt: 0,
    fehler: 0,
    ohne_kanal: 0,
  };
  for (const m of mandanten) {
    const r = await withMandant(ctx.db, m.id, (trx) => alarmeAnlegen(trx, jetzt));
    e.mandanten += 1;
    e.budgets += r.budgets;
    e.neue_alarme += r.neu;
    const zu = await alarmeZustellen(ctx, m.id, jetzt, o);
    e.zugestellt += zu.zugestellt;
    e.fehler += zu.fehler;
    e.ohne_kanal += zu.ohne_kanal;
  }
  return e;
}
