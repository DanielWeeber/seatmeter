// Monatsauswahl: `?monat=YYYY-MM` in der URL, gemeinsam für alle Monatsseiten.
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

const MONAT_MUSTER = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Seiten, die den Monat aus der URL lesen; die Navigation reicht `?monat=` an sie weiter. */
export const MONATS_SEITEN = [
  '/',
  '/projekte',
  '/projektpreise',
  '/personen',
  '/datenqualitaet',
  '/berichte',
  '/budgets',
  '/hinweise',
];

export function istMonat(wert: string | null | undefined): wert is string {
  return !!wert && MONAT_MUSTER.test(wert);
}

/** Aktueller Monat in Europe/Berlin als `YYYY-MM`. */
export function aktuellerMonat(jetzt: Date = new Date()): string {
  const teile = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(jetzt);
  const jahr = teile.find((t) => t.type === 'year')?.value ?? '1970';
  const monat = teile.find((t) => t.type === 'month')?.value ?? '01';
  return `${jahr}-${monat}`;
}

/** Monat um `delta` Monate verschieben. */
export function verschiebeMonat(monat: string, delta: number): string {
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(jahr, mon - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `2026-10` → `Oktober 2026`. */
export function monatsname(monat: string): string {
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(jahr, mon - 1, 1)).toLocaleDateString('de-DE', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

/** Liest und setzt den Monat aus `?monat=`; ohne gültigen Wert gilt der aktuelle Monat. */
export function useMonat(): [string, (monat: string) => void] {
  const [parameter, setParameter] = useSearchParams();
  const roh = parameter.get('monat');
  const monat = istMonat(roh) ? roh : aktuellerMonat();
  const setMonat = useCallback(
    (neu: string) => {
      if (!istMonat(neu)) return;
      setParameter((alt) => {
        const naechste = new URLSearchParams(alt);
        naechste.set('monat', neu);
        return naechste;
      });
    },
    [setParameter],
  );
  return [monat, setMonat];
}
