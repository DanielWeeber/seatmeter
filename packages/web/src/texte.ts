// Deutsche Anzeigetexte für Kalkulation, Kurs und Einstellungen (gemeinsam für mehrere Seiten).
import type { Kurs, KalkulationEinstellungen, ProjektpreisZeile } from '@seatmeter/shared';
import { kurszahl } from './format';

export const VERTEILUNG_TEXT: Record<string, string> = {
  person: 'nach Nutzungsanteil je Person',
  gleich: 'gleichmäßig auf die Projekte einer Person',
  pool: 'als Pool nach Projektanteil',
};

export const STUFEN_TEXT: Record<number, string> = {
  0: '0 – nur Projekte',
  1: '1 – Pseudonym, Monat',
  2: '2 – Pseudonym, Tag',
  3: '3 – Klarnamen',
};

export const CACHE_ANNAHME_TEXT: Record<string, string> = {
  '1h': '1 Stunde',
  '5m': '5 Minuten',
};

export const KURS_QUELLEN_TEXT: Record<string, string> = { ezb: 'EZB', manuell: 'manuell' };

/** Kurs als Text, z. B. `0,8686 €/$ · EZB, vorläufig`; ohne Kurs `kein Kurs für den Monat`. */
export function kursText(k: Kurs): string {
  if (k.usd_eur == null) return 'kein Kurs für den Monat';
  const quelle = k.quelle ? (KURS_QUELLEN_TEXT[k.quelle] ?? k.quelle) : null;
  const teile = [quelle, k.vorlaeufig ? 'vorläufig' : null].filter(Boolean).join(', ');
  return `${kurszahl(k.usd_eur)} €/$${teile ? ` · ${teile}` : ''}`;
}

/** Anzeigename einer Kalkulationszeile: Projektname bzw. Topf. */
export function zeilenName(z: ProjektpreisZeile): string {
  if (z.topf === 'ungenutzt') return 'Ungenutzte Sitze';
  if (z.topf === 'unzugeordnet') return 'unzugeordnet';
  return z.name;
}

export function verteilungText(e: KalkulationEinstellungen): string {
  return VERTEILUNG_TEXT[e.sitzkosten_verteilung] ?? e.sitzkosten_verteilung;
}
