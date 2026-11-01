// Berichte (Architektur §7): Projektabrechnung als CSV und Betriebsrats-Bericht (Ansicht aus
// format=json, dazu HTML und CSV). Downloads laufen als Links mit der Cookie-Sitzung; jeder Abruf
// steht serverseitig im Audit: Downloads als „Export …“, das Öffnen des Betriebsrats-Berichts
// (Dashboard-Ansicht, HTML-Seite) als „Ansicht Betriebsrat“.
import { berichtPfad, useBetriebsratBericht } from '../api/abfragen';
import type { BetriebsratBericht, Rolle } from '../api/typen';
import { useAuth } from '../auth/AuthTor';
import { Abfrage } from '../komponenten/Abfrage';
import { Abschnitt, MonatsWahl, Seitenkopf, Tabelle, Werte } from '../komponenten/Bausteine';
import { datum, datumZeit, zahl } from '../format';
import { monatsname, useMonat } from '../monat';

const ROLLEN_TEXT: Record<Rolle, string> = {
  mandanten_admin: 'Mandanten-Admin',
  projektleiter: 'Projektleitung',
  controller: 'Controller/Leser',
  betriebsrat: 'Betriebsrat',
  entwickler: 'Entwicklung',
};

/** Lesbare Namen für Audit-Aktionen der Berichte (Server: AUDIT_AKTION im Modul audit). */
export const AKTION_TEXT: Record<string, string> = {
  'Ansicht Betriebsrat': 'Betriebsrats-Bericht angesehen (Dashboard oder HTML)',
  'Export Betriebsrat': 'Betriebsrats-Bericht heruntergeladen (CSV)',
  'Export Projektabrechnung': 'Projektabrechnung heruntergeladen',
};

const link =
  'inline-block rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100';

