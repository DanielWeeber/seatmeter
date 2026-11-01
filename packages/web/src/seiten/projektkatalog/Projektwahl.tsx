// Auswahlseite hinter dem Link des Hooks (`/projektwahl/<token>`): Anmeldung Pflicht (AuthTor), jede Rolle im
// Mandanten des Links, auch `entwickler`. Die erste Wahl gilt für das Repo bzw. die Sitzung ohne Repo.
import {
  projektwahlErgebnisSchema,
  type KatalogKurz,
  type ProjektwahlAntwort,
} from '@seatmeter/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { ApiFehler, useApi } from '../../api/client';
import { Abfrage, fehlertext, Hinweis } from '../../komponenten/Abfrage';
import { KNOPF_DUNKEL } from '../../komponenten/knoepfe';
import { projektwahlSchluessel, useProjektwahl } from './abfragen';
import { ProjektAuswahl, projektText } from './ProjektAuswahl';

export const TEXT_ZURUECK = 'Zurück in Claude Code den Prompt erneut senden.';

function Rahmen({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl p-4 md:p-8">
      <h1 className="text-xl font-semibold">Projekt wählen</h1>
      {children}
    </main>
  );
}

function Fertig({ p }: { p: KatalogKurz }) {
  return (
    <div role="status" className="mt-4 rounded border border-green-300 bg-green-50 p-4 text-sm">
      <p className="font-medium text-green-900">Zugeordnet zu {projektText(p)}.</p>
      <p className="mt-1 text-green-900">{TEXT_ZURUECK}</p>
    </div>
  );
}

function Wahl({ token, d }: { token: string; d: ProjektwahlAntwort }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [eigene, setEigene] = useState<KatalogKurz | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const waehlen = useMutation({
    mutationFn: (id: string) =>
      api.post('/api/v1/projektwahl', { token, katalog_projekt_id: id }, projektwahlErgebnisSchema),
    onSuccess: (e) => setEigene(e.zugeordnet),
    onError: (f) => {
      // Jemand anderes war schneller: Die erste Wahl gilt, die neu geladene Antwort zeigt sie.
      if (f instanceof ApiFehler && f.code === 'bereits_zugeordnet') {
        void queryClient.invalidateQueries({ queryKey: projektwahlSchluessel(token) });
      } else {
        setMeldung(f instanceof ApiFehler && f.art === 'http' ? f.message : fehlertext(f));
      }
    },
  });
  const fertig = eigene ?? d.zugeordnet;
  if (fertig) return <Fertig p={fertig} />;
  if (d.projekte.length === 0) return <Hinweis>Der Projektkatalog ist leer.</Hinweis>;
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-slate-700">
        {d.ziel.art === 'repo' ? (
          <>
            Zu welchem Projekt gehört das Repo <strong>{d.ziel.name}</strong>? Die Wahl gilt danach
            für alle in diesem Repo.
          </>
        ) : (
          'Diese Sitzung läuft in einem Ordner ohne Repo. Die Wahl gilt nur für diese Sitzung.'
        )}
      </p>
      <ProjektAuswahl projekte={d.projekte} gewaehlt={gewaehlt} onWahl={setGewaehlt} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={KNOPF_DUNKEL}
          disabled={!gewaehlt || waehlen.isPending}
          onClick={() => {
            setMeldung(null);
            if (gewaehlt) waehlen.mutate(gewaehlt);
          }}
        >
          Projekt zuordnen
        </button>
        {meldung && (
          <span role="alert" className="text-sm text-red-800">
            {meldung}
          </span>
        )}
      </div>
    </div>
  );
}

export function Projektwahl() {
  const { token = '' } = useParams();
  const abfrage = useProjektwahl(token);
  // Abgelaufene oder fremde Links: die Meldung des Servers sagt, was zu tun ist.
  const f = abfrage.error;
  if (f instanceof ApiFehler && f.art === 'http' && [400, 403, 410].includes(f.status)) {
    return (
      <Rahmen>
        <p role="alert" className="mt-4 rounded border border-red-300 bg-red-50 p-4 text-sm">
          {f.message}
        </p>
      </Rahmen>
    );
  }
  return (
    <Rahmen>
      <Abfrage abfrage={abfrage}>{(d) => <Wahl token={token} d={d} />}</Abfrage>
    </Rahmen>
  );
}
