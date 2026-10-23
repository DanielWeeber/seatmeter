// Formular „Neues Budget“ / „Budget bearbeiten“ (POST bzw. PUT /api/v1/budgets).
// Geprüft wird vorab mit dem Vertrag aus @seatmeter/shared; der Server prüft ein zweites Mal.
import {
  BUDGET_AUSLOESER,
  BUDGET_BASEN,
  BUDGET_WAEHRUNGEN,
  STANDARD_SCHWELLEN,
  budgetEingabeSchema,
  budgetSchema,
  type Budget,
} from '@seatmeter/shared';
import { useProjekte } from '../../api/abfragen';
import { ApiFehler, useApi } from '../../api/client';
import { Auswahl, Eingabe, Formular, Kontrollkaestchen } from '../../komponenten/Formular';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { betragAus, listeAus } from '../../format';
import { KNOPF } from '../../komponenten/knoepfe';
import { speicherFehler } from '../../komponenten/Zugriff';
import { AUSLOESER_TEXT } from './texte';

const BASIS_TEXT: Record<(typeof BUDGET_BASEN)[number], string> = {
  projektpreis: 'Projektpreis (Geldbetrag)',
  tokens: 'Tokens',
};

type Feld = 'projekt_id' | 'bezeichnung' | 'betrag' | 'schwellen';
const FELDER: readonly Feld[] = ['projekt_id', 'bezeichnung', 'betrag', 'schwellen'];

const FELD_TEXT: Record<Feld, string> = {
  projekt_id: 'Bitte ein Projekt wählen.',
  bezeichnung: 'Die Bezeichnung darf höchstens 200 Zeichen lang sein.',
  betrag: 'Bitte einen Betrag größer als 0 angeben.',
  schwellen: 'Schwellen: 1 bis 10 ganze Prozentwerte zwischen 1 und 1000, z. B. 50, 80, 100.',
};

const alsFeld = (f: unknown): Feld | null => FELDER.find((x) => x === f) ?? null;

export function BudgetFormular({
  budget,
  monat,
  onFertig,
  onAbbrechen,
}: {
  /** `null` = neues Budget. */
  budget: Budget | null;
  monat: string;
  onFertig: (erfolg: string) => void;
  onAbbrechen: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const projekte = useProjekte(monat);
  const [projekt, setProjekt] = useState(budget?.projekt_id ?? '');
  const [bezeichnung, setBezeichnung] = useState(budget?.bezeichnung ?? '');
  const [basis, setBasis] = useState<string>(budget?.basis ?? 'projektpreis');
  const [waehrung, setWaehrung] = useState<string>(budget?.waehrung ?? 'EUR');
  const [betrag, setBetrag] = useState(budget ? String(budget.betrag).replace('.', ',') : '');
  const [schwellen, setSchwellen] = useState((budget?.schwellen ?? STANDARD_SCHWELLEN).join(', '));
  const [ausloeser, setAusloeser] = useState<string>(budget?.ausloeser ?? 'verbrauch');
  const [aktiv, setAktiv] = useState(budget?.aktiv ?? true);
  const [feldFehler, setFeldFehler] = useState<Partial<Record<Feld, string>>>({});
  const [meldung, setMeldung] = useState<string | null>(null);

  const speichern = useMutation({
    mutationFn: (koerper: unknown) =>
      budget
        ? api.put(`/api/v1/budgets/${encodeURIComponent(budget.id)}`, koerper, budgetSchema)
        : api.post('/api/v1/budgets', koerper, budgetSchema),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['budgets'] });
      onFertig(budget ? 'Budget gespeichert.' : 'Budget angelegt.');
    },
    onError: (fehler) => {
      if (fehler instanceof ApiFehler && fehler.status === 400) {
        const je: Partial<Record<Feld, string>> = {};
        for (const d of fehler.details) {
          const feld = alsFeld(d.feld);
          if (feld && !je[feld]) je[feld] = d.meldung;
        }
        setFeldFehler(je);
      }
      setMeldung(speicherFehler(fehler));
    },
  });

  const absenden = () => {
    setMeldung(null);
    const zahlen = listeAus(schwellen).map(Number);
    const ergebnis = budgetEingabeSchema.safeParse({
      projekt_id: projekt === '' ? null : projekt,
      bezeichnung: bezeichnung.trim() === '' ? null : bezeichnung.trim(),
      betrag: betragAus(betrag, basis === 'tokens'),
      waehrung,
      basis,
      schwellen: zahlen,
      ausloeser,
      aktiv,
    });
    if (!ergebnis.success) {
      const je: Partial<Record<Feld, string>> = {};
      for (const issue of ergebnis.error.issues) {
        const feld = alsFeld(issue.path[0]);
        if (feld && !je[feld]) je[feld] = FELD_TEXT[feld];
      }
      setFeldFehler(je);
      setMeldung('Bitte die markierten Felder prüfen.');
      return;
    }
    setFeldFehler({});
    speichern.mutate(ergebnis.data);
  };

  // Projektliste des Monats; ein Budget auf ein Projekt außerhalb der Liste bleibt wählbar.
  const optionen: [string, string][] = [['', 'Alle Projekte (mandantenweit)']];
  for (const p of projekte.data?.projekte ?? []) if (p.id) optionen.push([p.id, p.name]);
  if (budget?.projekt_id && !optionen.some(([id]) => id === budget.projekt_id))
    optionen.push([budget.projekt_id, budget.projekt_name ?? budget.projekt_id]);

  return (
    <>
      <Formular
        titel={budget ? 'Budget bearbeiten' : 'Neues Budget'}
        onAbsenden={absenden}
        laeuft={speichern.isPending}
        meldung={meldung}
      >
        <Auswahl
          beschriftung="Projekt"
          wert={projekt}
          onAendern={setProjekt}
          optionen={optionen}
          fehler={feldFehler.projekt_id}
        />
        <Eingabe
          beschriftung="Bezeichnung (optional)"
          wert={bezeichnung}
          onAendern={setBezeichnung}
          fehler={feldFehler.bezeichnung}
        />
        <Auswahl
          beschriftung="Basis"
          wert={basis}
          onAendern={setBasis}
          optionen={BUDGET_BASEN.map((b) => [b, BASIS_TEXT[b]] as const)}
        />
        {basis === 'projektpreis' && (
          <Auswahl
            beschriftung="Währung"
            wert={waehrung}
            onAendern={setWaehrung}
            optionen={BUDGET_WAEHRUNGEN.map((w) => [w, w] as const)}
          />
        )}
        <Eingabe
          beschriftung={basis === 'tokens' ? 'Betrag (Tokens)' : `Betrag (${waehrung})`}
          wert={betrag}
          dezimal
          onAendern={setBetrag}
          fehler={feldFehler.betrag}
        />
        <Eingabe
          beschriftung="Schwellen (Prozent, durch Komma getrennt)"
          wert={schwellen}
          onAendern={setSchwellen}
          fehler={feldFehler.schwellen}
        />
        <Auswahl
          beschriftung="Auslöser"
          wert={ausloeser}
          onAendern={setAusloeser}
          optionen={BUDGET_AUSLOESER.map((a) => [a, AUSLOESER_TEXT[a]] as const)}
        />
        <Kontrollkaestchen beschriftung="Aktiv" wert={aktiv} onAendern={setAktiv} />
      </Formular>
      <button type="button" className={`mt-2 ${KNOPF}`} onClick={onAbbrechen}>
        Abbrechen
      </button>
    </>
  );
}
