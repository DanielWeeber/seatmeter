// Schreibgeschütztes Geheimnis-Feld: Passwortfeld, das den gespeicherten Wert nie anzeigt.
// Leer lassen = unverändert (Platzhalter „unverändert“), Text = neu setzen, Kästchen = löschen.
import { useId } from 'react';

export interface GeheimnisWert {
  text: string;
  loeschen: boolean;
}

export const GEHEIMNIS_LEER: GeheimnisWert = { text: '', loeschen: false };

/** Wert für `geheimnis` im Request: weglassen (unverändert), `null` (löschen) oder der neue Text. */
export function geheimnisFuerRequest(w: GeheimnisWert): { geheimnis?: string | null } {
  if (w.loeschen) return { geheimnis: null };
  return w.text !== '' ? { geheimnis: w.text } : {};
}

export function Geheimnisfeld({
  beschriftung,
  gesetzt,
  wert,
  onAendern,
  fehler,
  loeschbar = true,
}: {
  beschriftung: string;
  /** Der Server hat bereits ein Geheimnis gespeichert (`geheimnis_gesetzt`). */
  gesetzt: boolean;
  wert: GeheimnisWert;
  onAendern: (w: GeheimnisWert) => void;
  fehler?: string | null;
  /** Kästchen „Gespeichertes Geheimnis löschen“ anbieten (sonst löscht ein eigener Knopf). */
  loeschbar?: boolean;
}) {
  const fehlerId = useId();
  return (
    <div className="text-sm">
      <label className="block">
        <span className="block font-medium text-slate-700">{beschriftung}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={wert.text}
          placeholder={gesetzt ? 'unverändert' : ''}
          disabled={wert.loeschen}
          onChange={(e) => onAendern({ text: e.target.value, loeschen: false })}
          aria-invalid={fehler ? true : undefined}
          aria-describedby={fehler ? fehlerId : undefined}
          className={`mt-1 w-full rounded border px-2 py-1 ${fehler ? 'border-red-400' : 'border-slate-300'}`}
        />
      </label>
      {fehler && (
        <span id={fehlerId} className="mt-1 block text-xs text-red-700">
          {fehler}
        </span>
      )}
      {gesetzt && loeschbar && (
        <label className="mt-1 flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={wert.loeschen}
            onChange={(e) => onAendern({ text: '', loeschen: e.target.checked })}
          />
          Gespeichertes Geheimnis löschen
        </label>
      )}
    </div>
  );
}
