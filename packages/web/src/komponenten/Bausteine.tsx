// Kleine Bausteine: Seitenkopf, Monatswahl, Kennzahl-Kachel, Tabellen.
import type { ReactNode } from 'react';
import type { PersonenHinweis } from '../api/typen';
import { aktuellerMonat, monatsname, useMonat, verschiebeMonat } from '../monat';

export function Seitenkopf({ titel, children }: { titel: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <h1 className="text-2xl font-semibold">{titel}</h1>
      {children}
    </header>
  );
}

export function MonatsWahl() {
  const [monat, setMonat] = useMonat();
  const istAktuell = monat >= aktuellerMonat();
  const knopf =
    'rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-40';
  return (
    <div className="flex items-center gap-2" role="group" aria-label="Monatsauswahl">
      <button
        type="button"
        className={knopf}
        onClick={() => setMonat(verschiebeMonat(monat, -1))}
        aria-label="Vorheriger Monat"
        title="Vorheriger Monat"
      >
        ‹
      </button>
      <input
        type="month"
        value={monat}
        max={aktuellerMonat()}
        onChange={(e) => setMonat(e.target.value)}
        aria-label="Monat wählen"
        className="rounded border border-slate-300 bg-white px-2 py-1"
      />
      <button
        type="button"
        className={knopf}
        onClick={() => setMonat(verschiebeMonat(monat, 1))}
        disabled={istAktuell}
        aria-label="Nächster Monat"
        title="Nächster Monat"
      >
        ›
      </button>
      <span className="sr-only" aria-live="polite">
        {monatsname(monat)}
      </span>
    </div>
  );
}

export function Kachel({
  titel,
  wert,
  hinweis,
}: {
  titel: string;
  wert: ReactNode;
  hinweis?: ReactNode;
}) {
  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-600">{titel}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{wert}</p>
      {hinweis && <p className="mt-1 text-xs text-slate-500">{hinweis}</p>}
    </div>
  );
}

export function Abschnitt({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-semibold">{titel}</h2>
      {children}
    </section>
  );
}

export interface Spalte<T> {
  titel: string;
  wert: (zeile: T) => ReactNode;
  /** Zahlen rechtsbündig. */
  zahl?: boolean;
}

export function Tabelle<T>({
  spalten,
  zeilen,
  schluessel,
  beschriftung,
  summe,
}: {
  spalten: Spalte<T>[];
  zeilen: T[];
  schluessel: (zeile: T, index: number) => string;
  beschriftung: string;
  /** Optionale Summenzeile (Tabellenfuß), mit denselben Spalten gerendert. */
  summe?: T;
}) {
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <caption className="sr-only">{beschriftung}</caption>
        <thead className="bg-slate-50 text-left text-slate-600">
          <tr>
            {spalten.map((s) => (
              <th
                key={s.titel}
                scope="col"
                className={`px-3 py-2 font-medium ${s.zahl ? 'text-right' : ''}`}
              >
                {s.titel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {zeilen.map((z, i) => (
            <tr key={schluessel(z, i)} className="border-t border-slate-100">
              {spalten.map((s) => (
                <td
                  key={s.titel}
                  className={`px-3 py-2 ${s.zahl ? 'text-right tabular-nums' : ''}`}
                >
                  {s.wert(z)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {summe !== undefined && (
          <tfoot className="border-t-2 border-slate-300 font-semibold">
            <tr>
              {spalten.map((s) => (
                <td
                  key={s.titel}
                  className={`px-3 py-2 ${s.zahl ? 'text-right tabular-nums' : ''}`}
                >
                  {s.wert(summe)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Begriffsliste (Name → Wert). */
export function Werte({ eintraege }: { eintraege: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 rounded border border-slate-200 bg-white p-4">
      {eintraege.map(([name, wert]) => (
        <div key={name} className="contents">
          <dt className="font-medium text-slate-700">{name}</dt>
          <dd className="tabular-nums">{wert}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Text zum `personen_hinweis` der API (Personenwerte fehlen, Architektur §7). */
export function personenHinweisText(hinweis: PersonenHinweis | null): string {
  switch (hinweis) {
    case 'Auswertungsstufe 0':
      return 'Personen werden in diesem Mandanten nicht ausgewertet (Auswertungsstufe 0).';
    case 'zu wenige Personen':
      return 'Zu wenige Personen für eine Auswertung – erst ab drei Personen sichtbar (Schutz vor Rückschlüssen).';
    case 'Rolle ohne Personensicht':
      return 'Ihre Rolle sieht keine Personenwerte.';
    default:
      return 'Keine Personenwerte verfügbar.';
  }
}
