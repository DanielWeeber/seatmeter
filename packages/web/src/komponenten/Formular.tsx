// Formular-Bausteine (Preise, Sitzkosten, Kurs, Einstellungen): beschriftete Felder mit optionaler
// Fehlermeldung je Feld, Formularrahmen mit Speichern-Knopf und Sammelmeldung.
import { useId, type FormEvent, type ReactNode } from 'react';
import { ApiFehler, istCsrfFehler, TEXT_CSRF } from '../api/client';

function FeldFehler({ id, fehler }: { id: string; fehler?: string | null }) {
  if (!fehler) return null;
  return (
    <span id={id} className="mt-1 block text-xs text-red-700">
      {fehler}
    </span>
  );
}

export function Eingabe({
  beschriftung,
  wert,
  onAendern,
  typ = 'text',
  dezimal,
  fehler,
  deaktiviert,
}: {
  beschriftung: string;
  wert: string;
  onAendern: (w: string) => void;
  typ?: string;
  dezimal?: boolean;
  fehler?: string | null;
  deaktiviert?: boolean;
}) {
  const fehlerId = useId();
  return (
    <label className="block text-sm">
      <span className="block font-medium text-slate-700">{beschriftung}</span>
      <input
        type={typ}
        value={wert}
        inputMode={dezimal ? 'decimal' : undefined}
        onChange={(e) => onAendern(e.target.value)}
        disabled={deaktiviert}
        aria-invalid={fehler ? true : undefined}
        aria-describedby={fehler ? fehlerId : undefined}
        className={`mt-1 w-full rounded border px-2 py-1 ${fehler ? 'border-red-400' : 'border-slate-300'}`}
      />
      <FeldFehler id={fehlerId} fehler={fehler} />
    </label>
  );
}

export function Auswahl({
  beschriftung,
  wert,
  onAendern,
  optionen,
  fehler,
}: {
  beschriftung: string;
  wert: string;
  onAendern: (w: string) => void;
  optionen: readonly (readonly [string, string])[];
  fehler?: string | null;
}) {
  const fehlerId = useId();
  return (
    <label className="block text-sm">
      <span className="block font-medium text-slate-700">{beschriftung}</span>
      <select
        value={wert}
        onChange={(e) => onAendern(e.target.value)}
        aria-invalid={fehler ? true : undefined}
        aria-describedby={fehler ? fehlerId : undefined}
        className={`mt-1 w-full rounded border bg-white px-2 py-1 ${fehler ? 'border-red-400' : 'border-slate-300'}`}
      >
        {optionen.map(([w, text]) => (
          <option key={w} value={w}>
            {text}
          </option>
        ))}
      </select>
      <FeldFehler id={fehlerId} fehler={fehler} />
    </label>
  );
}

export function Kontrollkaestchen({
  beschriftung,
  wert,
  onAendern,
}: {
  beschriftung: string;
  wert: boolean;
  onAendern: (w: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 self-end text-sm">
      <input type="checkbox" checked={wert} onChange={(e) => onAendern(e.target.checked)} />
      <span className="font-medium text-slate-700">{beschriftung}</span>
    </label>
  );
}

export function Formular({
  titel,
  onAbsenden,
  laeuft,
  meldung,
  erfolg,
  knopf = 'Speichern',
  children,
}: {
  titel: string;
  onAbsenden: () => void;
  laeuft: boolean;
  meldung: ReactNode;
  /** Erfolgsmeldung nach dem Speichern (role=status). */
  erfolg?: string | null;
  knopf?: string;
  children: ReactNode;
}) {
  return (
    <form
      noValidate
      aria-label={titel}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onAbsenden();
      }}
      className="mt-4 rounded border border-slate-200 bg-white p-4"
    >
      <h3 className="font-semibold">{titel}</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
      {meldung && (
        <div role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {meldung}
        </div>
      )}
      {erfolg && (
        <p role="status" className="mt-3 text-sm text-green-800">
          {erfolg}
        </p>
      )}
      <button
        type="submit"
        disabled={laeuft}
        className="mt-4 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {laeuft ? 'Speichere …' : knopf}
      </button>
    </form>
  );
}

/** Deutsche Meldung zu einem fehlgeschlagenen Speichern (403, 404, 409, Prüffehler des Servers). */
export function fehlerBeimSpeichern(fehler: unknown): string {
  if (fehler instanceof ApiFehler) {
    if (istCsrfFehler(fehler)) return TEXT_CSRF;
    if (fehler.status === 403) return 'Dafür fehlt die Berechtigung.';
    if (fehler.status === 404) return 'Der Server kann das noch nicht speichern.';
    if (fehler.status === 409) return 'Für diesen Tag gibt es schon eine Zeile.';
    if (fehler.status === 400 && fehler.details.length > 0)
      return `Speichern abgelehnt: ${fehler.details.map((d) => d.meldung).join('; ')}`;
    return `Speichern fehlgeschlagen: ${fehler.message}`;
  }
  return 'Speichern fehlgeschlagen.';
}
