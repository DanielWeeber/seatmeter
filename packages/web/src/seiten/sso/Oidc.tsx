// Abschnitt „OIDC“ von SSO und Konten: Anmeldung des Mandanten über seinen eigenen Identity Provider.
// Das Client-Secret geht nur hin (leer = behalten) und kommt nie zurück (`client_secret_gesetzt`).
// Ist ein Anbieter über `SEATMETER_OIDC_*` eingerichtet, steht er hier lesend obenan, und das Formular für eine eigene Anbindung
// ist zugeklappt: Sonst sieht es so aus, als fehle die Anmeldung, und jemand richtet eine zweite ein.
import type { MandantOidcGlobal } from '@seatmeter/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/client';
import { datumZeit } from '../../format';
import { Abfrage, Hinweis } from '../../komponenten/Abfrage';
import { Abschnitt, Tabelle, Werte } from '../../komponenten/Bausteine';
import { Eingabe, Formular, Kontrollkaestchen } from '../../komponenten/Formular';
import { GEHEIMNIS_LEER, Geheimnisfeld } from '../../komponenten/Geheimnisfeld';
import { KNOPF } from '../../komponenten/knoepfe';
import { useState } from 'react';
import { oidcAntwortSchema, oidcPruefungSchema, type OidcAntwort, type OidcPruefung } from './api';
import { mandantPfad } from '../mandant/api';
import { Kopierbar } from './Kopierbar';
import { gruppenAlsText, gruppenAusText, ssoFehler } from './texte';

const STANDARD_SCOPES = 'openid profile email groups';

export const TITEL_SERVER = 'Anmeldung über die Serverkonfiguration';
export const TEXT_SERVER =
  'Diese Anmeldung wird in den Einstellungen SEATMETER_OIDC_* des Servers gepflegt und lässt sich hier nicht ändern.';
export const TEXT_KEINE_GRUPPEN =
  'Keine Gruppe ist diesem Mandanten zugeordnet. Über diese Anmeldung bekommt darum niemand eine Rolle. Rollen vergeben Sie dann unter „Konten“.';
export const KNOPF_EIGENE = 'Eigene Anbindung für diesen Mandant einrichten';
/** Belegt in `oidc-global-anzeige.test.ts`. */
export const textWeg = (global: string) =>
  `Eine eigene Anbindung ersetzt die Serverkonfiguration nicht: Der Knopf „Mit ${global} anmelden“ bleibt auf der Anmeldeseite, und wer eine verifizierte E-Mail-Domain dieses Mandanten oder sein Kürzel eingibt, kommt zur eigenen Anbindung.`;
export const textBeide = (global: string, eigen: string) =>
  `Beide gelten: Der Knopf „Mit ${global} anmelden“ führt zur Serverkonfiguration, eine verifizierte E-Mail-Domain dieses Mandanten oder sein Kürzel zu „${eigen}“.`;
export const TEXT_KONTEN =
  'Mit einem anderen Issuer entsteht über die eigene Anbindung ein eigenes Konto ohne die bisherigen Rollen, und die Serverkonfiguration entzieht in diesem Mandanten keine Rolle mehr, sobald keine Gruppe eines Kontos mehr auf ihn zeigt.';
export const TEXT_INAKTIV =
  'Die eigene Anbindung ist inaktiv. Es gilt nur die Serverkonfiguration, sie vergibt und entzieht Rollen wie ohne eigene Anbindung.';

