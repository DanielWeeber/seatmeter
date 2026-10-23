// Seite „Jira“ (Kern, Einrichtung, nur Mandanten-Admin): Verbindung je Mandant (Cloud: E-Mail + API-Token,
// Data Center: Personal Access Token), Prüfen, Zuordnung seatmeter-Projekt → Jira-Projekt.
// Routen: GET/PUT/DELETE /api/v1/jira/verbindung, POST …/verbindung/pruefen, GET /api/v1/jira/projekte,
// GET/PUT /api/v1/jira/zuordnung. Das Token ist nur beschreibbar und wird nie angezeigt.
import {
  jiraPruefungSchema,
  jiraVerbindungEingabeSchema,
  jiraVerbindungSchema,
  type JiraArt,
  type JiraPruefung,
  type JiraVerbindung,
  type JiraZuordnungAntwort,
} from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { datumZeit } from '../../format';
import { Abschnitt, Seitenkopf, Tabelle, Werte } from '../../komponenten/Bausteine';
import { Auswahl, Eingabe, Formular, Kontrollkaestchen } from '../../komponenten/Formular';
import { GEHEIMNIS_LEER, Geheimnisfeld } from '../../komponenten/Geheimnisfeld';
import { KNOPF, KNOPF_DUNKEL } from '../../komponenten/knoepfe';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ZugriffAbfrage, speicherFehler } from '../../komponenten/Zugriff';
import {
  PROJEKTE_SCHLUESSEL,
  useJiraProjekte,
  useJiraVerbindung,
  useJiraZuordnung,
  VERBINDUNG_SCHLUESSEL,
  ZUORDNUNG_SCHLUESSEL,
} from './abfragen';

export const TEXT_SCHLUESSEL =
  'seatmeter ordnet Sitzungen Jira-Issues über den Issue-Schlüssel im Branch-Namen zu (z. B. ' +
  'feature/ABC-123-titel → ABC-123). Gesendet und gespeichert wird nur der Schlüssel, nie der ' +
  'Branch-Name. Erfasst werden die Schlüssel ab Agent 0.1.3 (je Transkriptzeile) und über den ' +
  'Start-Wrapper (Branch beim Sitzungsstart). seatmeter liest aus Jira nur Projekte, Titel und Status ' +
  'und schreibt nichts zurück.';

const ARTEN: readonly (readonly [JiraArt, string])[] = [
  ['cloud', 'Jira Cloud (E-Mail + API-Token)'],
  ['datacenter', 'Jira Data Center (Personal Access Token)'],
];

