import { usePersonen } from '../api/abfragen';
import { istApiFehler } from '../api/client';
import { Abfrage, Hinweis } from '../komponenten/Abfrage';
import { MonatsWahl, personenHinweisText, Seitenkopf, Tabelle } from '../komponenten/Bausteine';
import { useMonat } from '../monat';
import { PERSONEN_SPALTEN } from './ProjektDetail';

export function Personen() {
  const [monat] = useMonat();
  const abfrage = usePersonen(monat);

  return (
    <section>
      <Seitenkopf titel="Personen">
        <MonatsWahl />
      </Seitenkopf>
      <p className="mt-2 text-sm text-slate-600">
        Personen erscheinen als Pseudonym und nur als Monatssumme; Klarnamen nur, wenn der Mandant
        sie freigeschaltet hat.
      </p>
      {/* Ohne Personensicht antwortet der Server mit 403 `rolle_fehlt` (ganze Ressource verboten). */}
      {istApiFehler(abfrage.error, 403) && abfrage.error.code === 'rolle_fehlt' ? (
        <Hinweis>{personenHinweisText('Rolle ohne Personensicht')}</Hinweis>
      ) : (
        <Abfrage abfrage={abfrage} istLeer={(d) => d.personen !== null && d.personen.length === 0}>
          {(d) =>
            d.personen === null ? (
              <Hinweis>{personenHinweisText(d.personen_hinweis)}</Hinweis>
            ) : (
              <div className="mt-6">
                <Tabelle
                  beschriftung="Personen im Monat"
                  zeilen={d.personen}
                  schluessel={(p) => p.id}
                  spalten={PERSONEN_SPALTEN}
                />
              </div>
            )
          }
        </Abfrage>
      )}
    </section>
  );
}
