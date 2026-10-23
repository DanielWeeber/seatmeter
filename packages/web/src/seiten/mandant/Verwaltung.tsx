// Bausteine der Mandantenverwaltung: Mandanten-Tokens (Quelle A), Org-Positivliste und Rollen. Jeder Baustein
// lädt seine Liste selbst über die Kern-Routen (`/api/v1/mandant/…?mandant=<id>`); die Seite „Tokens und
// Orgs“ zeigt sie für den aktiven Mandanten, der Plattform-Bereich (ee) für den gewählten Mandanten.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../api/client';
import { datum, datumZeit } from '../../format';
import { Abfrage, Hinweis } from '../../komponenten/Abfrage';
import { Abschnitt, Tabelle } from '../../komponenten/Bausteine';
import { Auswahl, Eingabe, Formular, fehlerBeimSpeichern } from '../../komponenten/Formular';
import { KNOPF_DUNKEL, KNOPF_KLEIN } from '../../komponenten/knoepfe';
import {
  mandantPfad,
  neuesTokenSchema,
  orgListeSchema,
  quelleText,
  ROLLEN_OPTIONEN,
  rollenListeSchema,
  tokenListeSchema,
  type OrgZeile,
  type RolleZeile,
  type TokenZeile,
} from './api';
import { EinmalToken } from './EinmalToken';

/** Abfrage-Schlüssel der Verwaltung eines Mandanten (für gezieltes Neuladen). */
export const verwaltungSchluessel = (mandantId: string, teil: string) => [
  'mandant',
  mandantId,
  teil,
];

function Fehler({ fehler }: { fehler: unknown }) {
  return (
    <p role="alert" className="mt-2 text-sm text-red-800">
      {fehlerBeimSpeichern(fehler)}
    </p>
  );
}

