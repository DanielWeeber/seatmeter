// Zugriffszustände der Einrichtungsseiten (Budgets, Hinweise, Abgleich, …): Ohne Rolle antworten die Routen
// mit 403. Das ist kein Fehler, sondern ein Hinweis. Bis 2026-10-24 lag das als Lizenz-Tor in ee/web; seit
// dem Umzug in den Kern (Entscheidung vom 2026-10-23) gibt es hier keine Lizenzprüfung mehr.
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { istApiFehler, istCsrfFehler } from '../api/client';
import { Abfrage, Hinweis } from './Abfrage';
import { fehlerBeimSpeichern } from './Formular';

export const TEXT_KEINE_BERECHTIGUNG = 'Keine Berechtigung.';

/** `true`, wenn die Berechtigung fehlt (403, aber keine CSRF-Abweisung). */
export function ohneZugriff(fehler: unknown): boolean {
  return istApiFehler(fehler, 403) && !istCsrfFehler(fehler);
}

/** Hinweistext zu 403, sonst `null`. */
export function zugriffText(fehler: unknown): string | null {
  return ohneZugriff(fehler) ? TEXT_KEINE_BERECHTIGUNG : null;
}

/** Wie `Abfrage`, zeigt bei 403 aber den Berechtigungshinweis statt eines Fehlers. */
export function ZugriffAbfrage<T>({
  abfrage,
  istLeer,
  leerText,
  children,
}: {
  abfrage: UseQueryResult<T>;
  istLeer?: (daten: T) => boolean;
  leerText?: ReactNode;
  children: (daten: T) => ReactNode;
}) {
  const text = zugriffText(abfrage.error);
  if (text) return <Hinweis>{text}</Hinweis>;
  return (
    <Abfrage abfrage={abfrage} istLeer={istLeer} leerText={leerText}>
      {children}
    </Abfrage>
  );
}

/** Meldung zu einem fehlgeschlagenen Speichern oder Auslösen (403 mit eigenem Text). */
export function speicherFehler(fehler: unknown): string {
  // CSRF-Abweisung (403 `code: 'csrf'`) ist keine fehlende Berechtigung: Text aus dem Kern.
  if (ohneZugriff(fehler)) return TEXT_KEINE_BERECHTIGUNG;
  return fehlerBeimSpeichern(fehler);
}
