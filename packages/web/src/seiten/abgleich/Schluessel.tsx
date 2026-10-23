// Enterprise: Analytics-API-Key hinterlegen oder entfernen und „Jetzt abgleichen“.
// Routen: PUT/DELETE /api/v1/abgleich/analytics-key, POST /api/v1/abgleich/lauf?von=&bis=.
// Der Key ist nur beschreibbar und wird nie angezeigt.
import {
  abgleichLaufSchema,
  abgleichStatusSchema,
  analyticsKeyEingabeSchema,
  type AbgleichLauf,
  type AbgleichStatus,
} from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { datumZeit } from '../../format';
import { Eingabe, Formular } from '../../komponenten/Formular';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { GEHEIMNIS_LEER, Geheimnisfeld } from '../../komponenten/Geheimnisfeld';
import { KNOPF, KNOPF_DUNKEL } from '../../komponenten/knoepfe';
import { speicherFehler } from '../../komponenten/Zugriff';
import { LAEUFE_SCHLUESSEL, STATUS_SCHLUESSEL } from './abfragen';
import { LaufErgebnis } from './Laeufe';

function KeyFormular({ status }: { status: AbgleichStatus }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [key, setKey] = useState(GEHEIMNIS_LEER);
  const [fehler, setFehler] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const [entfernenFrage, setEntfernenFrage] = useState(false);

  const speichern = useMutation({
    mutationFn: (koerper: { key: string }) =>
      api.put('/api/v1/abgleich/analytics-key', koerper, abgleichStatusSchema),
    onSuccess: (neu) => {
      queryClient.setQueryData(STATUS_SCHLUESSEL, neu);
      setKey(GEHEIMNIS_LEER);
      setErfolg('Key gespeichert.');
    },
    onError: (e) => setMeldung(speicherFehler(e)),
  });
  const entfernen = useMutation({
    mutationFn: () => api.delete('/api/v1/abgleich/analytics-key'),
    onSuccess: async () => {
      setEntfernenFrage(false);
      setErfolg('Key entfernt.');
      await queryClient.invalidateQueries({ queryKey: STATUS_SCHLUESSEL });
    },
    onError: (e) => setMeldung(speicherFehler(e)),
  });

  const absenden = () => {
    setErfolg(null);
    setMeldung(null);
    const ergebnis = analyticsKeyEingabeSchema.safeParse({ key: key.text });
    if (!ergebnis.success) {
      setFehler('Bitte den Analytics-API-Key einfügen (mindestens 20 Zeichen).');
      setMeldung('Bitte das markierte Feld prüfen.');
      return;
    }
    setFehler(null);
    speichern.mutate(ergebnis.data);
  };

  return (
    <>
      <Formular
        titel="Analytics-API-Key"
        onAbsenden={absenden}
        laeuft={speichern.isPending}
        meldung={meldung}
        erfolg={erfolg}
        knopf={status.key_gesetzt ? 'Key ersetzen' : 'Key speichern'}
      >
        <Geheimnisfeld
          beschriftung="Analytics-API-Key (Scope read:analytics)"
          gesetzt={status.key_gesetzt}
          wert={key}
          onAendern={setKey}
          fehler={fehler}
          loeschbar={false}
        />
      </Formular>
      {status.key_gesetzt && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {entfernenFrage ? (
            <>
              <span className="text-sm text-slate-700">Key wirklich entfernen?</span>
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
              Key entfernen
            </button>
          )}
        </div>
      )}
    </>
  );
}

function Abgleichen({ status }: { status: AbgleichStatus }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [von, setVon] = useState('');
  const [bis, setBis] = useState('');
  const [ergebnis, setErgebnis] = useState<AbgleichLauf | null>(null);

  const lauf = useMutation({
    mutationFn: () => {
      const q = new URLSearchParams();
      if (von) q.set('von', von);
      if (bis) q.set('bis', bis);
      const query = q.toString();
      return api.post(
        `/api/v1/abgleich/lauf${query ? `?${query}` : ''}`,
        undefined,
        abgleichLaufSchema,
      );
    },
    onMutate: () => setErgebnis(null),
    onSuccess: async (neu) => {
      setErgebnis(neu);
      await queryClient.invalidateQueries({ queryKey: STATUS_SCHLUESSEL });
      await queryClient.invalidateQueries({ queryKey: LAEUFE_SCHLUESSEL });
    },
  });

  return (
    <div className="mt-4 rounded border border-slate-200 bg-white p-4">
      <h3 className="font-semibold">Jetzt abgleichen</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Eingabe beschriftung="Von (optional)" typ="date" wert={von} onAendern={setVon} />
        <Eingabe beschriftung="Bis (optional)" typ="date" wert={bis} onAendern={setBis} />
        <button
          type="button"
          className={`${KNOPF_DUNKEL} self-end`}
          disabled={!status.key_gesetzt || lauf.isPending}
          onClick={() => lauf.mutate()}
        >
          {lauf.isPending ? 'Gleiche ab …' : 'Jetzt abgleichen'}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {status.key_gesetzt
          ? 'Ohne Zeitraum wählt der Server den Standardzeitraum.'
          : 'Erst einen Analytics-API-Key hinterlegen.'}
      </p>
      {lauf.isError && (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {speicherFehler(lauf.error)}
        </p>
      )}
      {ergebnis && <LaufErgebnis lauf={ergebnis} />}
    </div>
  );
}

export function Schluessel({ status }: { status: AbgleichStatus }) {
  return (
    <>
      <p className="text-sm text-slate-700">
        {status.key_gesetzt
          ? `Ein Key ist hinterlegt (zuletzt geändert am ${datumZeit(status.key_geaendert)}).`
          : 'Es ist noch kein Key hinterlegt.'}
      </p>
      <KeyFormular status={status} />
      <Abgleichen status={status} />
    </>
  );
}
