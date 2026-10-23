import { Link } from 'react-router';
import { useProjekte } from '../api/abfragen';
import { UNZUGEORDNET, type ProjektZeile } from '../api/typen';
import { Abfrage } from '../komponenten/Abfrage';
import { MonatsWahl, personenHinweisText, Seitenkopf, Tabelle } from '../komponenten/Bausteine';
import { LEER, usdAusMikro, zahl } from '../format';
import { useMonat } from '../monat';

/** Anzeigename; der Topf ohne Projekt (`id: null`) heißt im Dashboard „Ohne Projekt“. */
export function projektTitel(p: { id: string | null; name: string }): string {
  return p.id === null ? 'Ohne Projekt (unzugeordnet)' : p.name;
}

/** Pfad-Kennung für die Detailseite: UUID oder `unzugeordnet` (Server-Route `/projekte/unzugeordnet`). */
export function projektPfadId(p: { id: string | null }): string {
  return p.id ?? UNZUGEORDNET;
}

function Personenzahl({ p }: { p: ProjektZeile }) {
  if (p.personen != null) return <>{zahl(p.personen)}</>;
  if (!p.personen_hinweis) return <>{LEER}</>;
  return (
    <span className="text-slate-500" title={personenHinweisText(p.personen_hinweis)}>
      {p.personen_hinweis === 'zu wenige Personen' ? 'zu wenige' : LEER}
    </span>
  );
}

export function Projekte() {
  const [monat] = useMonat();
  const abfrage = useProjekte(monat);

  return (
    <section>
      <Seitenkopf titel="Projekte">
        <MonatsWahl />
      </Seitenkopf>
      <Abfrage abfrage={abfrage} istLeer={(d) => d.projekte.length === 0}>
        {(d) => (
          <div className="mt-6">
            <Tabelle<ProjektZeile>
              beschriftung="Projekte im Monat"
              zeilen={[...d.projekte].sort((a, b) => b.schatten_usd_micros - a.schatten_usd_micros)}
              schluessel={projektPfadId}
              spalten={[
                {
                  titel: 'Projekt',
                  wert: (p) => (
                    <Link
                      to={`/projekte/${encodeURIComponent(projektPfadId(p))}?monat=${monat}`}
                      className={`font-medium underline decoration-slate-300 hover:decoration-slate-900 ${
                        p.id === null ? 'italic text-slate-700' : 'text-slate-900'
                      }`}
                    >
                      {projektTitel(p)}
                    </Link>
                  ),
                },
                { titel: 'Kunde', wert: (p) => p.kunde ?? LEER },
                ...(d.auswertungsstufe > 0
                  ? [
                      {
                        titel: 'Personen',
                        wert: (p: ProjektZeile) => <Personenzahl p={p} />,
                        zahl: true,
                      },
                    ]
                  : []),
                { titel: 'Anfragen', wert: (p) => zahl(p.anfragen), zahl: true },
                { titel: 'Tokens', wert: (p) => zahl(p.tokens.gesamt), zahl: true },
                {
                  titel: 'Schattenpreis',
                  wert: (p) => usdAusMikro(p.schatten_usd_micros),
                  zahl: true,
                },
              ]}
            />
          </div>
        )}
      </Abfrage>
    </section>
  );
}
