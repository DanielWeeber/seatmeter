// Zeigt ein neues Ingest-Token genau einmal (Server speichert nur den Hash).
export function EinmalToken({ token, onFertig }: { token: string; onFertig: () => void }) {
  return (
    <div
      role="status"
      className="mt-4 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900"
    >
      <p className="font-medium">
        Neues Mandanten-Token – nur jetzt sichtbar, bitte sicher ablegen:
      </p>
      <code className="mt-2 block break-all rounded bg-white px-2 py-1 font-mono text-slate-900">
        {token}
      </code>
      <button
        type="button"
        onClick={onFertig}
        className="mt-3 rounded border border-green-400 bg-white px-3 py-1 hover:bg-green-100"
      >
        Gespeichert, ausblenden
      </button>
    </div>
  );
}
