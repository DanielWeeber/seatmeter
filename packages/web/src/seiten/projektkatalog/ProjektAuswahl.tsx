// Durchsuchbare Projektliste als Baum für die Zuordnung und die Auswahlseite: Jedes aktive Projekt ist wählbar, auf jeder
// Ebene; inaktive Vorfahren stehen als Kontext dabei. Suche über Nummer, Name und Kunde, Filter
// je Kunde. Bewusst ohne Eintrag „Kein Projekt“: Wer die Liste öffnet, wählt ein Projekt aus dem Katalog.
import {
  katalogBaumBauen,
  katalogBaumFiltern,
  type KatalogBaumTreffer,
  type KatalogBaumZeile,
  type KatalogKurz,
} from '@seatmeter/shared';
import { useId, useMemo, useState } from 'react';

/** Mehr Treffer zeigt die Liste nicht; die Suche grenzt weiter ein. */
export const AUSWAHL_MAX_TREFFER = 100;

/**
 * Treffer für Suchtext und Kunde plus ihre Vorfahren als Kontext, in Baumreihenfolge; alle Wörter müssen vorkommen,
 * Groß-/Kleinschreibung egal. Vorfahren bleiben sichtbar, auch wenn sie selbst nicht passen.
 */
export function filtereBaum<T extends KatalogKurz>(
  baum: readonly KatalogBaumZeile<T>[],
  suche: string,
  kunde: string,
): KatalogBaumTreffer<T>[] {
  const woerter = suche.toLowerCase().split(/\s+/).filter(Boolean);
  return katalogBaumFiltern(baum, (p) => {
    if (kunde && p.kunde !== kunde) return false;
    const text = `${p.nummer} ${p.name} ${p.kunde ?? ''}`.toLowerCase();
    return woerter.every((w) => text.includes(w));
  });
}

/** Bestätigung und gewählter Wert: mit vollem Pfad, z. B. `P-1 – Webshop › AP Login`. */
export function projektText(p: Pick<KatalogKurz, 'nummer' | 'pfad' | 'kunde'>): string {
  return `${p.nummer} – ${p.pfad}${p.kunde ? ` (${p.kunde})` : ''}`;
}

/** Zeile der Liste: Die Einrückung zeigt die Hierarchie, darum nur der eigene Name. */
function zeilenText(p: Pick<KatalogKurz, 'nummer' | 'name' | 'kunde'>): string {
  return `${p.nummer} – ${p.name}${p.kunde ? ` (${p.kunde})` : ''}`;
}

const einzug = (tiefe: number) => ({ paddingLeft: `${0.75 + tiefe * 1.25}rem` });

export function ProjektAuswahl({
  projekte,
  gewaehlt,
  onWahl,
}: {
  projekte: readonly KatalogKurz[];
  gewaehlt: string | null;
  onWahl: (id: string) => void;
}) {
  const name = useId();
  const [suche, setSuche] = useState('');
  const [kunde, setKunde] = useState('');
  const kunden = useMemo(
    () =>
      [...new Set(projekte.flatMap((p) => (p.kunde ? [p.kunde] : [])))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [projekte],
  );
  const baum = useMemo(() => katalogBaumBauen(projekte), [projekte]);
  const zeilen = useMemo(() => filtereBaum(baum, suche, kunde), [baum, suche, kunde]);
  const sichtbar = zeilen.slice(0, AUSWAHL_MAX_TREFFER);
  // Gezählt wird, was man wählen kann; inaktive Vorfahren sind nur Kontext.
  const treffer = useMemo(
    () => zeilen.filter((z) => z.treffer && z.projekt.aktiv).length,
    [zeilen],
  );
  const gesamt = useMemo(() => projekte.filter((p) => p.aktiv).length, [projekte]);
  const gewaehltesProjekt = useMemo(
    () => projekte.find((p) => p.id === gewaehlt) ?? null,
    [projekte, gewaehlt],
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <label className="min-w-48 flex-1 text-sm">
          <span className="block font-medium text-slate-700">Projekt suchen</span>
          <input
            type="search"
            value={suche}
            onChange={(e) => setSuche(e.target.value)}
            placeholder="Nummer, Name oder Kunde"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        {kunden.length > 0 && (
          <label className="text-sm">
            <span className="block font-medium text-slate-700">Kunde</span>
            <select
              value={kunde}
              onChange={(e) => setKunde(e.target.value)}
              className="mt-1 rounded border border-slate-300 bg-white px-2 py-1"
            >
              <option value="">Alle Kunden</option>
              {kunden.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-xs text-slate-500" aria-live="polite">
        {treffer} von {gesamt} Projekten
        {zeilen.length > AUSWAHL_MAX_TREFFER
          ? `, die ersten ${AUSWAHL_MAX_TREFFER} Zeilen angezeigt; bitte Suche eingrenzen`
          : ''}
      </p>
      <fieldset className="max-h-72 overflow-y-auto rounded border border-slate-200 bg-white">
        <legend className="sr-only">Projekte</legend>
        {sichtbar.map(({ projekt: p, tiefe, treffer: passt }) =>
          p.aktiv ? (
            <label
              key={p.id}
              style={einzug(tiefe)}
              className={`flex cursor-pointer items-start gap-2 border-b border-slate-100 py-2 pr-3 text-sm hover:bg-slate-50 ${passt ? '' : 'text-slate-500'}`}
            >
              <input
                type="radio"
                name={name}
                value={p.id}
                checked={gewaehlt === p.id}
                onChange={() => onWahl(p.id)}
                className="mt-1"
              />
              <span>{zeilenText(p)}</span>
            </label>
          ) : (
            // Inaktiver Vorfahre: nur Kontext für die Kinder, nicht wählbar.
            <div
              key={p.id}
              style={einzug(tiefe)}
              aria-disabled="true"
              className="border-b border-slate-100 py-2 pr-3 text-sm italic text-slate-400"
            >
              {zeilenText(p)} (inaktiv)
            </div>
          ),
        )}
        {sichtbar.length === 0 && (
          <p className="px-3 py-2 text-sm text-slate-600">Kein Projekt gefunden.</p>
        )}
      </fieldset>
      {gewaehltesProjekt && (
        <p role="status" className="text-sm text-slate-700">
          Gewählt: {projektText(gewaehltesProjekt)}
        </p>
      )}
    </div>
  );
}
