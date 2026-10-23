// Übersichts-Kachel „Budget-Prognose“: Prognose zum Monatsende gegen das mandantenweite Budget, sonst die
// Zahl der Budgets, deren Prognose über 100 % liegt. Ohne Berechtigung (403) oder ohne aktive Budgets bleibt
// die Kachel weg.
import { mengeText, prozent } from '../../format';
import { Kachel } from '../../komponenten/Bausteine';
import { ohneZugriff } from '../../komponenten/Zugriff';
import { useBudgets } from './abfragen';
import { budgetEinheit } from './texte';

export function PrognoseKachel({ monat }: { monat: string }) {
  const abfrage = useBudgets(monat);
  if (abfrage.isPending || ohneZugriff(abfrage.error)) return null;
  if (abfrage.isError)
    return <Kachel titel="Budget-Prognose" wert="—" hinweis="Budgets nicht verfügbar" />;

  const aktive = abfrage.data.budgets.filter((b) => b.aktiv);
  if (aktive.length === 0) return null;

  const gesamt = aktive.find((b) => b.projekt_id === null);
  if (gesamt) {
    const einheit = budgetEinheit(gesamt);
    const { prognose, prognose_prozent: pp } = gesamt.stand;
    return (
      <Kachel
        titel="Budget-Prognose"
        wert={
          prognose == null
            ? '—'
            : `${mengeText(prognose, einheit, true)} von ${mengeText(gesamt.betrag, einheit, true)}`
        }
        hinweis={
          pp == null
            ? (gesamt.stand.hinweis ?? 'Prognose nicht berechenbar')
            : `${prozent(pp)} zum Monatsende`
        }
      />
    );
  }

  const ueber = aktive.filter((b) => (b.stand.prognose_prozent ?? 0) > 100).length;
  return (
    <Kachel
      titel="Budget-Prognose"
      wert={`${ueber} von ${aktive.length}`}
      hinweis="Budgets über Prognose (zum Monatsende über 100 %)"
    />
  );
}
