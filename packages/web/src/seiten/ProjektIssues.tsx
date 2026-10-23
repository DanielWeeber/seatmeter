// Abschnitt „Issues“ der Projektseite: Kosten je Issue-Schlüssel (z. B. ABC-123) aus
// dem Branch-Namen. Gespeichert und angezeigt wird nur der Schlüssel, nie der Branch-Name.
import { issuesCsvPfad, useProjektIssues } from '../api/abfragen';
import type { IssueZeile } from '../api/typen';
import { Abfrage } from '../komponenten/Abfrage';
import { Abschnitt, Tabelle, type Spalte } from '../komponenten/Bausteine';
import { prozent, usdAusMikro, zahl } from '../format';

export const TEXT_KEINE_ISSUES =
  'Keine Issue-Schlüssel erkannt. Erfasst werden Schlüssel wie ABC-123 aus dem Branch-Namen ' +
  '(Agent ab 0.1.3 bzw. Start-Wrapper); der Branch-Name selbst verlässt den Rechner nie.';

const link =
  'inline-block rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100';

type Zeile = IssueZeile & { anteil: number | null };

function spalten(): Spalte<Zeile>[] {
  return [
    {
      titel: 'Issue',
      wert: (i) =>
        i.schluessel ? <code className="text-xs">{i.schluessel}</code> : 'ohne Issue-Schlüssel',
    },
    { titel: 'Sitzungen', wert: (i) => (i.schluessel ? zahl(i.sitzungen) : ''), zahl: true },
    { titel: 'Anfragen', wert: (i) => zahl(i.anfragen), zahl: true },
    { titel: 'Tokens', wert: (i) => zahl(i.tokens.gesamt), zahl: true },
    { titel: 'Schattenpreis', wert: (i) => usdAusMikro(i.schatten_usd_micros), zahl: true },
    { titel: 'Anteil', wert: (i) => prozent(i.anteil), zahl: true },
  ];
}

export function ProjektIssues({ id, monat }: { id: string; monat: string }) {
  const abfrage = useProjektIssues(id, monat);
  return (
    <Abschnitt titel="Issues">
      <Abfrage abfrage={abfrage}>
        {(d) => {
          if (d.issues.length === 0) return <p className="text-slate-600">{TEXT_KEINE_ISSUES}</p>;
          const ganz = d.gesamt.schatten_usd_micros;
          const anteil = (w: number) => (ganz > 0 ? Math.round((w / ganz) * 1000) / 10 : null);
          const zeilen: Zeile[] = [
            ...d.issues.map((i) => ({ ...i, anteil: anteil(i.schatten_usd_micros) })),
            {
              ...d.ohne_schluessel,
              schluessel: '',
              projekt_schluessel: '',
              sitzungen: 0,
              anteil: anteil(d.ohne_schluessel.schatten_usd_micros),
            },
          ];
          return (
            <>
              <Tabelle
                beschriftung="Kosten je Issue"
                zeilen={zeilen}
                schluessel={(i) => i.schluessel || 'ohne'}
                spalten={spalten()}
              />
              <p className="mt-2 text-sm text-slate-600">
                Eine Anfrage mit mehreren Schlüsseln im Branch-Namen zählt anteilig je Schlüssel.
              </p>
              <a href={issuesCsvPfad(id, monat)} download className={`${link} mt-2`}>
                Issues als CSV herunterladen
              </a>
            </>
          );
        }}
      </Abfrage>
    </Abschnitt>
  );
}
