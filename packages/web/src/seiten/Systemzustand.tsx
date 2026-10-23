import { useHealth, useIngestHealth } from '../api/abfragen';
import type { IngestHealth } from '../api/typen';
import { Abfrage } from '../komponenten/Abfrage';
import { Abschnitt, Seitenkopf, Tabelle } from '../komponenten/Bausteine';
import { datumZeit, dezimalzahl, LEER, zahl } from '../format';

const inOrdnung = (wert: string) => (wert === 'ok' ? 'in Ordnung' : wert);

type QuellenZeile = { name: string; quelle: IngestHealth['quellen']['a'] };

/** Summe der heute verworfenen Ereignisse (Inhalt, API, fremde Organisation). */
function verworfenHeute(q: QuellenZeile['quelle']): number | null {
  if (!q.heute) return null;
  return q.heute.verworfen_inhalt + q.heute.verworfen_api + q.heute.verworfen_fremd_org;
}

export function Systemzustand() {
  const health = useHealth();
  const ingest = useIngestHealth();

  return (
    <section>
      <Seitenkopf titel="Systemzustand" />
      <Abschnitt titel="Server">
        {health.isPending && <p className="text-slate-600">Prüfe Server …</p>}
        {health.isError && (
          <p className="text-red-700" role="alert">
            Server nicht erreichbar: {health.error.message}
          </p>
        )}
        {health.isSuccess && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border border-slate-200 bg-white p-4">
            <dt className="font-medium">Server</dt>
            <dd>{inOrdnung(health.data.status)}</dd>
            <dt className="font-medium">Datenbank</dt>
            <dd>{inOrdnung(health.data.db)}</dd>
          </dl>
        )}
      </Abschnitt>
      <Abschnitt titel="Datenempfang (Ingest)">
        <Abfrage abfrage={ingest}>
          {(d) => (
            <Tabelle<QuellenZeile>
              beschriftung="Datenempfang je Quelle"
              zeilen={[
                { name: 'Quelle A (OpenTelemetry)', quelle: d.quellen.a },
                { name: 'Quelle B (Agent)', quelle: d.quellen.b },
              ]}
              schluessel={(z) => z.name}
              spalten={[
                { titel: 'Quelle', wert: (z) => z.name },
                {
                  titel: 'Letzte Annahme',
                  wert: (z) =>
                    z.quelle.letzte_annahme ? datumZeit(z.quelle.letzte_annahme) : 'noch keine',
                },
                {
                  titel: 'Ohne Daten seit',
                  wert: (z) =>
                    z.quelle.stille_stunden == null
                      ? LEER
                      : `${dezimalzahl(z.quelle.stille_stunden)} h`,
                  zahl: true,
                },
                {
                  titel: 'Anfragen (24 h)',
                  wert: (z) => zahl(z.quelle.anfragen_24h),
                  zahl: true,
                },
                {
                  titel: 'Heute angenommen',
                  wert: (z) => zahl(z.quelle.heute?.angenommen),
                  zahl: true,
                },
                {
                  titel: 'Heute verworfen',
                  wert: (z) => zahl(verworfenHeute(z.quelle)),
                  zahl: true,
                },
              ]}
            />
          )}
        </Abfrage>
      </Abschnitt>
    </section>
  );
}
