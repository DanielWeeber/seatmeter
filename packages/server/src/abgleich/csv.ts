// Team-Spend-Report als CSV (Architektur §2.6; Spaltenformat nicht verifiziert): tolerante Erkennung von
// Trennzeichen, Spalten (deutsch/englisch, verschiedene Schreibweisen), Zahlen (1.234,56 / 1,234.56 / $12.30)
// und Datumsformaten; die erkannte Zuordnung kann der Admin in der Vorschau feldweise überschreiben.
// E-Mail-Adressen werden nur gehasht weitergegeben; die Vorschau zeigt sie maskiert.
import { CSV_FELDER, type CsvFeld, type CsvZuordnung } from '@seatmeter/shared';

export type Zuordnung = Record<CsvFeld, string | null>;

/** Kandidaten je Feld (normalisierte Spaltennamen); früher in der Liste = besser. */
const KANDIDATEN: Record<CsvFeld, string[]> = {
  email: [
    'email',
    'email address',
    'e mail',
    'user email',
    'member email',
    'e mail adresse',
    'mail',
    'user',
    'member',
    'benutzer',
  ],
  tag: [
    'date',
    'day',
    'datum',
    'tag',
    'usage date',
    'starting at',
    'start date',
    'period start',
    'bucket',
  ],
  modell: ['model', 'modell', 'model name', 'model id'],
  amount: [
    'amount',
    'amount usd',
    'cost',
    'cost usd',
    'spend',
    'spend usd',
    'estimated spend',
    'estimated cost',
    'usage credits',
    'usage credit spend',
    'credits',
    'net amount',
    'kosten',
    'betrag',
  ],
  list_amount: [
    'list amount',
    'list amount usd',
    'list price',
    'list cost',
    'gross amount',
    'listenpreis',
  ],
  input: ['input tokens', 'uncached input tokens', 'input', 'prompt tokens', 'eingabe tokens'],
  output: ['output tokens', 'output', 'completion tokens', 'ausgabe tokens'],
  cache_read: ['cache read tokens', 'cache read input tokens', 'cache read', 'cached input tokens'],
  cache_write: [
    'cache write tokens',
    'cache creation tokens',
    'cache creation input tokens',
    'cache write',
    'cache creation',
  ],
};

export function normalisiere(spalte: string): string {
  return spalte
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9äöü]+/g, ' ')
    .trim();
}

/** Trennzeichen aus der Kopfzeile (außerhalb von Anführungszeichen): ; , oder Tab. */
export function trennzeichen(text: string): string {
  const kopf = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const zaehle = (z: string) => {
    let n = 0;
    let inQuote = false;
    for (const c of kopf) {
      if (c === '"') inQuote = !inQuote;
      else if (!inQuote && c === z) n += 1;
    }
    return n;
  };
  return ['\t', ';', ','].reduce((best, z) => (zaehle(z) > zaehle(best) ? z : best), ',');
}

/** CSV nach RFC 4180 (Anführungszeichen, verdoppelte "", Zeilenumbrüche in Feldern). */
export function parseCsv(text: string, trenn: string): string[][] {
  const zeilen: string[][] = [];
  let feld = '';
  let zeile: string[] = [];
  let inQuote = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inQuote) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          feld += '"';
          i += 1;
        } else inQuote = false;
      } else feld += c;
    } else if (c === '"') inQuote = true;
    else if (c === trenn) {
      zeile.push(feld);
      feld = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i += 1;
      zeile.push(feld);
      feld = '';
      if (zeile.some((f) => f.trim() !== '')) zeilen.push(zeile);
      zeile = [];
    } else feld += c;
  }
  zeile.push(feld);
  if (zeile.some((f) => f.trim() !== '')) zeilen.push(zeile);
  return zeilen;
}

/** Erkennt die Zuordnung Feld → Spalte; jede Spalte höchstens einmal. */
export function erkenneZuordnung(spalten: readonly string[]): Zuordnung {
  const norm = spalten.map(normalisiere);
  const vergeben = new Set<number>();
  const z = Object.fromEntries(CSV_FELDER.map((f) => [f, null])) as Zuordnung;
  // Reihenfolge: spezifische Felder zuerst (list_amount vor amount, Tokenarten vor input/output).
  const reihenfolge: CsvFeld[] = [
    'email',
    'tag',
    'modell',
    'list_amount',
    'cache_read',
    'cache_write',
    'input',
    'output',
    'amount',
  ];
  for (const feld of reihenfolge) {
    let besterIndex = -1;
    let besterRang = Number.POSITIVE_INFINITY;
    for (let i = 0; i < norm.length; i++) {
      const n = norm[i]!;
      if (vergeben.has(i)) continue;
      if (feld === 'amount' && /\blist\b|\blisten/.test(n)) continue;
      if ((feld === 'input' || feld === 'output') && /cache/.test(n)) continue;
      for (let rang = 0; rang < KANDIDATEN[feld].length; rang++) {
        const k = KANDIDATEN[feld][rang]!;
        const exakt = n === k;
        const enthaelt =
          !exakt && (n.startsWith(`${k} `) || n.endsWith(` ${k}`) || n.includes(` ${k} `));
        if (!exakt && !enthaelt) continue;
        const r = rang * 2 + (exakt ? 0 : 1);
        if (r < besterRang) {
          besterRang = r;
          besterIndex = i;
        }
      }
    }
    if (besterIndex >= 0) {
      z[feld] = spalten[besterIndex]!;
      vergeben.add(besterIndex);
    }
  }
  return z;
}

