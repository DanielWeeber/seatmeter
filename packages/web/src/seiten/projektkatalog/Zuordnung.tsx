// Tabelle Repo → Katalog-Projekt für Einrichtung und Kostenseite. Mandanten-Admin sieht alle Repos, Projektleitung
// ihre eigenen. Die Zuordnung wirkt rückwirkend, außer auf abgeschlossene Monate.
import type { KatalogKurz, KatalogZuordnungZeile } from '@seatmeter/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { useApi } from '../../api/client';
import { Tabelle } from '../../komponenten/Bausteine';
import { KNOPF_DUNKEL, KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { speicherFehler, ZugriffAbfrage } from '../../komponenten/Zugriff';
import { useKatalogProjekte, useKatalogZuordnung, ZUORDNUNG_SCHLUESSEL } from './abfragen';
import { ProjektAuswahl, projektText } from './ProjektAuswahl';

export const TEXT_KEINE_REPOS = 'Noch keine Repos erfasst.';

function ZeileBearbeiten({
  zeile,
  projekte,
  onFertig,
}: {
  zeile: KatalogZuordnungZeile;
  projekte: readonly KatalogKurz[];
  onFertig: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [gewaehlt, setGewaehlt] = useState<string | null>(zeile.katalog?.id ?? null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const speichern = useMutation({
    mutationFn: (katalogProjektId: string | null) =>
      api.put(
        '/api/v1/projektkatalog/zuordnung',
        { zuordnung: [{ projekt_id: zeile.projekt_id, katalog_projekt_id: katalogProjektId }] },
        z.object({ geaendert: z.number() }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ZUORDNUNG_SCHLUESSEL });
      await queryClient.invalidateQueries({ queryKey: ['projektkatalog', 'kosten'] });
      onFertig();
    },
    onError: (f) => setMeldung(speicherFehler(f)),
  });
  return (
    <div className="mt-2 space-y-2">
      <ProjektAuswahl projekte={projekte} gewaehlt={gewaehlt} onWahl={setGewaehlt} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={KNOPF_DUNKEL}
          disabled={!gewaehlt || speichern.isPending}
          onClick={() => speichern.mutate(gewaehlt)}
        >
          Speichern
        </button>
        {zeile.katalog && (
          <button
            type="button"
            className={KNOPF_KLEIN}
            disabled={speichern.isPending}
            onClick={() => speichern.mutate(null)}
          >
            Zuordnung entfernen
          </button>
        )}
        <button type="button" className={KNOPF_KLEIN} onClick={onFertig}>
          Abbrechen
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

export function Zuordnung() {
  const zuordnung = useKatalogZuordnung();
  const projekte = useKatalogProjekte();
  const [offen, setOffen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  return (
    <ZugriffAbfrage
      abfrage={zuordnung}
      istLeer={(d) => d.zuordnung.length === 0}
      leerText={TEXT_KEINE_REPOS}
    >
      {(d) => {
        const zeilen = d.zuordnung.filter((z) =>
          z.projekt_name.toLowerCase().includes(filter.trim().toLowerCase()),
        );
        const liste = projekte.data?.projekte ?? [];
        const bearbeitet = d.zuordnung.find((z) => z.projekt_id === offen);
        return (
          <>
            <label className="mb-2 block max-w-md text-sm">
              <span className="block font-medium text-slate-700">Repo filtern</span>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <Tabelle
              beschriftung="Zuordnung Repo zu Projekt"
              zeilen={zeilen}
              schluessel={(z) => z.projekt_id}
              spalten={[
                { titel: 'Repo', wert: (z) => z.projekt_name },
                {
                  titel: 'Projekt',
                  wert: (z) =>
                    z.katalog
                      ? `${projektText(z.katalog)}${z.katalog.aktiv ? '' : ' – inaktiv'}`
                      : 'nicht zugeordnet',
                },
                {
                  titel: '',
                  wert: (z) => (
                    <button
                      type="button"
                      className={KNOPF_KLEIN}
                      onClick={() => setOffen(z.projekt_id)}
                      aria-label={`Projekt für ${z.projekt_name} ändern`}
                    >
                      Ändern
                    </button>
                  ),
                },
              ]}
            />
            {bearbeitet && (
              <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
                <h3 className="font-semibold">Projekt für {bearbeitet.projekt_name}</h3>
                <ZeileBearbeiten
                  key={bearbeitet.projekt_id}
                  zeile={bearbeitet}
                  projekte={liste}
                  onFertig={() => setOffen(null)}
                />
              </div>
            )}
          </>
        );
      }}
    </ZugriffAbfrage>
  );
}
