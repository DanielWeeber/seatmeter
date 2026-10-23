// Text mit „Kopieren“-Knopf (Zwischenablage); schlägt das Kopieren fehl, steht der Text zum Markieren da.
import { useState } from 'react';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { kopieren } from './texte';

export function Kopierbar({ text, beschriftung }: { text: string; beschriftung: string }) {
  const [stand, setStand] = useState<'' | 'ok' | 'fehler'>('');
  return (
    <span className="inline-flex items-center gap-2">
      <code className="break-all rounded bg-slate-100 px-1.5 py-0.5">{text}</code>
      <button
        type="button"
        className={KNOPF_KLEIN}
        aria-label={`${beschriftung} kopieren`}
        onClick={() => void kopieren(text).then((ok) => setStand(ok ? 'ok' : 'fehler'))}
      >
        Kopieren
      </button>
      {stand === 'ok' && <span className="text-xs text-green-800">Kopiert.</span>}
      {stand === 'fehler' && (
        <span className="text-xs text-red-700">
          Kopieren nicht möglich, bitte von Hand markieren.
        </span>
      )}
    </span>
  );
}
