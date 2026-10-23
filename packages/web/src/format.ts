// Zahlen-, Geld- und Datumsformate des Dashboards (immer de-DE).

const ZEITZONE = 'Europe/Berlin';
const LEER = '—';

const ganzzahl = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const dezimal = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const prozentFormat = new Intl.NumberFormat('de-DE', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const waehrungsFormate = new Map<string, Intl.NumberFormat>();

function waehrungsFormat(waehrung: string, nachkomma: number): Intl.NumberFormat {
  const schluessel = `${waehrung}:${nachkomma}`;
  let format = waehrungsFormate.get(schluessel);
  if (!format) {
    format = new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: waehrung,
      minimumFractionDigits: 2,
      maximumFractionDigits: nachkomma,
    });
    waehrungsFormate.set(schluessel, format);
  }
  return format;
}

/** Ganze Zahl mit Tausenderpunkten, `null` als Gedankenstrich. */
export function zahl(wert: number | null | undefined): string {
  return wert == null ? LEER : ganzzahl.format(wert);
}

/** Zahl mit bis zu zwei Nachkommastellen. */
export function dezimalzahl(wert: number | null | undefined): string {
  return wert == null ? LEER : dezimal.format(wert);
}

/** Geldbetrag, z. B. `258,00 $`; `nachkomma` erlaubt feinere Sätze wie `0,075 $`. */
export function geld(wert: number | null | undefined, waehrung = 'USD', nachkomma = 2): string {
  if (wert == null) return LEER;
  try {
    return waehrungsFormat(waehrung, nachkomma).format(wert);
  } catch {
    return `${dezimal.format(wert)} ${waehrung}`;
  }
}

/** Mikro-USD je US-Dollar (Beträge der API sind ganzzahlige `*_usd_micros`). */
export const MIKRO_JE_USD = 1_000_000;

/**
 * Betrag in Mikro-USD als Dollar, z. B. `258_000_000` → `258,00 $`. Beträge unter einem Cent
 * mit bis zu vier Nachkommastellen, damit kleine Werte nicht als `0,00 $` erscheinen.
 */
export function usdAusMikro(mikro: number | null | undefined): string {
  if (mikro == null) return LEER;
  const usd = mikro / MIKRO_JE_USD;
  const klein = usd !== 0 && Math.abs(usd) < 0.01;
  return geld(usd, 'USD', klein ? 4 : 2);
}

/** Prozentwert aus 0–100, z. B. `97,5 %`. */
export function prozent(wert: number | null | undefined): string {
  return wert == null ? LEER : prozentFormat.format(wert / 100);
}

/** Kalendertag `YYYY-MM-DD` (oder ISO-Zeitpunkt) als `22.10.2026`. */
export function datum(wert: string | null | undefined): string {
  if (!wert) return LEER;
  const nurTag = /^\d{4}-\d{2}-\d{2}$/.test(wert);
  const d = new Date(nurTag ? `${wert}T00:00:00Z` : wert);
  if (Number.isNaN(d.getTime())) return wert;
  return d.toLocaleDateString('de-DE', {
    timeZone: nurTag ? 'UTC' : ZEITZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** Zeitpunkt (ISO) als `22.10.2026, 14:05` in Europe/Berlin. */
export function datumZeit(wert: string | null | undefined): string {
  if (!wert) return LEER;
  const d = new Date(wert);
  if (Number.isNaN(d.getTime())) return wert;
  return d.toLocaleString('de-DE', {
    timeZone: ZEITZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Betrag in Cent als Geldbetrag, z. B. `48_974` → `489,74 €`. */
export function ausCent(cent: number | null | undefined, waehrung: 'EUR' | 'USD'): string {
  return cent == null ? LEER : geld(cent / 100, waehrung);
}

const kursFormat = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});

/** Wechselkurs (EUR je USD) mit 4 bis 6 Nachkommastellen, z. B. `0,8686`. */
export function kurszahl(wert: number | null | undefined): string {
  return wert == null ? LEER : kursFormat.format(wert);
}

/** Dezimalzahl aus einer Eingabe mit Komma oder Punkt; leer oder ungültig → NaN. */
export function alsZahl(text: string): number {
  const bereinigt = text.trim().replace(/\s/g, '').replace(',', '.');
  return bereinigt === '' ? Number.NaN : Number(bereinigt);
}

/** Zahl für ein Eingabefeld mit Dezimalkomma, z. B. `0.5` → `0,5`. */
export function alsEingabe(wert: number): string {
  return String(wert).replace('.', ',');
}

export { LEER };
