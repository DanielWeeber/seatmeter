// Fehlerformat der API (Kern und ee): `{ fehler, code?, details? }`. `fehler` ist ein deutscher Text
// für Menschen, `code` ein stabiler Schlüssel für Clients (Texte dürfen sich ändern, Codes nicht),
// `details` die zod-Issues bei 400. Codes gibt es nur dort, wo ein Client unterscheiden muss.

/**
 * Stabile Fehlercodes:
 * - `nicht_angemeldet` (401): keine gültige Anmeldung.
 * - `csrf` (403): Header `X-Seatmeter-CSRF` fehlt oder passt nicht zur Sitzung (Client holt den
 *   aktuellen Wert aus `/api/v1/auth/me` und versucht es einmal neu).
 * - `kein_mandant` (403): angemeldet, aber ohne aktiven Mandanten.
 * - `rolle_fehlt` (403): Die Rolle darf die ganze Ressource nicht sehen (z. B. `/api/v1/personen`
 *   ohne Personensicht). Felder innerhalb einer erlaubten Ressource kommen dagegen als `null` mit
 *   Hinweisfeld (z. B. `personen: null` + `personen_hinweis` in `/api/v1/projekte/:id`).
 * - `lizenz_fehlt` (402, nur ee): Lizenzmodul fehlt.
 * - `konten_kontingent` (409 bzw. 403 bei der SSO-Erstanmeldung, nur ee): Das Kontenkontingent des
 *   Mandanten (`mandant.konten_max`) ist ausgeschöpft.
 * - `letzter_admin` (409, nur ee): Die Änderung entzöge dem Mandanten den letzten Mandanten-Admin
 *   (oder ein Mandanten-Admin wollte sich selbst deaktivieren).
 * - `domain_vergeben` (409, nur ee): Die E-Mail-Domain gehört schon zu einem Mandanten.
 * - `einladung_ungueltig` (404, nur ee): Einladungslink unbekannt, schon genutzt oder abgelaufen.
 * - `link_ungueltig` (400), `link_abgelaufen` (410): Link zur Projektwahl falsch bzw. älter als eine Stunde.
 * - `kein_mitglied` (403): Das Konto hat im Mandanten des Links keine Rolle.
 * - `bereits_zugeordnet` (409): Repo oder Sitzung hat schon ein Projekt; die erste Wahl gilt.
 */
export const FEHLER_CODES = [
  'nicht_angemeldet',
  'csrf',
  'kein_mandant',
  'rolle_fehlt',
  'lizenz_fehlt',
  'konten_kontingent',
  'letzter_admin',
  'domain_vergeben',
  'einladung_ungueltig',
  'link_ungueltig',
  'link_abgelaufen',
  'kein_mitglied',
  'bereits_zugeordnet',
] as const;
export type FehlerCode = (typeof FEHLER_CODES)[number];

/** Körper einer Fehlerantwort. */
export interface FehlerKoerper {
  fehler: string;
  code?: FehlerCode;
  details?: unknown;
}

/** Fehlerkörper mit Code (für `reply.code(…).send(fehlerKoerper(…))`). */
export function fehlerKoerper(code: FehlerCode, fehler: string): FehlerKoerper {
  return { code, fehler };
}
