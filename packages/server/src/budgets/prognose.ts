// Budget-Prognose (Architektur §5 „Budget (ee)“): Verbrauch V(t) bis heute, Prognose zum Monatsende
// V(t) / w_t · w_M mit w = Arbeitstage (Mo–Fr) bis einschließlich heute bzw. im ganzen Monat.
// Ohne Arbeitstag bis heute (Monatsanfang am Wochenende) wird über Kalendertage hochgerechnet.
import { monatsGrenzen, plusTage } from '../aggregation/tage.js';

export interface Arbeitstage {
  bisher: number;
  monat: number;
  kalenderBisher: number;
  kalenderMonat: number;
}

function istArbeitstag(tag: string): boolean {
  const wochentag = new Date(`${tag}T00:00:00Z`).getUTCDay();
  return wochentag !== 0 && wochentag !== 6;
}

/** Arbeitstage im Monat `JJJJ-MM` bis einschließlich `heute` (Tage nach dem Monat zählen voll). */
export function arbeitstage(monat: string, heute: string): Arbeitstage {
  const { von, bisExklusiv } = monatsGrenzen(monat);
  const a: Arbeitstage = { bisher: 0, monat: 0, kalenderBisher: 0, kalenderMonat: 0 };
  for (let t = von; t < bisExklusiv; t = plusTage(t, 1)) {
    const arbeit = istArbeitstag(t);
    a.kalenderMonat += 1;
    if (arbeit) a.monat += 1;
    if (t <= heute) {
      a.kalenderBisher += 1;
      if (arbeit) a.bisher += 1;
    }
  }
  return a;
}

/** Lineare Hochrechnung; abgeschlossene Monate (alle Tage vorbei) liefern den Verbrauch selbst. */
export function prognose(verbrauch: number, a: Arbeitstage): number {
  if (a.kalenderBisher >= a.kalenderMonat) return verbrauch;
  if (a.bisher > 0) return (verbrauch / a.bisher) * a.monat;
  if (a.kalenderBisher > 0) return (verbrauch / a.kalenderBisher) * a.kalenderMonat;
  return verbrauch;
}

/** Prozent auf zwei Stellen. */
export function prozentVon(wert: number, betrag: number): number {
  return Math.round((wert / betrag) * 10_000) / 100;
}

/** Erreichte Schwellen (aufsteigend) für einen Prozentwert. */
export function erreichteSchwellen(prozent: number, schwellen: readonly number[]): number[] {
  return [...schwellen].sort((x, y) => x - y).filter((s) => prozent >= s);
}
