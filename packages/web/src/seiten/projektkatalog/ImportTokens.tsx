// Abschnitt „API-Tokens“ der Seite Projektkatalog: Token je Zweck, Push aus dem Quellsystem oder CSV-Upload. Der Klartext
// steht nur einmal in der Antwort beim Erzeugen. Anleitung: docs/Projektkatalog.md.
import {
  katalogTokenListeSchema,
  katalogTokenNeuSchema,
  type KatalogToken,
  type KatalogTokenScope,
} from '@seatmeter/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../api/client';
import { datumZeit } from '../../format';
import { Hinweis } from '../../komponenten/Abfrage';
import { Abschnitt, Tabelle } from '../../komponenten/Bausteine';
import { Auswahl, Eingabe, Formular } from '../../komponenten/Formular';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { speicherFehler, ZugriffAbfrage } from '../../komponenten/Zugriff';
import { Kopierbar } from '../sso/Kopierbar';

export const TOKENS_SCHLUESSEL = ['projektkatalog', 'tokens'] as const;

export const TEXT_IMPORT_TOKENS =
  'Ein Token gilt nur für diesen Mandanten und nur für seinen Zweck. Das Mandanten-Token aus „Ausrollen“ funktioniert ' +
  'hier nicht.';

const ZWECK: Record<KatalogTokenScope, string> = {
  katalog_api: 'Push aus dem Quellsystem',
  csv_import: 'CSV-Upload',
  sync_status: 'Überwachung (nur Sync-Status lesen)',
};

const ZWECK_OPTIONEN = [
  ['katalog_api', ZWECK.katalog_api],
  ['csv_import', ZWECK.csv_import],
  ['sync_status', ZWECK.sync_status],
] as const;

function Widerrufen({ t }: { t: KatalogToken }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [frage, setFrage] = useState(false);
  const widerrufen = useMutation({
    mutationFn: () => api.delete(`/api/v1/projektkatalog/tokens/${encodeURIComponent(t.id)}`),
    onSuccess: () => {
      setFrage(false);
      void queryClient.invalidateQueries({ queryKey: TOKENS_SCHLUESSEL });
    },
  });
  if (!frage) {
    return (
      <button
        type="button"
        className={KNOPF_KLEIN}
        aria-label={`Token ${t.praefix} widerrufen`}
        onClick={() => setFrage(true)}
      >
        Widerrufen
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>Wirklich widerrufen? Geplante Importe mit diesem Token schlagen dann fehl.</span>
      <button
        type="button"
        className={KNOPF_KLEIN}
        aria-label={`Token ${t.praefix} endgültig widerrufen`}
        disabled={widerrufen.isPending}
        onClick={() => widerrufen.mutate()}
      >
        Ja, widerrufen
      </button>
      <button type="button" className={KNOPF_KLEIN} onClick={() => setFrage(false)}>
        Abbrechen
      </button>
      {widerrufen.isError && (
        <span role="alert" className="text-red-800">
          {speicherFehler(widerrufen.error)}
        </span>
      )}
    </span>
  );
}

export function ImportTokens() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [bezeichnung, setBezeichnung] = useState('');
  const [scope, setScope] = useState<KatalogTokenScope>('katalog_api');
  const [neuesToken, setNeuesToken] = useState<string | null>(null);
  const abfrage = useQuery({
    queryKey: TOKENS_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/projektkatalog/tokens', katalogTokenListeSchema),
  });
  const erzeugen = useMutation({
    mutationFn: () =>
      api.post(
        '/api/v1/projektkatalog/tokens',
        { bezeichnung: bezeichnung.trim(), scope },
        katalogTokenNeuSchema,
      ),
    onSuccess: (antwort) => {
      setNeuesToken(antwort.token);
      setBezeichnung('');
      void queryClient.invalidateQueries({ queryKey: TOKENS_SCHLUESSEL });
    },
  });
  return (
    <Abschnitt titel="API-Tokens">
      <p className="text-sm text-slate-600">{TEXT_IMPORT_TOKENS}</p>
      {neuesToken && (
        <div
          role="status"
          className="mt-3 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900"
        >
          <p className="font-medium">Neues Token. Wird nur jetzt angezeigt:</p>
          <p className="mt-2">
            <Kopierbar text={neuesToken} beschriftung="Token" />
          </p>
          <button
            type="button"
            onClick={() => setNeuesToken(null)}
            className="mt-3 rounded border border-green-400 bg-white px-3 py-1 hover:bg-green-100"
          >
            Gespeichert, ausblenden
          </button>
        </div>
      )}
      <ZugriffAbfrage abfrage={abfrage}>
        {(d) =>
          d.tokens.length === 0 ? (
            <Hinweis>Noch kein Token.</Hinweis>
          ) : (
            <Tabelle<KatalogToken>
              beschriftung="API-Tokens"
              zeilen={d.tokens}
              schluessel={(t) => t.id}
              spalten={[
                { titel: 'Bezeichnung', wert: (t) => t.bezeichnung },
                { titel: 'Zweck', wert: (t) => ZWECK[t.scope] },
                { titel: 'Präfix', wert: (t) => t.praefix },
                { titel: 'Erstellt', wert: (t) => datumZeit(t.erstellt) },
                {
                  titel: 'Zuletzt genutzt',
                  wert: (t) => (t.zuletzt_genutzt ? datumZeit(t.zuletzt_genutzt) : 'nie'),
                },
                {
                  titel: 'Status',
                  wert: (t) =>
                    t.widerrufen ? `widerrufen am ${datumZeit(t.widerrufen)}` : 'aktiv',
                },
                { titel: 'Aktion', wert: (t) => (t.widerrufen ? '–' : <Widerrufen t={t} />) },
              ]}
            />
          )
        }
      </ZugriffAbfrage>
      <Formular
        titel="Token erzeugen"
        knopf="Token erzeugen"
        onAbsenden={() => erzeugen.mutate()}
        laeuft={erzeugen.isPending}
        meldung={erzeugen.isError ? speicherFehler(erzeugen.error) : null}
      >
        <Eingabe beschriftung="Bezeichnung" wert={bezeichnung} onAendern={setBezeichnung} />
        <Auswahl
          beschriftung="Zweck"
          wert={scope}
          onAendern={(w) => setScope(w as KatalogTokenScope)}
          optionen={ZWECK_OPTIONEN}
        />
      </Formular>
    </Abschnitt>
  );
}
