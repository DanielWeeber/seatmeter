import { lazy, Suspense } from 'react';
import { Link, useParams } from 'react-router';
import { useProjekt } from '../api/abfragen';
import type { PersonZeile } from '../api/typen';
import { Abfrage, Hinweis, Laden } from '../komponenten/Abfrage';
import {
  Abschnitt,
  MonatsWahl,
  personenHinweisText,
  Seitenkopf,
  Tabelle,
  Werte,
  type Spalte,
} from '../komponenten/Bausteine';
import { datum, LEER, usdAusMikro, zahl } from '../format';
import { useMonat } from '../monat';
import { ProjektIssues } from './ProjektIssues';
import { projektTitel } from './Projekte';
import { MODELL_SPALTEN } from './Uebersicht';

const Verlauf = lazy(() => import('../komponenten/Verlauf'));

/** Pseudonym, bei freigeschalteten Klarnamen zusätzlich Name oder E-Mail. */
export function PersonName({ p }: { p: PersonZeile }) {
  const klar = p.klarname?.name ?? p.klarname?.email ?? null;
  return (
    <>
      <code className="text-xs">{p.pseudonym}</code>
      {klar && <span className="ml-2 text-slate-600">{klar}</span>}
    </>
  );
}

export const PERSONEN_SPALTEN: Spalte<PersonZeile>[] = [
  { titel: 'Person', wert: (p) => <PersonName p={p} /> },
  { titel: 'Anfragen', wert: (p) => zahl(p.anfragen), zahl: true },
  { titel: 'Tokens', wert: (p) => zahl(p.tokens.gesamt), zahl: true },
  { titel: 'Schattenpreis', wert: (p) => usdAusMikro(p.schatten_usd_micros), zahl: true },
];

export function ProjektDetail() {
  const { id = '' } = useParams();
  const [monat] = useMonat();
  const abfrage = useProjekt(id, monat);

  return (
    <section>
      <p className="mb-2 text-sm">
        <Link to={`/projekte?monat=${monat}`} className="text-slate-600 hover:text-slate-900">
          ← Alle Projekte
        </Link>
      </p>
      <Seitenkopf titel={abfrage.data ? projektTitel(abfrage.data.projekt) : 'Projekt'}>
        <MonatsWahl />
      </Seitenkopf>
      <Abfrage abfrage={abfrage}>
        {(d) => {
          const leer = d.anfragen === 0 && d.nach_modell.length === 0 && d.nach_tag.length === 0;
          const repository =
            d.projekt.id === null ? LEER : (d.projekt.url_norm ?? 'kein Repo (Pfad-Projekt)');
          return (
            <>
              <div className="mt-4">
                <Werte
                  eintraege={[
                    ['Kunde', d.projekt.kunde ?? LEER],
                    ['Repository', repository],
                    ...(leer
                      ? []
                      : ([
                          ['Anfragen', zahl(d.anfragen)],
                          ['Tokens', zahl(d.tokens.gesamt)],
                          ['Schattenpreis', usdAusMikro(d.schatten_usd_micros)],
                        ] as [string, string][])),
                  ]}
                />
              </div>
              {leer ? (
                <p className="mt-4 rounded border border-slate-200 bg-white p-4 text-slate-700">
                  Für diesen Monat liegen noch keine Daten vor.
                </p>
              ) : (
                <>
                  <Abschnitt titel="Verlauf">
                    {d.nach_tag.length === 0 ? (
                      <p className="text-slate-600">Kein Tagesverlauf vorhanden.</p>
                    ) : (
                      <>
                        <Suspense fallback={<Laden text="Lade Diagramm …" />}>
                          <Verlauf tage={d.nach_tag} />
                        </Suspense>
                        <details className="mt-2 text-sm">
                          <summary className="cursor-pointer text-slate-600">
                            Als Tabelle anzeigen
                          </summary>
                          <div className="mt-2">
                            <Tabelle
                              beschriftung="Verbrauch je Tag"
                              zeilen={d.nach_tag}
                              schluessel={(t) => t.tag}
                              spalten={[
                                { titel: 'Tag', wert: (t) => datum(t.tag) },
                                { titel: 'Anfragen', wert: (t) => zahl(t.anfragen), zahl: true },
                                {
                                  titel: 'Tokens',
                                  wert: (t) => zahl(t.tokens.gesamt),
                                  zahl: true,
                                },
                                {
                                  titel: 'Schattenpreis',
                                  wert: (t) => usdAusMikro(t.schatten_usd_micros),
                                  zahl: true,
                                },
                              ]}
                            />
                          </div>
                        </details>
                      </>
                    )}
                  </Abschnitt>
                  <Abschnitt titel="Nach Modell und Tokentyp">
                    <Tabelle
                      beschriftung="Verbrauch nach Modell und Tokentyp"
                      spalten={MODELL_SPALTEN}
                      zeilen={d.nach_modell}
                      schluessel={(m) => m.model}
                    />
                  </Abschnitt>
                  <ProjektIssues id={id} monat={monat} />
                  <Abschnitt titel="Personen">
                    {d.personen === null ? (
                      <Hinweis>{personenHinweisText(d.personen_hinweis)}</Hinweis>
                    ) : d.personen.length === 0 ? (
                      <p className="text-slate-600">Keine Personen in diesem Monat.</p>
                    ) : (
                      <Tabelle
                        beschriftung="Personen im Projekt"
                        zeilen={d.personen}
                        schluessel={(p) => p.id}
                        spalten={PERSONEN_SPALTEN}
                      />
                    )}
                  </Abschnitt>
                </>
              )}
            </>
          );
        }}
      </Abfrage>
    </section>
  );
}
