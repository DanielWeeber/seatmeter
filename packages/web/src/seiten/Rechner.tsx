// Rechner/Agenten: registrierte Rechner, Einmalcodes für `seatmeter-agent enroll`, Widerruf.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useRechner } from '../api/abfragen';
import { ApiFehler, istCsrfFehler, TEXT_CSRF, useApi } from '../api/client';
import { einmalcodeSchema, type Einmalcode, type Rechner as RechnerZeile } from '../api/typen';
import { useAuth } from '../auth/AuthTor';
import { Abfrage } from '../komponenten/Abfrage';
import { Abschnitt, Seitenkopf, Tabelle } from '../komponenten/Bausteine';
import { datum, datumZeit, LEER } from '../format';

const OS_NAMEN: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' };

function meldung(fehler: unknown, wofuer: string): string {
  if (istCsrfFehler(fehler)) return TEXT_CSRF;
  if (fehler instanceof ApiFehler && fehler.status === 403) return 'Dafür fehlt die Berechtigung.';
  if (fehler instanceof ApiFehler && fehler.status === 404)
    return `${wofuer} kann der Server noch nicht.`;
  return `${wofuer} fehlgeschlagen.`;
}

function CodeAnzeige({ code, onSchliessen }: { code: Einmalcode; onSchliessen: () => void }) {
  const [kopiert, setKopiert] = useState(false);
  const kopieren = async () => {
    try {
      await navigator.clipboard.writeText(code.code);
      setKopiert(true);
    } catch {
      setKopiert(false);
    }
  };
  return (
    <div role="status" className="mt-4 rounded border border-green-300 bg-green-50 p-4">
      <p className="text-sm font-medium text-green-900">
        Einmalcode – wird nur jetzt angezeigt, gültig bis {datumZeit(code.laeuft_ab)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code
          className="rounded bg-white px-2 py-1 text-lg tracking-wider"
          data-testid="einmalcode"
        >
          {code.code}
        </code>
        <button
          type="button"
          onClick={() => void kopieren()}
          className="rounded border border-green-400 bg-white px-2 py-1 text-sm hover:bg-green-100"
        >
          {kopiert ? 'Kopiert' : 'Kopieren'}
        </button>
        <button
          type="button"
          onClick={onSchliessen}
          className="rounded px-2 py-1 text-sm text-green-900 hover:underline"
        >
          Ausblenden
        </button>
      </div>
      <p className="mt-3 text-sm text-green-900">
        Auf dem Rechner ausführen:{' '}
        <code className="rounded bg-white px-1">seatmeter-agent enroll {code.code}</code>
      </p>
    </div>
  );
}

function CodeErzeugen() {
  const api = useApi();
  const [bezeichnung, setBezeichnung] = useState('');
  const [code, setCode] = useState<Einmalcode | null>(null);
  const erzeugen = useMutation({
    mutationFn: () =>
      api.post(
        '/api/v1/rechner/einmalcode',
        bezeichnung.trim() ? { bezeichnung: bezeichnung.trim() } : {},
        einmalcodeSchema,
      ),
    onSuccess: (neu) => {
      setCode(neu);
      setBezeichnung('');
    },
  });

  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setCode(null);
          erzeugen.mutate();
        }}
      >
        <label className="block flex-1 text-sm">
          <span className="block font-medium text-slate-700">Bezeichnung (optional)</span>
          <input
            value={bezeichnung}
            onChange={(e) => setBezeichnung(e.target.value)}
            placeholder="z. B. Notebook Entwicklung"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="submit"
          disabled={erzeugen.isPending}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          Einmalcode erzeugen
        </button>
      </form>
      {erzeugen.isError && (
        <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {meldung(erzeugen.error, 'Einmalcode erzeugen')}
        </p>
      )}
      {code && <CodeAnzeige code={code} onSchliessen={() => setCode(null)} />}
    </div>
  );
}

function Widerrufen({ rechner }: { rechner: RechnerZeile }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [frage, setFrage] = useState(false);
  const widerrufen = useMutation({
    mutationFn: () => api.post(`/api/v1/rechner/${encodeURIComponent(rechner.id)}/widerrufen`),
    onSuccess: () => {
      setFrage(false);
      return queryClient.invalidateQueries({ queryKey: ['rechner'] });
    },
  });
  const name = rechner.bezeichnung ?? 'Rechner';

  if (!frage)
    return (
      <button
        type="button"
        onClick={() => setFrage(true)}
        className="rounded border border-slate-300 px-2 py-0.5 text-sm hover:bg-slate-100"
        aria-label={`${name} widerrufen`}
      >
        Widerrufen
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-sm">Wirklich widerrufen?</span>
      <button
        type="button"
        onClick={() => widerrufen.mutate()}
        disabled={widerrufen.isPending}
        className="rounded bg-red-700 px-2 py-0.5 text-sm text-white hover:bg-red-800 disabled:opacity-50"
      >
        Ja, widerrufen
      </button>
      <button
        type="button"
        onClick={() => setFrage(false)}
        className="rounded px-2 py-0.5 text-sm hover:underline"
      >
        Abbrechen
      </button>
      {widerrufen.isError && (
        <span role="alert" className="text-sm text-red-800">
          {meldung(widerrufen.error, 'Widerrufen')}
        </span>
      )}
    </span>
  );
}

export function Rechner() {
  const { darfVerwalten } = useAuth();
  const abfrage = useRechner();

  return (
    <section>
      <Seitenkopf titel="Rechner/Agenten" />
      {darfVerwalten && (
        <Abschnitt titel="Rechner registrieren">
          <CodeErzeugen />
        </Abschnitt>
      )}
      <Abschnitt titel="Registrierte Rechner">
        <Abfrage
          abfrage={abfrage}
          istLeer={(d) => d.rechner.length === 0}
          leerText="Noch kein Rechner registriert."
        >
          {(d) => (
            <Tabelle<RechnerZeile>
              beschriftung="Registrierte Rechner"
              zeilen={d.rechner}
              schluessel={(r) => r.id}
              spalten={[
                { titel: 'Bezeichnung', wert: (r) => r.bezeichnung ?? LEER },
                {
                  titel: 'Person',
                  wert: (r) =>
                    r.person_pseudonym ? (
                      <code className="text-xs">{r.person_pseudonym}</code>
                    ) : (
                      LEER
                    ),
                },
                { titel: 'Betriebssystem', wert: (r) => (r.os ? (OS_NAMEN[r.os] ?? r.os) : LEER) },
                { titel: 'Agent-Version', wert: (r) => r.agent_version ?? LEER },
                { titel: 'Registriert', wert: (r) => datum(r.registriert) },
                // Nur der Tag, keine Uhrzeit: keine Zeitprofile je Person (Architektur §7).
                { titel: 'Zuletzt gesehen', wert: (r) => datum(r.zuletzt_gesehen) },
                {
                  titel: 'Status',
                  wert: (r) =>
                    r.widerrufen ? (
                      <span className="text-red-800">widerrufen</span>
                    ) : darfVerwalten ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <span className="text-green-800">aktiv</span>
                        <Widerrufen rechner={r} />
                      </span>
                    ) : (
                      <span className="text-green-800">aktiv</span>
                    ),
                },
              ]}
            />
          )}
        </Abfrage>
      </Abschnitt>
    </section>
  );
}
