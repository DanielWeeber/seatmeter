// Abschnitt „SCIM (Benutzer-Synchronisation)“ von SSO und Konten: Basis-URL, SCIM-Tokens (Klartext nur
// einmal bei der Erzeugung) und Kennzahlen der Synchronisation. Anleitung: docs/SSO-und-SCIM.md, Teil 2.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/client';
import { datumZeit } from '../../format';
import { Abfrage, Hinweis } from '../../komponenten/Abfrage';
import { Abschnitt, Tabelle } from '../../komponenten/Bausteine';
import { Eingabe, Formular } from '../../komponenten/Formular';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { useState } from 'react';
import { scimTokenNeuSchema, scimTokensSchema, type ScimToken } from './api';
import { mandantPfad } from '../mandant/api';
import { Kopierbar } from './Kopierbar';
import { scimBasisUrl, ssoFehler } from './texte';

function Widerrufen({ t, mandantId }: { t: ScimToken; mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [frage, setFrage] = useState(false);
  const widerrufen = useMutation({
    mutationFn: () =>
      api.delete(mandantPfad(mandantId, `/scim-tokens/${encodeURIComponent(t.id)}`)),
    onSuccess: () => {
      setFrage(false);
      void queryClient.invalidateQueries({ queryKey: ['sso', mandantId, 'scim'] });
    },
  });
  if (!frage)
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
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>Wirklich widerrufen? Die Synchronisation mit diesem Token stoppt sofort.</span>
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
          {ssoFehler(widerrufen.error)}
        </span>
      )}
    </span>
  );
}

export function Scim({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [bezeichnung, setBezeichnung] = useState('');
  const [neuesToken, setNeuesToken] = useState<string | null>(null);
  const schluessel = ['sso', mandantId, 'scim'];
  const abfrage = useQuery({
    queryKey: schluessel,
    queryFn: () => api.get(mandantPfad(mandantId, '/scim-tokens'), scimTokensSchema),
  });
  const erzeugen = useMutation({
    mutationFn: () =>
      api.post(
        mandantPfad(mandantId, '/scim-tokens'),
        bezeichnung.trim() ? { bezeichnung: bezeichnung.trim() } : {},
        scimTokenNeuSchema,
      ),
    onSuccess: (antwort) => {
      setNeuesToken(antwort.token);
      setBezeichnung('');
      void queryClient.invalidateQueries({ queryKey: schluessel });
    },
  });
  return (
    <Abschnitt titel="SCIM (Benutzer-Synchronisation)">
      <Abfrage abfrage={abfrage}>
        {(d) => (
          <>
            <p className="text-sm">
              Basis-URL:{' '}
              <Kopierbar text={scimBasisUrl(d.basis_url)} beschriftung="SCIM-Basis-URL" />
            </p>
            <Hinweis>
              In Entra ID bzw. Okta als Tenant-URL/Base URL eintragen, Authentifizierung:
              Bearer-Token. Anleitung: docs/SSO-und-SCIM.md, Teil 2.
            </Hinweis>
            <ul className="mt-3 text-sm">
              <li>
                Letzte Synchronisation:{' '}
                {d.letzte_synchronisation ? datumZeit(d.letzte_synchronisation) : 'noch keine'}
              </li>
              <li>Synchronisierte Konten: {d.konten_synchronisiert}</li>
              <li>Gruppen: {d.gruppen_synchronisiert}</li>
            </ul>
            {neuesToken && (
              <div
                role="status"
                className="mt-4 rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900"
              >
                <p className="font-medium">Neues SCIM-Token. Wird nur jetzt angezeigt:</p>
                <p className="mt-2">
                  <Kopierbar text={neuesToken} beschriftung="SCIM-Token" />
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
            {d.tokens.length === 0 ? (
              <Hinweis>Noch kein SCIM-Token.</Hinweis>
            ) : (
              <Tabelle<ScimToken>
                beschriftung="SCIM-Tokens"
                zeilen={d.tokens}
                schluessel={(t) => t.id}
                spalten={[
                  { titel: 'Präfix', wert: (t) => t.praefix },
                  { titel: 'Bezeichnung', wert: (t) => t.bezeichnung ?? '–' },
                  { titel: 'Erstellt', wert: (t) => (t.erstellt ? datumZeit(t.erstellt) : '–') },
                  {
                    titel: 'Zuletzt genutzt',
                    wert: (t) => (t.zuletzt_genutzt ? datumZeit(t.zuletzt_genutzt) : 'nie'),
                  },
                  {
                    titel: 'Status',
                    wert: (t) =>
                      t.widerrufen ? `widerrufen am ${datumZeit(t.widerrufen)}` : 'aktiv',
                  },
                  {
                    titel: 'Aktion',
                    wert: (t) => (t.widerrufen ? '–' : <Widerrufen t={t} mandantId={mandantId} />),
                  },
                ]}
              />
            )}
          </>
        )}
      </Abfrage>
      <Formular
        titel="SCIM-Token erzeugen"
        knopf="Erzeugen"
        onAbsenden={() => erzeugen.mutate()}
        laeuft={erzeugen.isPending}
        meldung={erzeugen.isError ? ssoFehler(erzeugen.error) : null}
      >
        <Eingabe
          beschriftung="Bezeichnung (optional, z. B. Entra ID)"
          wert={bezeichnung}
          onAendern={setBezeichnung}
        />
      </Formular>
    </Abschnitt>
  );
}