function Liste({ eintraege }: { eintraege: string[] }) {
  return (
    <ul className="list-disc pl-5 text-sm">
      {eintraege.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

function BetriebsratAnsicht({ b }: { b: BetriebsratBericht }) {
  const k = b.konfiguration;
  const quellen = [
    k.quellen.a && 'A (OpenTelemetry)',
    k.quellen.b && 'B (Agent)',
    k.quellen.c && 'C (Abgleich)',
  ]
    .filter((q): q is string => !!q)
    .join(', ');
  return (
    <div className="mt-4" aria-label="Betriebsrats-Bericht">
      <p className="text-sm text-slate-600">
        Zeitraum {datum(b.zeitraum.von)} bis {datum(b.zeitraum.bis)}, erstellt{' '}
        {datumZeit(b.erstellt)}.
      </p>

      <h3 className="mt-6 mb-2 font-semibold">Zweck</h3>
      <p className="rounded border border-slate-200 bg-white p-4 text-sm">{b.zweck}</p>

      <h3 className="mt-6 mb-2 font-semibold">Konfiguration</h3>
      <Werte
        eintraege={[
          ['Auswertungsstufe', b.konfiguration.auswertungsstufe_text],
          ['Klarnamen', k.klarnamen_aktiv ? 'aktiv' : 'aus'],
          ['Mindestgruppe', `${zahl(k.mindestgruppe)} Personen`],
          ['Aktive Quellen', quellen || 'keine'],
          ['Einzelanfragen', `${zahl(k.aufbewahrung.anfrage_tage)} Tage`],
          ['Tagesaggregate', `${zahl(k.aufbewahrung.aggregat_monate)} Monate`],
          ['Monatsabschlüsse', `${zahl(k.aufbewahrung.abschluss_monate)} Monate`],
          ['Kontrollsummen', `${zahl(k.aufbewahrung.kontrollsumme_tage)} Tage`],
          ['Ingest-Statistik', `${zahl(k.aufbewahrung.statistik_monate)} Monate`],
          ['Zugriffsprotokoll', `${zahl(k.aufbewahrung.audit_monate)} Monate`],
        ]}
      />
      <h4 className="mt-4 mb-2 text-sm font-semibold">Änderungen im Zeitraum</h4>
      {k.aenderungen.length === 0 ? (
        <p className="text-sm text-slate-600">Keine Änderungen.</p>
      ) : (
        <Tabelle
          beschriftung="Konfigurationsänderungen"
          zeilen={k.aenderungen}
          schluessel={(a, i) => `${a.ts}:${i}`}
          spalten={[
            { titel: 'Zeitpunkt', wert: (a) => datumZeit(a.ts) },
            { titel: 'Aktion', wert: (a) => a.aktion },
            { titel: 'Objekt', wert: (a) => a.objekt ?? '' },
          ]}
        />
      )}

      <h3 className="mt-6 mb-2 font-semibold">Datenkategorien</h3>
      <div className="grid gap-4 rounded border border-slate-200 bg-white p-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium">Erfasst</p>
          <Liste eintraege={b.datenkategorien.erfasst} />
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Ausdrücklich nicht erfasst</p>
          <Liste eintraege={b.datenkategorien.nicht_erfasst} />
        </div>
      </div>

      <h3 className="mt-6 mb-2 font-semibold">Zugriffe</h3>
      <Werte
        eintraege={[
          ...b.zugriffe.konten.map(
            (z) =>
              [`Konten ${ROLLEN_TEXT[z.rolle] ?? z.rolle}`, zahl(z.anzahl)] as [string, string],
          ),
          ['Personensichten geöffnet', zahl(b.zugriffe.personensichten)],
          ['Exporte (Downloads)', zahl(b.zugriffe.exporte)],
          ['Berichtsansichten', zahl(b.zugriffe.ansichten)],
        ]}
      />
      {b.zugriffe.protokoll.length > 0 && (
        <div className="mt-4">
          <Tabelle
            beschriftung="Zugriffsprotokoll je Aktion"
            zeilen={b.zugriffe.protokoll}
            schluessel={(p) => p.aktion}
            spalten={[
              { titel: 'Aktion', wert: (p) => AKTION_TEXT[p.aktion] ?? p.aktion },
              { titel: 'Anzahl', wert: (p) => zahl(p.anzahl), zahl: true },
            ]}
          />
        </div>
      )}

      <h3 className="mt-6 mb-2 font-semibold">Mengen</h3>
      <Werte
        eintraege={[
          ['Gezählte Personen', zahl(b.mengen.personen)],
          ['Rechner', zahl(b.mengen.rechner)],
          ['Projekte', zahl(b.mengen.projekte)],
          ['Anfragen', zahl(b.mengen.anfragen)],
          ['Tokens', zahl(b.mengen.tokens)],
        ]}
      />

      <h3 className="mt-6 mb-2 font-semibold">Datenschutznachweise</h3>
      <Werte
        eintraege={[
          ['Angenommene Anfragen', zahl(b.datenschutz.angenommen)],
          ['Verworfene Ereignisse mit Inhalten', zahl(b.datenschutz.verworfen_inhalt)],
          ['Gefilterte API-Anfragen', zahl(b.datenschutz.verworfen_api)],
          ['Gefilterte fremde Organisationen', zahl(b.datenschutz.verworfen_fremd_org)],
          ['Ohne Projektzuordnung', zahl(b.datenschutz.unzugeordnet)],
        ]}
      />
      <h4 className="mt-4 mb-2 text-sm font-semibold">Löschläufe</h4>
      {b.datenschutz.loeschlaeufe.length === 0 ? (
        <p className="text-sm text-slate-600">Keine Löschläufe im Zeitraum.</p>
      ) : (
        <Tabelle
          beschriftung="Löschläufe"
          zeilen={b.datenschutz.loeschlaeufe}
          schluessel={(l, i) => `${l.ts}:${l.tabelle}:${i}`}
          spalten={[
            { titel: 'Zeitpunkt', wert: (l) => datumZeit(l.ts) },
            { titel: 'Tabelle', wert: (l) => <code className="text-xs">{l.tabelle}</code> },
            { titel: 'Gelöscht bis', wert: (l) => datum(l.bis) },
            { titel: 'Zeilen', wert: (l) => zahl(l.anzahl), zahl: true },
          ]}
        />
      )}

      <h3 className="mt-6 mb-2 font-semibold">Version</h3>
      <Werte
        eintraege={[
          ['seatmeter', b.version.seatmeter],
          ['Agenten', b.version.agenten.length ? b.version.agenten.join(', ') : 'keine'],
        ]}
      />

      <h3 className="mt-6 mb-2 font-semibold">Hinweis</h3>
      <p className="rounded border border-slate-200 bg-white p-4 text-sm">{b.hinweis}</p>
    </div>
  );
}

export function Berichte() {
  const [monat] = useMonat();
  const { me } = useAuth();
  // Ohne Auth-Modul (me = null) entscheidet der Server; sonst nach Rolle (server berichte).
  const rollen = me?.rollen ?? null;
  const darfAbrechnung =
    rollen === null || rollen.some((r) => r !== 'betriebsrat' && r !== 'entwickler');
  const darfBetriebsrat =
    rollen === null || rollen.includes('mandanten_admin') || rollen.includes('betriebsrat');
  const bericht = useBetriebsratBericht(monat, darfBetriebsrat);

  return (
    <section>
      <Seitenkopf titel="Berichte">
        <MonatsWahl />
      </Seitenkopf>

      {darfAbrechnung && (
        <Abschnitt titel="Projektabrechnung">
          <p className="mb-3 text-sm text-slate-600">
            Projektpreise {monatsname(monat)} je Projekt als CSV (Semikolon, Dezimalkomma, für
            Excel). Abgeschlossene Monate kommen aus dem Monatsabschluss, sonst ist der Stand
            vorläufig. Keine Personendaten.
          </p>
          <a href={berichtPfad('projektabrechnung', monat, 'csv')} download className={link}>
            Projektabrechnung als CSV herunterladen
          </a>
        </Abschnitt>
      )}

      {darfBetriebsrat && (
        <Abschnitt titel="Betriebsrats-Bericht">
          <p className="mb-3 text-sm text-slate-600">
            Nur Zähler und Konfiguration, keine Werte je Person. Jeder Abruf wird protokolliert:
            Öffnen als Ansicht, der CSV-Download als Export.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href={berichtPfad('betriebsrat', monat, 'html')}
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              Als HTML öffnen
            </a>
            <a href={berichtPfad('betriebsrat', monat, 'csv')} download className={link}>
              CSV herunterladen
            </a>
          </div>
          <Abfrage abfrage={bericht}>{(b) => <BetriebsratAnsicht b={b} />}</Abfrage>
        </Abschnitt>
      )}

      {!darfAbrechnung && !darfBetriebsrat && (
        <p className="mt-4 text-slate-600">Ihre Rolle hat keinen Zugriff auf Berichte.</p>
      )}
    </section>
  );
}