function VerbindungFormular({ v }: { v: JiraVerbindung }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [basisUrl, setBasisUrl] = useState(v.basis_url ?? '');
  const [art, setArt] = useState<JiraArt>(v.art ?? 'cloud');
  const [email, setEmail] = useState(v.benutzer_email ?? '');
  const [token, setToken] = useState(GEHEIMNIS_LEER);
  const [aktiv, setAktiv] = useState(v.eingerichtet ? v.aktiv : true);
  const [nurZugeordnete, setNurZugeordnete] = useState(v.nur_zugeordnete);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const [pruefung, setPruefung] = useState<JiraPruefung | null>(null);
  const [entfernenFrage, setEntfernenFrage] = useState(false);

  const neuLaden = async () => {
    await queryClient.invalidateQueries({ queryKey: VERBINDUNG_SCHLUESSEL });
    await queryClient.invalidateQueries({ queryKey: PROJEKTE_SCHLUESSEL });
    await queryClient.invalidateQueries({ queryKey: ZUORDNUNG_SCHLUESSEL });
  };
  const speichern = useMutation({
    mutationFn: (koerper: unknown) =>
      api.put('/api/v1/jira/verbindung', koerper, jiraVerbindungSchema),
    onSuccess: async (neu) => {
      queryClient.setQueryData(VERBINDUNG_SCHLUESSEL, neu);
      setToken(GEHEIMNIS_LEER);
      setErfolg('Verbindung gespeichert.');
      await neuLaden();
    },
    onError: (e) => setMeldung(speicherFehler(e)),
  });
  const pruefen = useMutation({
    mutationFn: () => api.post('/api/v1/jira/verbindung/pruefen', {}, jiraPruefungSchema),
    onSuccess: async (p) => {
      setPruefung(p);
      await neuLaden();
    },
    onError: (e) => setMeldung(speicherFehler(e)),
  });
  const entfernen = useMutation({
    mutationFn: () => api.delete('/api/v1/jira/verbindung'),
    onSuccess: async () => {
      setEntfernenFrage(false);
      setErfolg('Verbindung entfernt.');
      await neuLaden();
    },
    onError: (e) => setMeldung(speicherFehler(e)),
  });

  const absenden = () => {
    setErfolg(null);
    setMeldung(null);
    const e = jiraVerbindungEingabeSchema.safeParse({
      basis_url: basisUrl.trim(),
      art,
      benutzer_email: art === 'cloud' && email.trim() !== '' ? email.trim() : null,
      ...(token.text !== '' ? { token: token.text } : {}),
      aktiv,
      nur_zugeordnete: nurZugeordnete,
    });
    if (!e.success) {
      setMeldung(e.error.issues[0]?.message ?? 'Bitte die Eingaben prüfen.');
      return;
    }
    if (!v.token_gesetzt && token.text === '') {
      setMeldung('Bitte das Token eintragen.');
      return;
    }
    speichern.mutate(e.data);
  };

  return (
    <>
      <Formular
        titel="Verbindung"
        onAbsenden={absenden}
        laeuft={speichern.isPending}
        meldung={meldung}
        erfolg={erfolg}
        knopf={v.eingerichtet ? 'Verbindung ändern' : 'Verbindung speichern'}
      >
        <Eingabe beschriftung="Basis-URL" wert={basisUrl} onAendern={setBasisUrl} />
        <Auswahl
          beschriftung="Art"
          wert={art}
          onAendern={(w) => setArt(w as JiraArt)}
          optionen={ARTEN}
        />
        {art === 'cloud' && (
          <Eingabe
            beschriftung="E-Mail des Jira-Kontos"
            wert={email}
            onAendern={setEmail}
            typ="email"
          />
        )}
        <Geheimnisfeld
          beschriftung={art === 'cloud' ? 'API-Token' : 'Personal Access Token'}
          gesetzt={v.token_gesetzt}
          wert={token}
          onAendern={setToken}
          loeschbar={false}
        />
        <Kontrollkaestchen beschriftung="Aktiv" wert={aktiv} onAendern={setAktiv} />
        <Kontrollkaestchen
          beschriftung="Nur Schlüssel zugeordneter Jira-Projekte speichern"
          wert={nurZugeordnete}
          onAendern={setNurZugeordnete}
        />
      </Formular>
      {v.eingerichtet && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={KNOPF_DUNKEL}
            disabled={pruefen.isPending}
            onClick={() => {
              setMeldung(null);
              pruefen.mutate();
            }}
          >
            Verbindung prüfen
          </button>
          {entfernenFrage ? (
            <>
              <span className="text-sm text-slate-700">Verbindung wirklich entfernen?</span>
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
            </>
          ) : (
            <button type="button" className={KNOPF} onClick={() => setEntfernenFrage(true)}>
              Verbindung entfernen
            </button>
          )}
        </div>
      )}
      {pruefung && (
        <p
          role="status"
          className={`mt-2 text-sm ${pruefung.ok ? 'text-green-800' : 'text-red-800'}`}
        >
          {pruefung.ok
            ? `Verbindung in Ordnung${pruefung.konto ? ` (Konto: ${pruefung.konto})` : ''}.`
            : `Prüfung fehlgeschlagen: ${pruefung.fehler ?? 'unbekannter Fehler'}`}
        </p>
      )}
    </>
  );
}

