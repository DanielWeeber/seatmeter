// CSV für Excel (deutsch): Trennzeichen `;`, Dezimalkomma, UTF-8 mit BOM, Zeilenende CRLF.
// Textfelder, die mit = + - @ oder Steuerzeichen beginnen, bekommen ein `'` vorangestellt
// (Schutz vor Formel-Injektion über Repo- oder Kundennamen).

export type CsvWert = string | number | null | undefined;

/** Textfeld (mit Injektionsschutz und Anführungszeichen bei Bedarf). */
export function text(wert: string | null | undefined): { text: string } {
  return { text: wert ?? '' };
}

function feld(wert: CsvWert | { text: string }): string {
  if (wert === null || wert === undefined) return '';
  let s: string;
  if (typeof wert === 'object') {
    s = wert.text;
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  } else {
    s = String(wert);
  }
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Zahl mit Dezimalkomma und fester Stellenzahl. */
export function dezimal(wert: number | null | undefined, stellen: number): string {
  if (wert === null || wert === undefined || !Number.isFinite(wert)) return '';
  return wert.toFixed(stellen).replace('.', ',');
}

/** Cent → `1234,56`. */
export const cent = (c: number | null | undefined) =>
  c === null || c === undefined ? '' : dezimal(c / 100, 2);

/** Mikro-USD → auf Cent gerundet `1234,56`. */
export const mikro = (m: number) => cent(Math.round(m / 10_000));

/** Mikro-USD → sechs Nachkommastellen: Die Summe der Zeilen ergibt genau die Summe im Dashboard. */
export const mikroGenau = (m: number) => dezimal(m / 1_000_000, 6);

export function csv(zeilen: readonly (readonly (CsvWert | { text: string })[])[]): string {
  return `\uFEFF${zeilen.map((z) => z.map(feld).join(';')).join('\r\n')}\r\n`;
}
