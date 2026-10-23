import { useKalkulation, useUebersicht } from '../api/abfragen';
import { istApiFehler } from '../api/client';
import type { ModellZeile } from '../api/typen';
import { Abfrage } from '../komponenten/Abfrage';
import {
  Abschnitt,
  Kachel,
  MonatsWahl,
  Seitenkopf,
  Tabelle,
  Werte,
  type Spalte,
} from '../komponenten/Bausteine';
import { ausCent, prozent, usdAusMikro, zahl } from '../format';
import { useMonat } from '../monat';
import { useUebersichtKacheln } from '../plugins';
import { kursText } from '../texte';

export const MODELL_SPALTEN: Spalte<ModellZeile>[] = [
  { titel: 'Modell', wert: (m) => <code className="text-xs">{m.model}</code> },
  { titel: 'Anfragen', wert: (m) => zahl(m.anfragen), zahl: true },
  { titel: 'Input', wert: (m) => zahl(m.tokens.input), zahl: true },
  { titel: 'Output', wert: (m) => zahl(m.tokens.output), zahl: true },
  { titel: 'Cache lesen', wert: (m) => zahl(m.tokens.cache_read), zahl: true },
  { titel: 'Cache schreiben', wert: (m) => zahl(m.tokens.cache_write), zahl: true },
  { titel: 'Schattenpreis', wert: (m) => usdAusMikro(m.schatten_usd_micros), zahl: true },
];

/**
 * Kachel „Projektpreise (EUR)“ aus GET /api/v1/kalkulation: Summe der Projektpreise in Euro, dazu
 * USD-Summe und Kurs. Rollen ohne Kalkulation (403, z. B. Betriebsrat) sehen die Kachel nicht.
 */
function ProjektpreisKachel({ monat }: { monat: string }) {
  const abfrage = useKalkulation(monat);
  if (istApiFehler(abfrage.error, 403)) return null;
  if (abfrage.isPending) return <Kachel titel="Projektpreise (EUR)" wert="…" />;
  if (abfrage.isError)
    return <Kachel titel="Projektpreise (EUR)" wert="—" hinweis="Kalkulation nicht verfügbar" />;
  const d = abfrage.data;
  const eur = d.summe.projektpreis_eur_cent;
  return (
    <Kachel
      titel="Projektpreise (EUR)"
      wert={eur == null ? '—' : ausCent(eur, 'EUR')}
      hinweis={`${ausCent(d.summe.projektpreis_usd_cent, 'USD')} · Kurs ${kursText(d.kurs)}`}
    />
  );
}

export function Uebersicht() {
  const [monat] = useMonat();
  const abfrage = useUebersicht(monat);
  const kacheln = useUebersichtKacheln();

  return (
    <section>
      <Seitenkopf titel="Übersicht">
        <MonatsWahl />
      </Seitenkopf>
      <Abfrage abfrage={abfrage} istLeer={(d) => d.anfragen === 0 && d.nach_modell.length === 0}>
        {(d) => (
          <>
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kachel titel="Input-Tokens" wert={zahl(d.tokens.input)} />
              <Kachel titel="Output-Tokens" wert={zahl(d.tokens.output)} />
              <Kachel titel="Cache lesen" wert={zahl(d.tokens.cache_read)} />
              <Kachel titel="Cache schreiben" wert={zahl(d.tokens.cache_write)} />
              <Kachel titel="Tokens gesamt" wert={zahl(d.tokens.gesamt)} />
              <Kachel titel="Anfragen" wert={zahl(d.anfragen)} />
              <Kachel
                titel="Schattenpreis (USD)"
                wert={usdAusMikro(d.schatten_usd_micros)}
                hinweis="zu API-Listenpreisen"
              />
              <ProjektpreisKachel monat={monat} />
              {kacheln.map((PluginKachel, i) => (
                <PluginKachel key={i} monat={monat} />
              ))}
            </div>

            <Abschnitt titel="Nach Modell">
              {d.nach_modell.length === 0 ? (
                <p className="text-slate-600">Keine Modelle in diesem Monat.</p>
              ) : (
                <Tabelle
                  beschriftung="Verbrauch nach Modell"
                  spalten={MODELL_SPALTEN}
                  zeilen={d.nach_modell}
                  schluessel={(m) => m.model}
                />
              )}
            </Abschnitt>

            <div className="grid gap-6 lg:grid-cols-2">
              <Abschnitt titel="Abdeckung der Quellen">
                <Werte
                  eintraege={[
                    ['Quelle A (OpenTelemetry)', prozent(d.abdeckung.a_prozent)],
                    ['Quelle B (Agent)', prozent(d.abdeckung.b_prozent)],
                    ['Einzelanfragen im Monat', zahl(d.abdeckung.anfragen)],
                  ]}
                />
              </Abschnitt>
              <Abschnitt titel="Gefiltert (nur Anzahl)">
                <Werte
                  eintraege={[
                    ['API-Anfragen', zahl(d.gefiltert.api)],
                    ['Fremde Organisationen', zahl(d.gefiltert.fremd_org)],
                    ['Verworfene Inhaltsereignisse', zahl(d.gefiltert.inhalt_verworfen)],
                  ]}
                />
              </Abschnitt>
            </div>
          </>
        )}
      </Abfrage>
    </section>
  );
}