function Zuordnung({ z, aktiv }: { z: JiraZuordnungAntwort; aktiv: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const projekte = useJiraProjekte(aktiv);
  const [auswahl, setAuswahl] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      z.zuordnung.map((zeile) => [zeile.projekt_id, zeile.jira_projekt_schluessel ?? '']),
    ),
  );
  const [meldung, setMeldung] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const namen = new Map((projekte.data?.projekte ?? []).map((p) => [p.schluessel, p.name]));
  for (const zeile of z.zuordnung)
    if (zeile.jira_projekt_schluessel && !namen.has(zeile.jira_projekt_schluessel))
      namen.set(
        zeile.jira_projekt_schluessel,
        zeile.jira_projekt_name ?? zeile.jira_projekt_schluessel,
      );
  const optionen: [string, string][] = [
    ['', '– keine –'],
    ...[...namen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, n]): [string, string] => [s, `${s} – ${n}`]),
  ];

  const speichern = useMutation({
    mutationFn: () =>
      api.put('/api/v1/jira/zuordnung', {
        zuordnung: z.zuordnung.map((zeile) => {
          const s = auswahl[zeile.projekt_id] ?? '';
          return {
            projekt_id: zeile.projekt_id,
            jira_projekt_schluessel: s === '' ? null : s,
            jira_projekt_name: s === '' ? null : (namen.get(s) ?? null),
          };
        }),
      }),
    onSuccess: async () => {
      setErfolg('Zuordnung gespeichert.');
      await queryClient.invalidateQueries({ queryKey: ZUORDNUNG_SCHLUESSEL });
    },
    onError: (e) => setMeldung(speicherFehler(e)),
  });

  if (z.zuordnung.length === 0)
    return <p className="text-slate-600">Noch keine seatmeter-Projekte vorhanden.</p>;
  return (
    <>
      {projekte.isError && (
        <p className="mb-2 text-sm text-red-800">
          Jira-Projekte konnten nicht geladen werden; vorhandene Zuordnungen bleiben wählbar.
        </p>
      )}
      <Tabelle
        beschriftung="Zuordnung seatmeter-Projekt zu Jira-Projekt"
        zeilen={z.zuordnung}
        schluessel={(zeile) => zeile.projekt_id}
        spalten={[
          { titel: 'seatmeter-Projekt', wert: (zeile) => zeile.projekt_name },
          {
            titel: 'Jira-Projekt',
            wert: (zeile) => (
              <select
                aria-label={`Jira-Projekt für ${zeile.projekt_name}`}
                className="rounded border border-slate-300 bg-white px-2 py-1"
                value={auswahl[zeile.projekt_id] ?? ''}
                onChange={(e) => setAuswahl({ ...auswahl, [zeile.projekt_id]: e.target.value })}
              >
                {optionen.map(([w, t]) => (
                  <option key={w} value={w}>
                    {t}
                  </option>
                ))}
              </select>
            ),
          },
        ]}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={KNOPF_DUNKEL}
          disabled={speichern.isPending}
          onClick={() => {
            setMeldung(null);
            setErfolg(null);
            speichern.mutate();
          }}
        >
          Zuordnung speichern
        </button>
        {erfolg && (
          <span role="status" className="text-sm text-green-800">
            {erfolg}
          </span>
        )}
        {meldung && (
          <span role="alert" className="text-sm text-red-800">
            {meldung}
          </span>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Positivliste der Issue-Schlüssel:{' '}
        {z.issue_praefixe ? z.issue_praefixe.join(', ') : 'alle erkannten Schlüssel'}
      </p>
    </>
  );
}

function JiraInhalt() {
  const verbindung = useJiraVerbindung();
  const zuordnung = useJiraZuordnung();
  return (
    <>
      <p className="mt-2 text-sm text-slate-600">{TEXT_SCHLUESSEL}</p>
      <ZugriffAbfrage abfrage={verbindung}>
        {(v) => (
          <>
            <Abschnitt titel="Stand">
              <Werte
                eintraege={[
                  [
                    'Verbindung',
                    v.eingerichtet ? (v.aktiv ? 'aktiv' : 'inaktiv') : 'nicht eingerichtet',
                  ],
                  ['Zuletzt geprüft', v.zuletzt_geprueft ? datumZeit(v.zuletzt_geprueft) : '–'],
                  ['Letzter Fehler', v.fehler ?? '–'],
                ]}
              />
            </Abschnitt>
            <Abschnitt titel="Jira-Verbindung">
              <VerbindungFormular key={`${v.basis_url ?? ''}|${v.art ?? ''}`} v={v} />
            </Abschnitt>
            <Abschnitt titel="Zuordnung">
              <ZugriffAbfrage abfrage={zuordnung}>
                {(z) => <Zuordnung z={z} aktiv={v.eingerichtet && v.aktiv} />}
              </ZugriffAbfrage>
            </Abschnitt>
          </>
        )}
      </ZugriffAbfrage>
    </>
  );
}

export function Jira() {
  return (
    <section>
      <Seitenkopf titel="Jira" />
      <JiraInhalt />
    </section>
  );
}