export function MandantTokens({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const schluessel = verwaltungSchluessel(mandantId, 'tokens');
  const abfrage = useQuery({
    queryKey: schluessel,
    queryFn: () => api.get(mandantPfad(mandantId, '/tokens'), tokenListeSchema),
  });
  const neu = () => void queryClient.invalidateQueries({ queryKey: schluessel });
  const [klartext, setKlartext] = useState<string | null>(null);
  const erzeugen = useMutation({
    mutationFn: () => api.post(mandantPfad(mandantId, '/tokens'), {}, neuesTokenSchema),
    onSuccess: (t) => {
      setKlartext(t.token);
      neu();
    },
  });
  const widerrufen = useMutation({
    mutationFn: (id: string) =>
      api.delete(mandantPfad(mandantId, `/tokens/${encodeURIComponent(id)}`)),
    onSuccess: neu,
  });
  return (
    <Abschnitt titel="Mandanten-Tokens (Quelle A)">
      <Abfrage
        abfrage={abfrage}
        istLeer={(d) => d.tokens.length === 0}
        leerText="Noch kein Mandanten-Token."
      >
        {({ tokens }) => (
          <Tabelle<TokenZeile>
            beschriftung="Mandanten-Tokens"
            zeilen={tokens}
            schluessel={(t) => t.id}
            spalten={[
              { titel: 'Präfix', wert: (t) => <code>{t.praefix}…</code> },
              { titel: 'Erstellt', wert: (t) => datumZeit(t.erstellt) },
              {
                titel: 'Zuletzt genutzt',
                wert: (t) => (t.zuletzt_genutzt ? datumZeit(t.zuletzt_genutzt) : '–'),
              },
              {
                titel: 'Status',
                wert: (t) =>
                  t.widerrufen ? (
                    `widerrufen ${datum(t.widerrufen)}`
                  ) : (
                    <button
                      type="button"
                      className={KNOPF_KLEIN}
                      disabled={widerrufen.isPending}
                      onClick={() => widerrufen.mutate(t.id)}
                    >
                      Widerrufen
                    </button>
                  ),
              },
            ]}
          />
        )}
      </Abfrage>
      {klartext && <EinmalToken token={klartext} onFertig={() => setKlartext(null)} />}
      {(erzeugen.isError || widerrufen.isError) && (
        <Fehler fehler={erzeugen.error ?? widerrufen.error} />
      )}
      <button
        type="button"
        onClick={() => erzeugen.mutate()}
        disabled={erzeugen.isPending}
        className={`mt-3 ${KNOPF_DUNKEL}`}
      >
        Neues Token erzeugen
      </button>
    </Abschnitt>
  );
}

export function MandantOrgs({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const schluessel = verwaltungSchluessel(mandantId, 'orgs');
  const abfrage = useQuery({
    queryKey: schluessel,
    queryFn: () => api.get(mandantPfad(mandantId, '/anthropic-orgs'), orgListeSchema),
  });
  const neu = () => void queryClient.invalidateQueries({ queryKey: schluessel });
  const [org, setOrg] = useState('');
  const [bezeichnung, setBezeichnung] = useState('');
  const hinzufuegen = useMutation({
    mutationFn: () =>
      api.post(mandantPfad(mandantId, '/anthropic-orgs'), {
        org_uuid: org.trim(),
        ...(bezeichnung.trim() ? { bezeichnung: bezeichnung.trim() } : {}),
      }),
    onSuccess: () => {
      setOrg('');
      setBezeichnung('');
      neu();
    },
  });
  const entfernen = useMutation({
    mutationFn: (id: string) =>
      api.delete(mandantPfad(mandantId, `/anthropic-orgs/${encodeURIComponent(id)}`)),
    onSuccess: neu,
  });
  return (
    <Abschnitt titel="Anthropic-Organisationen (Positivliste)">
      <Abfrage
        abfrage={abfrage}
        istLeer={(d) => d.orgs.length === 0}
        leerText="Keine Org eingetragen: ohne Positivliste zählt keine Anfrage als Abo-Nutzung."
      >
        {({ orgs }) => (
          <Tabelle<OrgZeile>
            beschriftung="Anthropic-Organisationen"
            zeilen={orgs}
            schluessel={(o) => o.org_uuid}
            spalten={[
              { titel: 'Org-ID', wert: (o) => <code>{o.org_uuid}</code> },
              { titel: 'Bezeichnung', wert: (o) => o.bezeichnung ?? '–' },
              { titel: 'Plan', wert: (o) => o.plan ?? '–' },
              { titel: 'Gültig ab', wert: (o) => datum(o.gueltig_ab) },
              {
                titel: 'Aktion',
                wert: (o) => (
                  <button
                    type="button"
                    className={KNOPF_KLEIN}
                    disabled={entfernen.isPending}
                    onClick={() => entfernen.mutate(o.org_uuid)}
                  >
                    Entfernen
                  </button>
                ),
              },
            ]}
          />
        )}
      </Abfrage>
      {entfernen.isError && <Fehler fehler={entfernen.error} />}
      <Formular
        titel="Org hinzufügen"
        knopf="Hinzufügen"
        onAbsenden={() => hinzufuegen.mutate()}
        laeuft={hinzufuegen.isPending}
        meldung={hinzufuegen.isError ? fehlerBeimSpeichern(hinzufuegen.error) : null}
      >
        <Eingabe beschriftung="Org-ID (UUID)" wert={org} onAendern={setOrg} />
        <Eingabe
          beschriftung="Bezeichnung (optional)"
          wert={bezeichnung}
          onAendern={setBezeichnung}
        />
      </Formular>
    </Abschnitt>
  );
}

const ROLLEN_NAMEN = Object.fromEntries(ROLLEN_OPTIONEN) as Record<string, string>;

export function MandantRollen({ mandantId }: { mandantId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const schluessel = verwaltungSchluessel(mandantId, 'rollen');
  const abfrage = useQuery({
    queryKey: schluessel,
    queryFn: () => api.get(mandantPfad(mandantId, '/rollen'), rollenListeSchema),
  });
  const neu = () => void queryClient.invalidateQueries({ queryKey: schluessel });
  const [benutzername, setBenutzername] = useState('');
  const [rolle, setRolle] = useState('controller');
  const zuweisen = useMutation({
    mutationFn: () =>
      api.post(mandantPfad(mandantId, '/rollen'), { benutzername: benutzername.trim(), rolle }),
    onSuccess: () => {
      setBenutzername('');
      neu();
    },
  });
  const entziehen = useMutation({
    mutationFn: (id: string) =>
      api.delete(mandantPfad(mandantId, `/rollen/${encodeURIComponent(id)}`)),
    onSuccess: neu,
  });
  return (
    <Abschnitt titel="Rollen">
      <Abfrage
        abfrage={abfrage}
        istLeer={(d) => d.rollen.length === 0}
        leerText="Noch keine Rolle vergeben."
      >
        {({ rollen }) => (
          <Tabelle<RolleZeile>
            beschriftung="Rollen im Mandanten"
            zeilen={rollen}
            schluessel={(r) => r.id}
            spalten={[
              { titel: 'Konto', wert: (r) => r.benutzername },
              { titel: 'Rolle', wert: (r) => ROLLEN_NAMEN[r.rolle] ?? r.rolle },
              { titel: 'Herkunft', wert: (r) => quelleText(r.quelle) },
              {
                titel: 'Aktion',
                wert: (r) => (
                  <button
                    type="button"
                    className={KNOPF_KLEIN}
                    disabled={entziehen.isPending}
                    onClick={() => entziehen.mutate(r.id)}
                  >
                    Entziehen
                  </button>
                ),
              },
            ]}
          />
        )}
      </Abfrage>
      {entziehen.isError && <Fehler fehler={entziehen.error} />}
      <Formular
        titel="Rolle zuweisen"
        knopf="Zuweisen"
        onAbsenden={() => zuweisen.mutate()}
        laeuft={zuweisen.isPending}
        meldung={zuweisen.isError ? fehlerBeimSpeichern(zuweisen.error) : null}
      >
        <Eingabe
          beschriftung="Anmeldename (vorhandenes Konto)"
          wert={benutzername}
          onAendern={setBenutzername}
        />
        <Auswahl
          beschriftung="Rolle"
          wert={rolle}
          onAendern={setRolle}
          optionen={ROLLEN_OPTIONEN}
        />
      </Formular>
    </Abschnitt>
  );
}

/** Hinweis, wenn kein Mandant gewählt ist (z. B. Konto ohne Rolle). */
export function KeinMandant() {
  return <Hinweis>Kein aktiver Mandant gewählt.</Hinweis>;
}
