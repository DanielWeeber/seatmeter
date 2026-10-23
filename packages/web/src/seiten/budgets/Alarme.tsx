// Abschnitt „Alarme“: ausgelöste Schwellen eines Monats, Filter „nur offene“, Quittieren.
// Routen: GET /api/v1/alarme?monat=&offen=1, POST /api/v1/alarme/:id/quittieren.
import { alarmSchema, type Alarm } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { datumZeit, mengeText, prozent } from '../../format';
import { Abschnitt, Tabelle, type Spalte } from '../../komponenten/Bausteine';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { ZugriffAbfrage, speicherFehler } from '../../komponenten/Zugriff';
import { useAlarme } from './abfragen';
import { ZUSTELLUNG_TEXT } from './texte';

export function Alarme({ monat }: { monat: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [nurOffen, setNurOffen] = useState(true);
  const abfrage = useAlarme(monat, nurOffen);
  const quittieren = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/alarme/${encodeURIComponent(id)}/quittieren`, undefined, alarmSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alarme'] }),
  });

  const spalten: Spalte<Alarm>[] = [
    { titel: 'Ausgelöst', wert: (a) => datumZeit(a.ausgeloest) },
    { titel: 'Budget', wert: (a) => a.budget_name },
    { titel: 'Schwelle', wert: (a) => `${a.schwelle} %`, zahl: true },
    {
      titel: 'Stand',
      wert: (a) => (
        <>
          {mengeText(a.wert, a.einheit)}
          {a.betrag != null && ` von ${mengeText(a.betrag, a.einheit)}`}
          {a.prozent != null && (
            <span className="block text-xs text-slate-600">{prozent(a.prozent)}</span>
          )}
        </>
      ),
    },
    {
      titel: 'Zustellung',
      wert: (a) => (
        <>
          {ZUSTELLUNG_TEXT[a.zustellung]}
          {a.zustellfehler && <span className="block text-xs text-red-800">{a.zustellfehler}</span>}
        </>
      ),
    },
    {
      titel: 'Quittierung',
      wert: (a) =>
        a.quittiert ? (
          `Quittiert am ${datumZeit(a.quittiert)}`
        ) : (
          <button
            type="button"
            className={KNOPF_KLEIN}
            disabled={quittieren.isPending && quittieren.variables === a.id}
            aria-label={`Alarm ${a.budget_name} ${a.schwelle} % quittieren`}
            onClick={() => quittieren.mutate(a.id)}
          >
            Quittieren
          </button>
        ),
    },
  ];

  return (
    <Abschnitt titel="Alarme">
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={nurOffen} onChange={(e) => setNurOffen(e.target.checked)} />
        <span className="font-medium text-slate-700">Nur offene Alarme</span>
      </label>
      <ZugriffAbfrage
        abfrage={abfrage}
        istLeer={(d) => d.alarme.length === 0}
        leerText={
          nurOffen ? 'Keine offenen Alarme in diesem Monat.' : 'Keine Alarme in diesem Monat.'
        }
      >
        {(d) => (
          <Tabelle
            beschriftung="Alarme im Monat"
            spalten={spalten}
            zeilen={d.alarme}
            schluessel={(a) => a.id}
          />
        )}
      </ZugriffAbfrage>
      {quittieren.isError && (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {speicherFehler(quittieren.error)}
        </p>
      )}
    </Abschnitt>
  );
}