/** Zahl tolerant lesen: Währungszeichen/Einheiten weg, Dezimaltrenner = letztes . oder ,. */
export function leseZahl(roh: string | undefined): number | null {
  if (roh === undefined) return null;
  let s = roh.replace(/[^\d,.-]/g, '');
  if (s === '' || s === '-') return null;
  const punkt = s.lastIndexOf('.');
  const komma = s.lastIndexOf(',');
  if (punkt >= 0 && komma >= 0) {
    const dezimal = punkt > komma ? '.' : ',';
    const tausend = dezimal === '.' ? ',' : '.';
    s = s.split(tausend).join('').replace(dezimal, '.');
  } else if (komma >= 0) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (punkt >= 0 && /^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Datum als JJJJ-MM-TT: ISO (auch mit Uhrzeit), TT.MM.JJJJ, JJJJ/MM/TT, MM/TT/JJJJ (US). */
export function leseTag(roh: string | undefined): string | null {
  if (!roh) return null;
  const s = roh.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) ?? /^(\d{4})\/(\d{2})\/(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  return null;
}

export function maskiereEmail(email: string): string {
  const [lokal = '', domain = ''] = email.trim().split('@');
  return `${lokal.slice(0, 1)}***@${domain}`;
}

export interface CsvZeile {
  emailKey: Buffer;
  tag: string;
  model: string;
  amountUsdMicros: number;
  listAmountUsdMicros: number | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  hatTokens: boolean;
}

export interface CsvErgebnis {
  trennzeichen: string;
  spalten: string[];
  zuordnung: Zuordnung;
  betragEinheit: 'usd' | 'cent';
  zeilen: CsvZeile[];
  gesamt: number;
  beispiel: Record<string, string>[];
  fehler: string[];
}

/**
 * Liest die CSV; `hashEmail` pseudonymisiert die Adresse sofort. Pflicht: E-Mail, Datum, Betrag.
 * Fehlerhafte Zeilen werden gezählt und übersprungen (höchstens 20 Meldungen, ohne Inhalte).
 */
export function leseSpendCsv(
  text: string,
  hashEmail: (email: string) => Buffer,
  optionen: { zuordnung?: CsvZuordnung; betragEinheit?: 'usd' | 'cent' } = {},
): CsvErgebnis {
  const trenn = trennzeichen(text);
  const roh = parseCsv(text, trenn);
  const kopf = (roh[0] ?? []).map((s) => s.trim());
  const zuordnung = { ...erkenneZuordnung(kopf), ...(optionen.zuordnung ?? {}) } as Zuordnung;
  const einheit = optionen.betragEinheit ?? 'usd';
  const fehler: string[] = [];
  const index = (f: CsvFeld) => (zuordnung[f] ? kopf.indexOf(zuordnung[f]!) : -1);
  for (const f of ['email', 'tag', 'amount'] as const) {
    if (zuordnung[f] && index(f) < 0)
      fehler.push(`Spalte „${zuordnung[f]}“ für ${f} nicht gefunden`);
    else if (!zuordnung[f]) fehler.push(`Keine Spalte für ${f} erkannt; bitte zuordnen`);
  }
  const ergebnis: CsvErgebnis = {
    trennzeichen: trenn === '\t' ? 'Tab' : trenn,
    spalten: kopf,
    zuordnung,
    betragEinheit: einheit,
    zeilen: [],
    gesamt: Math.max(roh.length - 1, 0),
    beispiel: [],
    fehler,
  };
  if (fehler.length) return ergebnis;
  const faktor = einheit === 'cent' ? 10_000 : 1_000_000;
  const tokenFelder = ['input', 'output', 'cache_read', 'cache_write'] as const;
  const hatTokens = tokenFelder.some((f) => index(f) >= 0);
  let uebersprungen = 0;
  for (let i = 1; i < roh.length; i++) {
    const z = roh[i]!;
    const wert = (f: CsvFeld) => (index(f) >= 0 ? z[index(f)] : undefined);
    const email = wert('email')?.trim() ?? '';
    const tag = leseTag(wert('tag'));
    const amount = leseZahl(wert('amount'));
    if (!email.includes('@') || !tag || amount === null) {
      uebersprungen += 1;
      if (fehler.length < 20) fehler.push(`Zeile ${i + 1}: E-Mail, Datum oder Betrag nicht lesbar`);
      continue;
    }
    const liste = leseZahl(wert('list_amount'));
    if (ergebnis.beispiel.length < 5) {
      const b: Record<string, string> = {};
      for (const f of CSV_FELDER) {
        const w = wert(f);
        if (w !== undefined) b[f] = f === 'email' ? maskiereEmail(w) : w.trim();
      }
      ergebnis.beispiel.push(b);
    }
    ergebnis.zeilen.push({
      emailKey: hashEmail(email),
      tag,
      model: wert('modell')?.trim() || 'unbekannt',
      amountUsdMicros: Math.round(amount * faktor),
      listAmountUsdMicros: liste === null ? null : Math.round(liste * faktor),
      input: Math.round(leseZahl(wert('input')) ?? 0),
      output: Math.round(leseZahl(wert('output')) ?? 0),
      cache_read: Math.round(leseZahl(wert('cache_read')) ?? 0),
      cache_write: Math.round(leseZahl(wert('cache_write')) ?? 0),
      hatTokens,
    });
  }
  if (uebersprungen > 20) fehler.push(`… insgesamt ${uebersprungen} Zeilen übersprungen`);
  return ergebnis;
}
