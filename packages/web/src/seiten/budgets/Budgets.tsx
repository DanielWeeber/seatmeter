// Seite „Budgets und Alarme“: Budgets je Monat mit Verbrauch und Prognose, Alarme, Alarmkanäle.
// Routen: /api/v1/budgets (GET/POST/PUT/DELETE), siehe Alarme.tsx und Alarmkanaele.tsx für den Rest.
import type { Budget } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { useAuth } from '../../auth/AuthTor';
import { mengeText, prozent } from '../../format';
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
import { KNOPF, KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { ZugriffAbfrage, speicherFehler } from '../../komponenten/Zugriff';
import { useBudgets } from './abfragen';
import { Alarme } from './Alarme';
import { Alarmkanaele } from './Alarmkanaele';
import { BudgetFormular } from './BudgetFormular';
import { AUSLOESER_TEXT, budgetEinheit } from './texte';

/** Balken: Verbrauch (farbig) über der Prognose zum Monatsende (hellgrau); über 100 % läuft er voll. */
function Auslastung({ budget }: { budget: Budget }) {
  const { prozent: p, prognose_prozent: pp } = budget.stand;
  if (p == null) return <span className="text-slate-500">—</span>;
  const breite = Math.min(100, Math.max(0, p));
  const farbe = p >= 100 ? 'bg-red-600' : p >= 80 ? 'bg-amber-500' : 'bg-green-600';
  return (
    <div className="min-w-28">
      <div
        role="progressbar"
        aria-label={`Auslastung ${budget.projekt_name ?? 'alle Projekte'}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(breite)}
        className="relative h-2 overflow-hidden rounded bg-slate-200"
      >
        {pp != null && (
          <div
            className="absolute inset-y-0 left-0 bg-slate-400/60"
            style={{ width: `${Math.min(100, Math.max(0, pp))}%` }}
          />
        )}
        <div className={`absolute inset-y-0 left-0 ${farbe}`} style={{ width: `${breite}%` }} />
      </div>
      <span className="text-xs tabular-nums">{prozent(p)}</span>
    </div>
  );
}

function spalten(
  verwalten: boolean,
  aktionen: {
    bearbeiten: (b: Budget) => void;
    loeschenFrage: string | null;
    frageLoeschen: (id: string | null) => void;
    loeschen: (id: string) => void;
    laeuft: boolean;
  },
): Spalte<Budget>[] {
  const basis: Spalte<Budget>[] = [
    {
      titel: 'Budget',
      wert: (b) => (
        <>
          <span className="font-medium">{b.projekt_name ?? 'Alle Projekte'}</span>
          {!b.aktiv && <span className="ml-2 text-xs text-slate-500">(inaktiv)</span>}
          {b.bezeichnung && <span className="block text-xs text-slate-600">{b.bezeichnung}</span>}
          {b.stand.hinweis && (
            <span className="block text-xs text-amber-800">{b.stand.hinweis}</span>
          )}
        </>
      ),
    },
    { titel: 'Betrag', wert: (b) => mengeText(b.betrag, budgetEinheit(b)), zahl: true },
    { titel: 'Verbrauch', wert: (b) => mengeText(b.stand.verbrauch, budgetEinheit(b)), zahl: true },
    {
      titel: 'Prognose',
      zahl: true,
      wert: (b) => (
        <>
          {mengeText(b.stand.prognose, budgetEinheit(b))}
          {b.stand.prognose_prozent != null && (
            <span className="block text-xs text-slate-600">
              {prozent(b.stand.prognose_prozent)} zum Monatsende
            </span>
          )}
        </>
      ),
    },
    { titel: 'Auslastung', wert: (b) => <Auslastung budget={b} /> },
    { titel: 'Schwellen', wert: (b) => b.schwellen.map((s) => `${s} %`).join(', ') },
    { titel: 'Auslöser', wert: (b) => AUSLOESER_TEXT[b.ausloeser] },
  ];
  if (!verwalten) return basis;
  return [
    ...basis,
    {
      titel: 'Aktionen',
      wert: (b) =>
        aktionen.loeschenFrage === b.id ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-700">Budget wirklich löschen?</span>
            <button
              type="button"
              className={KNOPF_KLEIN}
              disabled={aktionen.laeuft}
              onClick={() => aktionen.loeschen(b.id)}
            >
              Ja, löschen
            </button>
            <button
              type="button"
              className={KNOPF_KLEIN}
              onClick={() => aktionen.frageLoeschen(null)}
            >
              Abbrechen
            </button>
          </span>
        ) : (
          <span className="flex gap-2">
            <button
              type="button"
              className={KNOPF_KLEIN}
              aria-label={`Budget ${b.projekt_name ?? 'alle Projekte'} bearbeiten`}
              onClick={() => aktionen.bearbeiten(b)}
            >
              Bearbeiten
            </button>
            <button
              type="button"
              className={KNOPF_KLEIN}
              aria-label={`Budget ${b.projekt_name ?? 'alle Projekte'} löschen`}
              onClick={() => aktionen.frageLoeschen(b.id)}
            >
              Löschen
            </button>
          </span>
        ),
    },
  ];
}

function BudgetsInhalt({ monat }: { monat: string }) {
  const { darfVerwalten } = useAuth();
  const api = useApi();
  const queryClient = useQueryClient();
  const abfrage = useBudgets(monat);
  const [formular, setFormular] = useState<Budget | 'neu' | null>(null);
  const [loeschenFrage, setLoeschenFrage] = useState<string | null>(null);
  const [erfolg, setErfolg] = useState<string | null>(null);

  const loeschen = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/budgets/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      setLoeschenFrage(null);
      setErfolg('Budget gelöscht.');
      await queryClient.invalidateQueries({ queryKey: ['budgets'] });
      await queryClient.invalidateQueries({ queryKey: ['alarme'] });
    },
  });

  return (
    <>
      <Abschnitt titel="Budgets">
        <ZugriffAbfrage
          abfrage={abfrage}
          istLeer={(d) => d.budgets.length === 0}
          leerText="Für diesen Monat sind noch keine Budgets angelegt."
        >
          {(d) => (
            <Tabelle
              beschriftung="Budgets im Monat"
              spalten={spalten(darfVerwalten, {
                bearbeiten: (b) => {
                  setErfolg(null);
                  setFormular(b);
                },
                loeschenFrage,
                frageLoeschen: setLoeschenFrage,
                loeschen: (id) => loeschen.mutate(id),
                laeuft: loeschen.isPending,
              })}
              zeilen={d.budgets}
              schluessel={(b) => b.id}
            />
          )}
        </ZugriffAbfrage>
        {loeschen.isError && (
          <p role="alert" className="mt-2 text-sm text-red-800">
            {speicherFehler(loeschen.error)}
          </p>
        )}
        {erfolg && (
          <p role="status" className="mt-2 text-sm text-green-800">
            {erfolg}
          </p>
        )}
        {darfVerwalten && !abfrage.isError && formular === null && (
          <button
            type="button"
            className={`mt-3 ${KNOPF}`}
            onClick={() => {
              setErfolg(null);
              setFormular('neu');
            }}
          >
            Neues Budget
          </button>
        )}
        {darfVerwalten && formular !== null && (
          <BudgetFormular
            // Neuer Schlüssel je Budget: Felder starten beim Wechsel frisch.
            key={formular === 'neu' ? 'neu' : formular.id}
            budget={formular === 'neu' ? null : formular}
            monat={monat}
            onFertig={(text) => {
              setFormular(null);
              setErfolg(text);
            }}
            onAbbrechen={() => setFormular(null)}
          />
        )}
      </Abschnitt>
      <Alarme monat={monat} />
      {darfVerwalten && <Alarmkanaele />}
    </>
  );
}

export function Budgets() {
  const [monat] = useMonat();
  return (
    <section>
      <Seitenkopf titel="Budgets und Alarme">
        <MonatsWahl />
      </Seitenkopf>
      <BudgetsInhalt monat={monat} />
    </section>
  );
}
