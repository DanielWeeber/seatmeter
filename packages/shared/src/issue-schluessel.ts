// Issue-Schlüssel aus Branch-Namen (Architektur Phase 5c): Gesendet und gespeichert wird
// nur der Schlüssel (z. B. `ABC-123`), nie der Branch-Name. Erkannt wird ohne Rücksicht auf Groß- und
// Kleinschreibung, gespeichert immer groß. Dieselbe Erkennung nutzen Agent (Transkript, Start-Wrapper)
// und Server (OTLP-Attribute).
import { z } from 'zod';

/** Gültiger Issue-Schlüssel nach dem Speichern (groß geschrieben). */
export const ISSUE_SCHLUESSEL_MUSTER = /^[A-Z][A-Z0-9]+-[0-9]+$/;

/** Gültiger Jira-Projektschlüssel (Präfix eines Issue-Schlüssels). */
export const JIRA_PROJEKT_SCHLUESSEL_MUSTER = /^[A-Z][A-Z0-9]+$/;

/** Höchstzahl Schlüssel je Anfrage bzw. Branch. */
export const ISSUE_SCHLUESSEL_MAX = 20;

/** Höchstlänge eines Schlüssels (Jira-Projektschlüssel sind meist bis 10 Zeichen lang). */
export const ISSUE_SCHLUESSEL_LAENGE = 50;

/** Ressourcen-Attribut, das der Start-Wrapper über `OTEL_RESOURCE_ATTRIBUTES` setzt (Quelle A). */
export const OTEL_ATTRIBUT_ISSUE = 'seatmeter.issue_schluessel';

/** Trenner mehrerer Schlüssel im OTel-Attribut (`,` und `;` sind in `OTEL_RESOURCE_ATTRIBUTES` verboten). */
export const OTEL_ISSUE_TRENNER = '|';

/**
 * Übliche Branch-Präfixe, die das Muster erfüllen, aber keine Jira-Projekte sind
 * (z. B. `release-2026`, `hotfix-3`).
 */
const KEINE_PROJEKTE = new Set(['RELEASE', 'HOTFIX', 'BUGFIX', 'FEATURE', 'FIX', 'CHORE']);

const ERKENNUNG = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)-([0-9]+)(?![0-9])/g;

export const issueSchluesselSchema = z
  .string()
  .max(ISSUE_SCHLUESSEL_LAENGE)
  .regex(ISSUE_SCHLUESSEL_MUSTER);

/**
 * Alle Issue-Schlüssel in einem Text (Branch-Name oder Attributwert), groß geschrieben, ohne
 * Doppelte, in der Reihenfolge des Auftretens, höchstens `ISSUE_SCHLUESSEL_MAX`.
 * Beispiele: `feature/ABC-123-titel` → `ABC-123`; `abc-123` → `ABC-123`;
 * `ABC-123/ABC-124` → `ABC-123`, `ABC-124`; `main` → keine.
 */
export function issueSchluesselAus(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || text === '') return [];
  const gefunden: string[] = [];
  for (const m of text.slice(0, 1000).matchAll(ERKENNUNG)) {
    const projekt = (m[1] as string).toUpperCase();
    if (KEINE_PROJEKTE.has(projekt)) continue;
    const schluessel = `${projekt}-${m[2] as string}`;
    if (schluessel.length > ISSUE_SCHLUESSEL_LAENGE || gefunden.includes(schluessel)) continue;
    gefunden.push(schluessel);
    if (gefunden.length >= ISSUE_SCHLUESSEL_MAX) break;
  }
  return gefunden;
}

/** Projektschlüssel eines Issue-Schlüssels (`ABC-123` → `ABC`). */
export function projektSchluesselVon(schluessel: string): string {
  const i = schluessel.lastIndexOf('-');
  return i > 0 ? schluessel.slice(0, i) : schluessel;
}

/**
 * Positivliste je Mandant: `null` = alle erkannten Schlüssel; sonst nur Schlüssel, deren
 * Projektschlüssel in der Liste steht (Liste aus der Jira-Zuordnung, ee).
 */
export function schluesselFiltern(
  schluessel: readonly string[],
  praefixe: readonly string[] | null,
): string[] {
  if (praefixe === null) return [...schluessel];
  const erlaubt = new Set(praefixe);
  return schluessel.filter((s) => erlaubt.has(projektSchluesselVon(s)));
}

/** Wert des OTel-Attributs `seatmeter.issue_schluessel` (`ABC-123|ABC-124`). */
export function issueSchluesselOtelWert(schluessel: readonly string[]): string {
  return schluessel.join(OTEL_ISSUE_TRENNER);
}

/**
 * Anteile je Schlüssel einer Anfrage: Tokens und Beträge werden gleichmäßig auf die Schlüssel
 * verteilt; der Rest der ganzzahligen Teilung geht an die ersten Schlüssel, damit die Summe stimmt.
 */
export function aufteilen(wert: number, anzahl: number): number[] {
  if (anzahl <= 0) return [];
  const basis = Math.floor(wert / anzahl);
  const rest = wert - basis * anzahl;
  return Array.from({ length: anzahl }, (_x, i) => basis + (i < rest ? 1 : 0));
}
