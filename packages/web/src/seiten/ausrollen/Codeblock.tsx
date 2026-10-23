// Codeblock mit „Kopieren“-Knopf für die Schnipsel der Seite „Ausrollen“. Ohne Zwischenablage
// (z. B. Dashboard ohne HTTPS) wird der Text markiert und ein Hinweis zum manuellen Kopieren gezeigt.
import { useRef, useState } from 'react';

function markieren(element: HTMLElement | null): void {
  if (!element) return;
  try {
    const auswahl = window.getSelection();
    const bereich = document.createRange();
    bereich.selectNodeContents(element);
    auswahl?.removeAllRanges();
    auswahl?.addRange(bereich);
  } catch {
    // ohne Markierung bleibt der Hinweis
  }
}

export function Codeblock({
  id,
  inhalt,
  beschriftung,
}: {
  /** Kurzname für `data-testid="schnipsel-<id>"`. */
  id: string;
  inhalt: string;
  /** Dateiname oder Zweck, steht über dem Block und im Namen des Knopfs. */
  beschriftung: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  // Gilt nur für den Inhalt, der kopiert wurde; ändert sich der Schnipsel, steht wieder „Kopieren“.
  const [zustand, setZustand] = useState<{ fuer: string; art: 'kopiert' | 'manuell' } | null>(null);
  const art = zustand?.fuer === inhalt ? zustand.art : null;

  const kopieren = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Zwischenablage fehlt');
      await navigator.clipboard.writeText(inhalt);
      setZustand({ fuer: inhalt, art: 'kopiert' });
    } catch {
      markieren(ref.current);
      setZustand({ fuer: inhalt, art: 'manuell' });
    }
  };

  return (
    <figure className="mt-3 overflow-hidden rounded border border-slate-200 bg-white">
      <figcaption className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-sm">
        <span className="break-all font-mono text-slate-700">{beschriftung}</span>
        <button
          type="button"
          onClick={() => void kopieren()}
          aria-label={`${beschriftung} kopieren`}
          className="shrink-0 rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
        >
          {art === 'kopiert' ? 'Kopiert' : 'Kopieren'}
        </button>
      </figcaption>
      <pre
        ref={ref}
        data-testid={`schnipsel-${id}`}
        className="overflow-x-auto p-3 text-xs leading-relaxed"
      >
        <code>{inhalt}</code>
      </pre>
      {art === 'manuell' && (
        <p
          role="status"
          className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Automatisches Kopieren ist hier nicht möglich (z. B. ohne HTTPS). Der Text ist markiert –
          bitte mit Strg+C bzw. ⌘C kopieren.
        </p>
      )}
    </figure>
  );
}
