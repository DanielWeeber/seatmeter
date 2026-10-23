// Budget-Stand je Monat: Verbrauch bis heute aus der Live-Kalkulation des Kerns (Projektpreis in EUR/USD
// bzw. Tokens), Prognose zum Monatsende über Arbeitstage (prognose.ts). Läuft in `withMandant` (RLS).
import type { Budget, BudgetStand, KalkulationAntwort } from '@seatmeter/shared';
import { heuteIn } from '../aggregation/tage.js';
import type { Datenbank } from '../db/schema.js';
import { kalkuliereMonat } from '../kalkulation/rechnen.js';
import type { Transaction } from 'kysely';
import { arbeitstage, prognose, prozentVon } from './prognose.js';

type Trx = Transaction<Datenbank>;

export interface BudgetZeile {
  id: string;
  projekt_id: string | null;
  bezeichnung: string | null;
  betrag: number;
  waehrung: 'EUR' | 'USD';
  basis: 'projektpreis' | 'tokens';
  schwellen: number[];
  ausloeser: 'verbrauch' | 'prognose';
  aktiv: boolean;
  erstellt: Date;
  projekt_name: string | null;
}

/** Budgets des Mandanten; `sicht` = sichtbare Projekte (Projektleiter), `null` = alle. */
export async function ladeBudgets(
  trx: Trx,
  sicht: string[] | null = null,
  nurAktiv = false,
): Promise<BudgetZeile[]> {
  let q = trx
    .selectFrom('budget as b')
    .leftJoin('projekt as p', 'p.id', 'b.projekt_id')
    .select([
      'b.id',
      'b.projekt_id',
      'b.bezeichnung',
      'b.betrag',
      'b.waehrung',
      'b.basis',
      'b.schwellen',
      'b.ausloeser',
      'b.aktiv',
      'b.erstellt',
      'p.anzeigename',
      'p.owner',
      'p.repo_name',
      'p.url_norm',
    ])
    .orderBy('b.erstellt');
  if (nurAktiv) q = q.where('b.aktiv', '=', true);
  if (sicht !== null) {
    if (sicht.length === 0) return [];
    q = q.where('b.projekt_id', 'in', sicht);
  }
  const zeilen = await q.execute();
  return zeilen.map((z) => ({
    id: z.id,
    projekt_id: z.projekt_id,
    bezeichnung: z.bezeichnung,
    betrag: Number(z.betrag),
    waehrung: z.waehrung === 'USD' ? 'USD' : 'EUR',
    basis: z.basis,
    schwellen: [...z.schwellen].sort((a, b) => a - b),
    ausloeser: z.ausloeser,
    aktiv: z.aktiv,
    erstellt: new Date(z.erstellt),
    projekt_name:
      z.projekt_id === null
        ? null
        : (z.anzeigename ??
          (z.owner && z.repo_name ? `${z.owner}/${z.repo_name}` : null) ??
          z.repo_name ??
          z.url_norm ??
          z.projekt_id),
  }));
}

export function budgetName(b: Pick<BudgetZeile, 'bezeichnung' | 'projekt_name'>): string {
  return b.bezeichnung ?? b.projekt_name ?? 'Alle Projekte';
}

export function einheit(b: Pick<BudgetZeile, 'basis' | 'waehrung'>): string {
  return b.basis === 'tokens' ? 'Tokens' : b.waehrung;
}

/** Verbrauch eines Budgets aus der Kalkulation; `null` = nicht berechenbar (z. B. EUR ohne Kurs). */
export function verbrauchAus(
  k: KalkulationAntwort,
  b: Pick<BudgetZeile, 'projekt_id' | 'basis' | 'waehrung'>,
): { wert: number | null; hinweis: string | null } {
  const zeilen =
    b.projekt_id === null ? k.zeilen : k.zeilen.filter((z) => z.projekt_id === b.projekt_id);
  if (b.basis === 'tokens') {
    return { wert: zeilen.reduce((s, z) => s + z.tokens.gesamt, 0), hinweis: null };
  }
  if (b.waehrung === 'USD') {
    return { wert: zeilen.reduce((s, z) => s + z.projektpreis_usd_cent, 0) / 100, hinweis: null };
  }
  let cent = 0;
  for (const z of zeilen) {
    if (z.projektpreis_eur_cent === null) {
      return { wert: null, hinweis: 'Kein Kurs für den Monat: EUR-Verbrauch nicht berechenbar.' };
    }
    cent += z.projektpreis_eur_cent;
  }
  return { wert: cent / 100, hinweis: null };
}

const runde = (x: number) => Math.round(x * 100) / 100;

/** Stand aller übergebenen Budgets im Monat (eine Kalkulation für alle). */
export async function berechneStaende(
  trx: Trx,
  monat: string,
  budgets: readonly BudgetZeile[],
  jetzt: Date = new Date(),
): Promise<Map<string, BudgetStand>> {
  const staende = new Map<string, BudgetStand>();
  if (budgets.length === 0) return staende;
  const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
  const heute = heuteIn(m.zeitzone, jetzt);
  const a = arbeitstage(monat, heute);
  const k = await kalkuliereMonat(trx, monat, null, jetzt);
  for (const b of budgets) {
    const { wert, hinweis } = verbrauchAus(k, b);
    const p = wert === null ? null : prognose(wert, a);
    staende.set(b.id, {
      monat,
      verbrauch: wert === null ? null : runde(wert),
      prognose: p === null ? null : runde(p),
      prozent: wert === null ? null : prozentVon(wert, b.betrag),
      prognose_prozent: p === null ? null : prozentVon(p, b.betrag),
      arbeitstage_bisher: a.bisher,
      arbeitstage_monat: a.monat,
      hinweis,
    });
  }
  return staende;
}

export function budgetDto(b: BudgetZeile, stand: BudgetStand): Budget {
  return {
    id: b.id,
    projekt_id: b.projekt_id,
    projekt_name: b.projekt_name,
    bezeichnung: b.bezeichnung,
    betrag: b.betrag,
    waehrung: b.waehrung,
    basis: b.basis,
    schwellen: b.schwellen,
    ausloeser: b.ausloeser,
    aktiv: b.aktiv,
    erstellt: b.erstellt.toISOString(),
    stand,
  };
}
