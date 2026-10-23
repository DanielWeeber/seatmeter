// Seite „Projekt-Hinweise“: Hinweise zu Kosten und Datenqualität je Projekt und Monat.
// Routen: GET /api/v1/hinweise?monat=, POST /api/v1/hinweise/:id/erledigt, Regeln siehe Regeln.tsx.
import { hinweisSchema, type Hinweis as HinweisDaten } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { useAuth } from '../../auth/AuthTor';
import { datum } from '../../format';
import { Hinweis } from '../../komponenten/Abfrage';
import {
  Abschnitt,
  MonatsWahl,
  Seitenkopf,
  Tabelle,
  type Spalte,
} from '../../komponenten/Bausteine';
import { useMonat } from '../../monat';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { ZugriffAbfrage, speicherFehler } from '../../komponenten/Zugriff';
import { useHinweise } from './abfragen';
import { NeuBerechnen, Regeln } from './Regeln';
import { HINWEIS_TYP_TEXT } from './texte';

type Filter = 'offen' | 'alle';

function HinweiseInhalt({ monat }: { monat: string }) {
  const { darfVerwalten } = useAuth();
  const api = useApi();
  const queryClient = useQueryClient();
  const abfrage = useHinweise(monat);
  const [filter, setFilter] = useState<Filter>('offen');

  const erledigen = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/hinweise/${encodeURIComponent(id)}/erledigt`, undefined, hinweisSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hinweise'] }),
  });

  const spalten: Spalte<HinweisDaten>[] = [
    {
      titel: 'Hinweis',
      wert: (h) => <span className="font-medium">{HINWEIS_TYP_TEXT[h.typ]}</span>,
    },
    {
      titel: 'Projekt',
      wert: (h) => (h.projekt_id ? (h.projekt_name ?? h.projekt_id) : 'Alle Projekte'),
    },
    { titel: 'Beschreibung', wert: (h) => h.text },
    { titel: 'Aktualisiert', wert: (h) => datum(h.aktualisiert) },
    {
      titel: 'Status',
      wert: (h) =>
        h.erledigt ? (
          `Erledigt am ${datum(h.erledigt)}`
        ) : (
          <button
            type="button"
            className={KNOPF_KLEIN}
            disabled={erledigen.isPending && erledigen.variables === h.id}
            aria-label={`${HINWEIS_TYP_TEXT[h.typ]} als erledigt markieren`}
            onClick={() => erledigen.mutate(h.id)}
          >
            Erledigt
          </button>
        ),
    },
  ];

  const filterKnopf = (wert: Filter, text: string) => (
    <button
      type="button"
      aria-pressed={filter === wert}
      onClick={() => setFilter(wert)}
      className={`rounded border px-3 py-1 text-sm ${
        filter === wert
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-300 bg-white hover:bg-slate-100'
      }`}
    >
      {text}
    </button>
  );

  return (
    <>
      <p className="mt-2 text-sm text-slate-600">
        Hinweise, wo ein Projekt Kosten spart oder die Daten nachzubessern sind. Sie entstehen aus
        den Regeln und Schwellen weiter unten.
      </p>
      <ZugriffAbfrage abfrage={abfrage}>
        {(d) => {
          const sichtbar = filter === 'offen' ? d.hinweise.filter((h) => !h.erledigt) : d.hinweise;
          return (
            <>
              <Abschnitt titel="Hinweise">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex gap-2" role="group" aria-label="Filter">
                    {filterKnopf('offen', 'Offen')}
                    {filterKnopf('alle', 'Alle')}
                  </div>
                  {darfVerwalten && <NeuBerechnen monat={monat} />}
                </div>
                {sichtbar.length === 0 ? (
                  <Hinweis>
                    {filter === 'offen'
                      ? 'Keine offenen Hinweise in diesem Monat.'
                      : 'Keine Hinweise in diesem Monat.'}
                  </Hinweis>
                ) : (
                  <Tabelle
                    beschriftung="Projekt-Hinweise im Monat"
                    spalten={spalten}
                    zeilen={sichtbar}
                    schluessel={(h) => h.id}
                  />
                )}
                {erledigen.isError && (
                  <p role="alert" className="mt-2 text-sm text-red-800">
                    {speicherFehler(erledigen.error)}
                  </p>
                )}
              </Abschnitt>
              <Abschnitt titel="Regeln und Schwellen">
                <Regeln regeln={d.regeln} />
              </Abschnitt>
            </>
          );
        }}
      </ZugriffAbfrage>
    </>
  );
}

export function Hinweise() {
  const [monat] = useMonat();
  return (
    <section>
      <Seitenkopf titel="Projekt-Hinweise">
        <MonatsWahl />
      </Seitenkopf>
      <HinweiseInhalt monat={monat} />
    </section>
  );
}