function Pruefung({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const pruefen = useMutation({
    mutationFn: () => api.post(mandantPfad(mandantId, '/oidc/pruefen'), {}, oidcPruefungSchema),
  });
  const ergebnis: OidcPruefung | undefined = pruefen.data;
  return (
    <div className="mt-4">
      <button
        type="button"
        className={KNOPF}
        disabled={pruefen.isPending}
        onClick={() => pruefen.mutate()}
      >
        {pruefen.isPending ? 'Prüfe …' : 'Verbindung prüfen'}
      </button>
      {pruefen.isError && (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {ssoFehler(pruefen.error)}
        </p>
      )}
      {ergebnis && ergebnis.ok && (
        <div role="status" className="mt-2 text-sm text-green-800">
          <p>Verbindung in Ordnung{ergebnis.issuer ? ` (${ergebnis.issuer})` : ''}.</p>
          {ergebnis.endpunkte && (
            <ul className="mt-1 list-disc pl-5 text-slate-700">
              <li>Authorization: {ergebnis.endpunkte.authorization ?? '–'}</li>
              <li>Token: {ergebnis.endpunkte.token ?? '–'}</li>
              <li>Userinfo: {ergebnis.endpunkte.userinfo ?? '–'}</li>
              <li>Abmeldung: {ergebnis.endpunkte.end_session ?? '–'}</li>
            </ul>
          )}
        </div>
      )}
      {ergebnis && !ergebnis.ok && (
        <p role="alert" className="mt-2 text-sm text-red-800">
          Verbindung fehlgeschlagen: {ergebnis.fehler ?? 'unbekannter Fehler'}
        </p>
      )}
    </div>
  );
}

function OidcFormular({ d, mandantId }: { d: OidcAntwort; mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const k = d.konfiguration;
  const [issuer, setIssuer] = useState(k?.issuer ?? '');
  const [clientId, setClientId] = useState(k?.client_id ?? '');
  const [secret, setSecret] = useState(GEHEIMNIS_LEER);
  const [bezeichnung, setBezeichnung] = useState(k?.bezeichnung ?? '');
  const [scopes, setScopes] = useState(k?.scopes ?? STANDARD_SCOPES);
  const [gruppen, setGruppen] = useState(k ? gruppenAlsText(k.gruppen_rollen) : '');
  const [aktiv, setAktiv] = useState(k?.aktiv ?? true);
  const [pruefFehler, setPruefFehler] = useState<string | null>(null);
  const [entfernenFrage, setEntfernenFrage] = useState(false);

  const neu = () => void queryClient.invalidateQueries({ queryKey: ['sso', mandantId, 'oidc'] });

  const speichern = useMutation({
    mutationFn: (gruppenRollen: Record<string, string[]>) =>
      api.put(
        mandantPfad(mandantId, '/oidc'),
        {
          issuer: issuer.trim(),
          client_id: clientId.trim(),
          ...(secret.text !== '' ? { client_secret: secret.text } : {}),
          scopes: scopes.trim() || STANDARD_SCOPES,
          bezeichnung: bezeichnung.trim(),
          gruppen_rollen: gruppenRollen,
          aktiv,
        },
        oidcAntwortSchema,
      ),
    onSuccess: () => {
      setSecret(GEHEIMNIS_LEER);
      neu();
    },
  });
  const entfernen = useMutation({
    mutationFn: () => api.delete(mandantPfad(mandantId, '/oidc')),
    onSuccess: () => {
      setEntfernenFrage(false);
      neu();
    },
  });

  const absenden = () => {
    const g = gruppenAusText(gruppen);
    if (!g.ok) {
      setPruefFehler(g.fehler);
      return;
    }
    if (!issuer.trim() || !clientId.trim() || !bezeichnung.trim()) {
      setPruefFehler('Issuer-URL, Client-ID und Bezeichnung sind Pflicht.');
      return;
    }
    if (!k && secret.text === '') {
      setPruefFehler('Beim ersten Speichern ist ein Client-Secret nötig.');
      return;
    }
    setPruefFehler(null);
    speichern.mutate(g.wert);
  };

  const testLink = `${d.start_url}${d.start_url.includes('?') ? '&' : '?'}ziel=${encodeURIComponent('/einrichtung/sso')}`;

  return (
    <>
      {d.redirect_uri && (
        <p className="mt-2 text-sm text-slate-700">
          Redirect-URI für den Identity Provider:{' '}
          <Kopierbar text={d.redirect_uri} beschriftung="Redirect-URI" />
        </p>
      )}
      {k?.zuletzt_geprueft && (
        <p className="mt-1 text-xs text-slate-500">
          Zuletzt geprüft: {datumZeit(k.zuletzt_geprueft)}
        </p>
      )}
      <Formular
        titel="OIDC-Anbindung"
        onAbsenden={absenden}
        laeuft={speichern.isPending}
        meldung={pruefFehler ?? (speichern.isError ? ssoFehler(speichern.error) : null)}
        erfolg={speichern.isSuccess ? 'Gespeichert.' : null}
      >
        <Eingabe beschriftung="Issuer-URL" wert={issuer} onAendern={setIssuer} />
        <Eingabe beschriftung="Client-ID" wert={clientId} onAendern={setClientId} />
        <Geheimnisfeld
          beschriftung="Client-Secret"
          gesetzt={!!k?.client_secret_gesetzt}
          wert={secret}
          onAendern={setSecret}
          loeschbar={false}
        />
        {k?.client_secret_gesetzt && (
          <p className="self-end text-xs text-slate-600">Client-Secret ist gesetzt.</p>
        )}
        <Eingabe
          beschriftung="Bezeichnung (Knopftext)"
          wert={bezeichnung}
          onAendern={setBezeichnung}
        />
        <Eingabe beschriftung="Scopes" wert={scopes} onAendern={setScopes} />
        <label className="block text-sm sm:col-span-2">
          <span className="block font-medium text-slate-700">Gruppen → Rollen</span>
          <textarea
            value={gruppen}
            onChange={(e) => setGruppen(e.target.value)}
            rows={4}
            placeholder="seatmeter-admins → mandanten_admin"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Eine Zeile je Gruppe: „Gruppe → Rolle, Rolle“. Rollen: mandanten_admin, projektleiter,
            controller, betriebsrat, entwickler.
          </span>
        </label>
        <Kontrollkaestchen beschriftung="Aktiv" wert={aktiv} onAendern={setAktiv} />
      </Formular>

      {k && (
        <>
          <Pruefung mandantId={mandantId} />
          <p className="mt-4 text-sm">
            <a href={testLink} className="text-slate-900 underline">
              Testanmeldung
            </a>{' '}
            <span className="text-xs text-slate-500">
              (meldet dich über den Identity Provider an und führt hierher zurück)
            </span>
          </p>
          <div className="mt-4">
            {entfernenFrage ? (
              <div
                role="alertdialog"
                className="rounded border border-red-300 bg-red-50 p-3 text-sm"
              >
                <p>
                  OIDC-Anbindung wirklich entfernen? Konten melden sich danach nur noch mit Passwort
                  an.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={KNOPF}
                    disabled={entfernen.isPending}
                    onClick={() => entfernen.mutate()}
                  >
                    Ja, entfernen
                  </button>
                  <button type="button" className={KNOPF} onClick={() => setEntfernenFrage(false)}>
                    Abbrechen
                  </button>
                </div>
                {entfernen.isError && (
                  <p role="alert" className="mt-2 text-red-800">
                    {ssoFehler(entfernen.error)}
                  </p>
                )}
              </div>
            ) : (
              <button type="button" className={KNOPF} onClick={() => setEntfernenFrage(true)}>
                Anbindung entfernen
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function ServerKonfiguration({ g }: { g: MandantOidcGlobal }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold">{TITEL_SERVER}</h3>
      <Werte
        eintraege={[
          ['Bezeichnung', g.bezeichnung],
          ['Issuer-URL', g.issuer],
          ['Client-ID', g.client_id],
          ['Scopes', g.scopes],
          ['Redirect-URI', g.redirect_uri],
        ]}
      />
      <p className="mt-2 text-sm text-slate-700">{TEXT_SERVER}</p>
      {g.gruppen.length > 0 ? (
        <div className="mt-2">
          <Tabelle
            beschriftung="Gruppen der Serverkonfiguration"
            zeilen={g.gruppen}
            schluessel={(z) => z.gruppe}
            spalten={[
              { titel: 'Gruppe', wert: (z) => z.gruppe },
              { titel: 'Rollen in diesem Mandanten', wert: (z) => z.rollen.join(', ') },
            ]}
          />
        </div>
      ) : (
        <p role="alert" className="mt-2 text-sm text-orange-800">
          {TEXT_KEINE_GRUPPEN}
        </p>
      )}
    </div>
  );
}

/** Eigene Anbindung neben der Serverkonfiguration: Noch keine ist zugeklappt, eine vorhandene steht mit dem, was wann gilt. */
function EigeneAnbindung({
  d,
  g,
  mandantId,
}: {
  d: OidcAntwort;
  g: MandantOidcGlobal;
  mandantId: string;
}) {
  const [offen, setOffen] = useState(false);
  const k = d.konfiguration;
  return (
    <div className="mt-6">
      {k ? (
        <>
          <h3 className="mb-2 font-semibold">Eigene Anbindung dieses Mandanten</h3>
          {k.aktiv ? (
            <p className="text-sm text-slate-700">
              {textBeide(g.bezeichnung, k.bezeichnung)} {TEXT_KONTEN}
            </p>
          ) : (
            <p className="text-sm text-slate-700">{TEXT_INAKTIV}</p>
          )}
        </>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-700">
            {textWeg(g.bezeichnung)} {TEXT_KONTEN}
          </p>
          <button
            type="button"
            className={KNOPF}
            aria-expanded={offen}
            onClick={() => setOffen(!offen)}
          >
            {KNOPF_EIGENE}
          </button>
        </>
      )}
      {(k || offen) && <OidcFormular key={k?.geaendert ?? 'neu'} d={d} mandantId={mandantId} />}
    </div>
  );
}

export function Oidc({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const abfrage = useQuery({
    queryKey: ['sso', mandantId, 'oidc'],
    queryFn: () => api.get(mandantPfad(mandantId, '/oidc'), oidcAntwortSchema),
  });
  return (
    <Abschnitt titel="OIDC">
      <Abfrage abfrage={abfrage}>
        {(d) =>
          d.global ? (
            <>
              <ServerKonfiguration g={d.global} />
              <EigeneAnbindung d={d} g={d.global} mandantId={mandantId} />
            </>
          ) : (
            <>
              {!d.konfiguration && (
                <Hinweis>
                  Noch keine OIDC-Anbindung. Trage die Daten des Identity Providers ein.
                </Hinweis>
              )}
              <OidcFormular key={d.konfiguration?.geaendert ?? 'neu'} d={d} mandantId={mandantId} />
            </>
          )
        }
      </Abfrage>
    </Abschnitt>
  );
}
