// Seite „Abgleich“: seatmeter gegen die Zahlen von Anthropic abgleichen.
// Enterprise: Analytics-API-Key (Scope read:analytics, vom Primary Owner in claude.ai angelegt).
// Team: Spend-Report-CSV. Ohne Abgleich ist die Überschreitung nicht abgezogen.
// Routen: GET /api/v1/abgleich, GET …/laeufe, Key/Lauf siehe Schluessel.tsx, CSV siehe CsvImport.tsx.
import { useAuth } from '../../auth/AuthTor';
import { datumZeit } from '../../format';
import { Abschnitt, Seitenkopf, Werte } from '../../komponenten/Bausteine';
import { ZugriffAbfrage } from '../../komponenten/Zugriff';
import { useAbgleichStatus } from './abfragen';
import { CsvImport } from './CsvImport';
import { Laeufe } from './Laeufe';
import { Schluessel } from './Schluessel';
import { PLAN_TEXT, STATUS_TEXT, zeitraumText } from './texte';

function AbgleichInhalt() {
  const { darfVerwalten } = useAuth();
  const abfrage = useAbgleichStatus();

  return (
    <>
      <p className="mt-2 text-sm text-slate-600">
        Enterprise: Analytics-API-Key (Scope read:analytics), den der Primary Owner in claude.ai
        anlegt. Team: Spend-Report-CSV. Ohne Abgleich wird die Überschreitung nicht abgezogen
        („Überschreitung nicht abgezogen“ bei den Projektpreisen).
      </p>
      <ZugriffAbfrage abfrage={abfrage}>
        {(status) => (
          <>
            <Abschnitt titel="Stand">
              <Werte
                eintraege={[
                  ['Plan', PLAN_TEXT[status.plan] ?? status.plan],
                  ['Analytics-API-Key', status.key_gesetzt ? 'hinterlegt' : 'nicht hinterlegt'],
                  [
                    'Letzter Lauf',
                    status.letzter_lauf
                      ? `${STATUS_TEXT[status.letzter_lauf.status]} · ${zeitraumText(
                          status.letzter_lauf.von,
                          status.letzter_lauf.bis,
                        )} · ${datumZeit(status.letzter_lauf.gestartet)}`
                      : 'noch keiner',
                  ],
                ]}
              />
            </Abschnitt>
            {darfVerwalten && (
              <>
                <Abschnitt titel="Enterprise: Analytics-API">
                  <Schluessel status={status} />
                </Abschnitt>
                <Abschnitt titel="Team: Spend-Report-CSV">
                  <CsvImport />
                </Abschnitt>
              </>
            )}
            <Abschnitt titel="Läufe">
              <Laeufe />
            </Abschnitt>
          </>
        )}
      </ZugriffAbfrage>
    </>
  );
}

export function Abgleich() {
  return (
    <section>
      <Seitenkopf titel="Abgleich" />
      <AbgleichInhalt />
    </section>
  );
}
