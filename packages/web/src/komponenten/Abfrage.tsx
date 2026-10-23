// Einheitliche Lade-, Leer- und Fehlerzustände für alle Seiten.
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiFehler, istCsrfFehler, TEXT_CSRF } from '../api/client';

export const TEXT_KEINE_DATEN = 'Für diesen Monat liegen noch keine Daten vor.';
export const TEXT_NICHT_GELIEFERT = 'Diese Auswertung liefert der Server noch nicht.';

export function fehlertext(fehler: unknown): string {
  if (fehler instanceof ApiFehler) {
    if (fehler.art === 'http' && fehler.status === 404) return TEXT_NICHT_GELIEFERT;
    if (istCsrfFehler(fehler)) return TEXT_CSRF;
    if (fehler.art === 'http' && fehler.status === 403)
      return 'Für diese Ansicht fehlt die Berechtigung.';
    if (fehler.art === 'http' && fehler.status === 401) return 'Die Anmeldung ist abgelaufen.';
    if (fehler.art === 'netz') return 'Der Server ist nicht erreichbar.';
    if (fehler.art === 'format')
      return `Die Antwort des Servers hat ein unerwartetes Format. ${fehler.message}`;
    return `Die Daten konnten nicht geladen werden. ${fehler.message}`;
  }
  return 'Die Daten konnten nicht geladen werden.';
}

export function Laden({ text = 'Lade Daten …' }: { text?: string }) {
  return (
    <p className="mt-4 text-slate-600" role="status">
      {text}
    </p>
  );
}

export function Hinweis({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 rounded border border-slate-200 bg-white p-4 text-slate-700">{children}</p>
  );
}

export function Fehlermeldung({ fehler, erneut }: { fehler: unknown; erneut?: () => void }) {
  const nichtGeliefert =
    fehler instanceof ApiFehler && fehler.art === 'http' && fehler.status === 404;
  return (
    <div
      role={nichtGeliefert ? 'status' : 'alert'}
      className={`mt-4 rounded border p-4 ${
        nichtGeliefert
          ? 'border-slate-200 bg-white text-slate-700'
          : 'border-red-200 bg-red-50 text-red-800'
      }`}
    >
      <p>{fehlertext(fehler)}</p>
      {erneut && !nichtGeliefert && (
        <button
          type="button"
          onClick={erneut}
          className="mt-2 rounded border border-red-300 bg-white px-3 py-1 text-sm hover:bg-red-100"
        >
          Erneut versuchen
        </button>
      )}
    </div>
  );
}

/** Zeigt Laden/Fehler/Leer und rendert sonst `children(daten)`. */
export function Abfrage<T>({
  abfrage,
  istLeer,
  leerText = TEXT_KEINE_DATEN,
  children,
}: {
  abfrage: UseQueryResult<T>;
  istLeer?: (daten: T) => boolean;
  leerText?: ReactNode;
  children: (daten: T) => ReactNode;
}) {
  if (abfrage.isPending) return <Laden />;
  if (abfrage.isError)
    return <Fehlermeldung fehler={abfrage.error} erneut={() => void abfrage.refetch()} />;
  if (istLeer?.(abfrage.data)) return <Hinweis>{leerText}</Hinweis>;
  return <>{children(abfrage.data)}</>;
}
