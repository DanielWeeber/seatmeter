import { useDatenqualitaet } from '../api/abfragen';
import type { Datenqualitaet as DatenqualitaetAntwort } from '../api/typen';
import { Abfrage } from '../komponenten/Abfrage';
import {
  Abschnitt,
  Kachel,
  MonatsWahl,
  Seitenkopf,
  Tabelle,
  Werte,
} from '../komponenten/Bausteine';
import { prozent, zahl } from '../format';
import { useMonat } from '../monat';

type IngestZeile = DatenqualitaetAntwort['ingest'][number];

const QUELLEN: Record<IngestZeile['quelle'], string> = {
  a: 'Quelle A (OpenTelemetry)',
  b: 'Quelle B (Agent)',
  c: 'Quelle C (Abgleich)',
};

function istLeer(d: DatenqualitaetAntwort): boolean {
  return (
    d.abdeckung.anfragen === 0 &&
    d.unzugeordnet.anfragen === 0 &&
    d.ingest.length === 0 &&
    d.kontrollsumme.sitzungen === 0 &&
    d.modelle_ohne_preis.length === 0
  );
}

export function Datenqualitaet() {
  const [monat] = useMonat();
  const abfrage = useDatenqualitaet(monat);

  return (
    <section>
      <Seitenkopf titel="Datenqualität">
        <MonatsWahl />
      </Seitenkopf>
      <Abfrage abfrage={abfrage} istLeer={istLeer}>
        {(d) => (
          <>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kachel
                titel="Abdeckung Quelle A (OpenTelemetry)"
                wert={prozent(d.abdeckung.a_prozent)}
              />
              <Kachel titel="Abdeckung Quelle B (Agent)" wert={prozent(d.abdeckung.b_prozent)} />
              <Kachel
                titel="Tokens ohne Projekt"
                wert={prozent(d.unzugeordnet.tokens_prozent)}
                hinweis="Anteil an allen Tokens"
              />
              <Kachel
                titel="Vollständigkeit (Kontrollsumme)"
                wert={prozent(d.kontrollsumme.prozent)}
                hinweis="gezählte Tokens je OpenTelemetry-Summe"
              />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <Abschnitt titel="Anfragen nach Quelle">
                <Werte
                  eintraege={[
                    ['Einzelanfragen', zahl(d.abdeckung.anfragen)],
                    ['Nur Quelle A', zahl(d.abdeckung.nur_a)],
                    ['Nur Quelle B', zahl(d.abdeckung.nur_b)],
                    ['Beide Quellen', zahl(d.abdeckung.beide)],
                    ['Abweichung A/B', zahl(d.abdeckung.abweichung_ab)],
                    ['Heuristisch zusammengeführt', zahl(d.abdeckung.heuristisch)],
                  ]}
                />
              </Abschnitt>
              <Abschnitt titel="Ohne Projekt (unzugeordnet)">
                <Werte
                  eintraege={[
                    ['Anfragen', zahl(d.unzugeordnet.anfragen)],
                    ['Tokens', zahl(d.unzugeordnet.tokens)],
                    ['Anteil an allen Tokens', prozent(d.unzugeordnet.tokens_prozent)],
                  ]}
                />
              </Abschnitt>
            </div>
            <Abschnitt titel="Datenempfang (nur Anzahl)">
              {d.ingest.length === 0 ? (
                <p className="text-slate-600">Kein Datenempfang in diesem Monat.</p>
              ) : (
                <Tabelle<IngestZeile>
                  beschriftung="Angenommene und verworfene Ereignisse je Quelle"
                  zeilen={d.ingest}
                  schluessel={(z) => z.quelle}
                  spalten={[
                    { titel: 'Quelle', wert: (z) => QUELLEN[z.quelle] },
                    { titel: 'Angenommen', wert: (z) => zahl(z.angenommen), zahl: true },
                    { titel: 'Ohne Projekt', wert: (z) => zahl(z.unzugeordnet), zahl: true },
                    { titel: 'API (kein Abo)', wert: (z) => zahl(z.verworfen_api), zahl: true },
                    {
                      titel: 'Fremde Organisation',
                      wert: (z) => zahl(z.verworfen_fremd_org),
                      zahl: true,
                    },
                    {
                      titel: 'Inhalt verworfen',
                      wert: (z) => zahl(z.verworfen_inhalt),
                      zahl: true,
                    },
                  ]}
                />
              )}
            </Abschnitt>
            <div className="grid gap-6 lg:grid-cols-2">
              <Abschnitt titel="Kontrollsumme (OpenTelemetry)">
                <Werte
                  eintraege={[
                    ['Sitzungen', zahl(d.kontrollsumme.sitzungen)],
                    [
                      'Davon mit mehr als 1 % Abweichung',
                      zahl(d.kontrollsumme.sitzungen_abweichend),
                    ],
                    ['Tokens laut Kontrollsumme', zahl(d.kontrollsumme.tokens_kontrolle)],
                    ['Tokens gezählt', zahl(d.kontrollsumme.tokens_gezaehlt)],
                  ]}
                />
              </Abschnitt>
              <Abschnitt titel="Modelle ohne Preis">
                {d.modelle_ohne_preis.length === 0 ? (
                  <p className="text-slate-600">Alle Modelle haben eine Preiszeile.</p>
                ) : (
                  <>
                    <p className="mb-2 text-sm text-slate-600">
                      Schattenpreis 0, bis eine passende Preiszeile angelegt ist.
                    </p>
                    <ul className="rounded border border-slate-200 bg-white p-4">
                      {d.modelle_ohne_preis.map((m) => (
                        <li key={m}>
                          <code className="text-xs">{m}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Abschnitt>
            </div>
          </>
        )}
      </Abfrage>
    </section>
  );
}
