// Seite „Projektkatalog“ (Einrichtung, nur Mandanten-Admin): Stand, Import per CSV, Schalter für die erzwungene
// Projektwahl, Zuordnung Repo → Projekt. Routen: /api/v1/projektkatalog/*. Der Katalog wird nur gelesen.
import {
  KATALOG_HINDERUNG_TEXT,
  KATALOG_TEXT_KODIERUNG,
  KATALOG_TRENNZEICHEN_STANDARD,
  katalogEinstellungSchema,
  katalogImportErgebnisSchema,
  type KatalogEinstellung,
  type KatalogEinstellungEingabe,
  type KatalogImportErgebnis,
  type KatalogStufe,
  type KatalogTrennzeichen,
} from '@seatmeter/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiFehler, useApi } from '../../api/client';
import { datumZeit, zahl } from '../../format';
import { Abschnitt, Seitenkopf, Tabelle, Werte } from '../../komponenten/Bausteine';
import { Auswahl, Eingabe, Kontrollkaestchen } from '../../komponenten/Formular';
import { KNOPF_DUNKEL } from '../../komponenten/knoepfe';
import { speicherFehler, ZugriffAbfrage } from '../../komponenten/Zugriff';
import {
  EINSTELLUNG_SCHLUESSEL,
  PROJEKTE_SCHLUESSEL,
  useKatalogAlleProjekte,
  useKatalogEinstellung,
} from './abfragen';
import { ImportTokens } from './ImportTokens';
import { Zuordnung } from './Zuordnung';

export const TEXT_KATALOG =
  'Der Projektkatalog enthält die Projekte aus Ihrem Projektmanagement-Werkzeug, auch verschachtelte. Jedes Repo wird einem ' +
  'Projekt zugeordnet; die Zuordnung gilt rückwirkend, abgeschlossene Monate bleiben unverändert. ' +
  'seatmeter liest die Projekte nur und schreibt nichts zurück.';

export const TEXT_CSV =
  'Für den Erstbestand und Läufe von Hand; im Regelfall sendet das Quellsystem die Projekte selbst. CSV in UTF-8 mit ' +
  'Kopfzeile, Pflicht sind eine ID oder Nummer und der Name, andere Spalten zählen nicht. Bekannte IDs werden ' +
  'aktualisiert. Eine ungültige Zeile wird abgelehnt, ihr Projekt bleibt unverändert. Eine vollständige Liste macht ' +
  'alle Projekte inaktiv, die in der Datei fehlen, auch gesendete.';

export const TEXT_SPALTEN =
  'Namen aus der Kopfzeile eintragen. Dann zählen nur diese Spalten; ohne Zuordnung gelten die üblichen ' +
  'Spaltennamen wie ID, Nummer, Name, Kunde, Parent und Status.';

export const TEXT_BREMSE =
  'Der letzte Lauf hätte zu viele Projekte deaktiviert und hat angehalten. Vermutlich ist der Lauf im Quellsystem ' +
  'abgebrochen. Bitte prüfen; nach einem vollständigen Lauf löst sich das von selbst.';

export const TEXT_SYNC_VERALTET =
  'Die Synchronisation mit dem Quellsystem bleibt aus. Bitte den Lauf dort prüfen. Neue Projekte fehlen sonst in der Auswahl.';

export const TEXT_DEAKTIVIERUNG_UEBERSPRUNGEN =
  'Mindestens eine abgelehnte Zeile ließ sich keinem Projekt zuordnen. Darum wurde in diesem Lauf nichts deaktiviert.';

export const TEXT_STUFEN =
  'Ein verwalteter Hook prüft in Repos ohne Projekt vor dem Prompt. Erst „Warnen“, später „Blockieren“: Beim Warnen ' +
  'läuft alles weiter, und Sie sehen, ob alle die Auswahlseite erreichen. Die erste Wahl gilt für das Repo, Ordner ohne ' +
  'Repo fragen je Sitzung. Ist seatmeter nicht erreichbar oder der Katalog leer, läuft Claude Code normal weiter. Den ' +
  'Hook erzeugt die Seite „Ausrollen“.';

export const TEXT_NICHT_ERREICHBAR =
  'Es gibt noch keine Konten mit der Rolle „entwickler“ und keine Gruppenzuordnung dafür. Wer kein Konto hat, kommt ' +
  'nicht auf die Auswahlseite und bliebe beim Blockieren stehen. Bitte zuerst unter SSO und Konten die Rolle vergeben.';

const TRENNZEICHEN_OPTIONEN = [
  [';', 'Semikolon ( ; )'],
  [',', 'Komma ( , )'],
  ['\t', 'Tabulator'],
  ['|', 'Senkrechter Strich ( | )'],
] as const;

function ergebnisText(e: KatalogImportErgebnis): string {
  return (
    `${zahl(e.neu)} neu, ${zahl(e.aktualisiert)} aktualisiert, ${zahl(e.unveraendert)} unverändert, ` +
    `${zahl(e.deaktiviert)} deaktiviert, ${zahl(e.abgelehnt)} abgelehnt; ` +
    `${zahl(e.aktiv_gesamt)} aktive Projekte.`
  );
}

function Ergebnis({ e }: { e: KatalogImportErgebnis }) {
  return (
    <div role="status" className="space-y-1 text-sm text-slate-800">
      <p className={e.abgelehnt > 0 ? 'text-orange-800' : 'text-green-800'}>
        {e.trockenlauf ? `Nur geprüft, nichts gespeichert: ${ergebnisText(e)}` : ergebnisText(e)}
      </p>
      {e.deaktivierung_uebersprungen && (
        <p className="text-orange-800">{TEXT_DEAKTIVIERUNG_UEBERSPRUNGEN}</p>
      )}
      {e.abgelehnte_zeilen.length + e.hinweise.length > 0 && (
        <ul className="list-disc pl-5">
          {[...e.abgelehnte_zeilen, ...e.hinweise].map((z) => (
            <li key={z}>{z}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Import() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [dateiname, setDateiname] = useState<string | null>(null);
  const [vollstaendig, setVollstaendig] = useState(true);
  const [nurPruefen, setNurPruefen] = useState(false);
  const [trennzeichen, setTrennzeichen] = useState<KatalogTrennzeichen>(
    KATALOG_TRENNZEICHEN_STANDARD,
  );
  const [spalteId, setSpalteId] = useState('');
  const [spalteName, setSpalteName] = useState('');
  const [spalteNummer, setSpalteNummer] = useState('');
  const [spalteKunde, setSpalteKunde] = useState('');
  const [spalteAktiv, setSpalteAktiv] = useState('');
  const [spalteParent, setSpalteParent] = useState('');
  const [meldung, setMeldung] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<KatalogImportErgebnis | null>(null);
  const zuordnungGesetzt = [
    spalteId,
    spalteName,
    spalteNummer,
    spalteKunde,
    spalteAktiv,
    spalteParent,
  ].some((w) => w.trim());
  const zuordnungVollstaendig = Boolean(spalteId.trim() && spalteName.trim());
  const importieren = useMutation({
    mutationFn: () =>
      api.post(
        '/api/v1/projektkatalog/import/csv',
        {
          csv,
          vollstaendig,
          trockenlauf: nurPruefen,
          trennzeichen,
          ...(zuordnungGesetzt
            ? {
                spalten: {
                  id: spalteId.trim(),
                  name: spalteName.trim(),
                  ...(spalteNummer.trim() ? { nummer: spalteNummer.trim() } : {}),
                  ...(spalteKunde.trim() ? { kunde: spalteKunde.trim() } : {}),
                  ...(spalteAktiv.trim() ? { aktiv: spalteAktiv.trim() } : {}),
                  ...(spalteParent.trim() ? { parent: spalteParent.trim() } : {}),
                },
              }
            : {}),
        },
        katalogImportErgebnisSchema,
      ),
    onSuccess: async (e) => {
      setErgebnis(e);
      // Nach dem Prüfen bleibt die Datei geladen, damit derselbe Import direkt folgen kann.
      if (e.trockenlauf) return;
      setCsv('');
      setDateiname(null);
      await queryClient.invalidateQueries({ queryKey: EINSTELLUNG_SCHLUESSEL });
      await queryClient.invalidateQueries({ queryKey: PROJEKTE_SCHLUESSEL });
    },
    onError: (f) => setMeldung(speicherFehler(f)),
  });
  return (
    <div className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-600">{TEXT_CSV}</p>
      <label className="block text-sm">
        <span className="block font-medium text-slate-700">CSV-Datei wählen</span>
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => {
            const d = e.target.files?.[0];
            setMeldung(null);
            setErgebnis(null);
            if (!d) return;
            setCsv('');
            setDateiname(null);
            // Streng dekodieren: `File.text()` machte aus Windows-1252 still Ersetzungszeichen.
            void d.arrayBuffer().then((b) => {
              try {
                setCsv(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(b)));
                setDateiname(d.name);
              } catch {
                setMeldung(KATALOG_TEXT_KODIERUNG);
              }
            });
          }}
          className="mt-1 block w-full text-sm"
        />
      </label>
      {dateiname && <p className="text-sm text-slate-700">Datei „{dateiname}“ geladen.</p>}
      <div className="max-w-xs">
        <Auswahl
          beschriftung="Trennzeichen"
          wert={trennzeichen}
          onAendern={(w) => setTrennzeichen(w as KatalogTrennzeichen)}
          optionen={TRENNZEICHEN_OPTIONEN}
        />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">
          Spalten zuordnen (optional)
        </summary>
        <p className="mt-1 text-slate-600">{TEXT_SPALTEN}</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Eingabe beschriftung="Spalte externe ID" wert={spalteId} onAendern={setSpalteId} />
          <Eingabe beschriftung="Spalte Name" wert={spalteName} onAendern={setSpalteName} />
          <Eingabe beschriftung="Spalte Nummer" wert={spalteNummer} onAendern={setSpalteNummer} />
          <Eingabe beschriftung="Spalte Kunde" wert={spalteKunde} onAendern={setSpalteKunde} />
          <Eingabe beschriftung="Spalte Aktiv" wert={spalteAktiv} onAendern={setSpalteAktiv} />
          <Eingabe beschriftung="Spalte Parent" wert={spalteParent} onAendern={setSpalteParent} />
        </div>
        {zuordnungGesetzt && !zuordnungVollstaendig && (
          <p role="alert" className="mt-1 text-red-800">
            Externe ID und Name sind Pflicht, wenn Spalten zugeordnet werden.
          </p>
        )}
      </details>
      <Kontrollkaestchen
        beschriftung="Vollständige Liste: fehlende Projekte werden inaktiv"
        wert={vollstaendig}
        onAendern={setVollstaendig}
      />
      <Kontrollkaestchen
        beschriftung="Nur prüfen, nichts speichern"
        wert={nurPruefen}
        onAendern={setNurPruefen}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={KNOPF_DUNKEL}
          disabled={!csv || importieren.isPending || (zuordnungGesetzt && !zuordnungVollstaendig)}
          onClick={() => {
            setMeldung(null);
            setErgebnis(null);
            importieren.mutate();
          }}
        >
          {nurPruefen ? 'Prüfen' : 'Importieren'}
        </button>
        {meldung && (
          <span role="alert" className="text-sm text-red-800">
            {meldung}
          </span>
        )}
      </div>
      {ergebnis && <Ergebnis e={ergebnis} />}
    </div>
  );
}

const STUFEN = [
  ['aus', 'Aus'],
  ['warnen', 'Warnen: Der Prompt läuft weiter, Claude Code zeigt den Link'],
  ['blockieren', 'Blockieren: Der Prompt wartet, bis ein Projekt gewählt ist'],
] as const;

function Projektwahl({ e }: { e: KatalogEinstellung }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [kontakt, setKontakt] = useState(e.kontakt ?? '');
  const [meldung, setMeldung] = useState<string | null>(null);
  const setzen = useMutation({
    mutationFn: (eingabe: KatalogEinstellungEingabe) =>
      api.put('/api/v1/projektkatalog/einstellung', eingabe, katalogEinstellungSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EINSTELLUNG_SCHLUESSEL }),
    onError: (f) =>
      setMeldung(f instanceof ApiFehler && f.status === 409 ? f.message : speicherFehler(f)),
  });
  // Spricht die Konfiguration dagegen, lässt sich nur noch ausschalten.
  const optionen = e.hinderung ? STUFEN.filter(([w]) => w === 'aus' || w === e.stufe) : STUFEN;
  return (
    <div className="space-y-3 rounded border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-600">{TEXT_STUFEN}</p>
      {e.hinderung && (
        <p role="alert" className="text-sm text-red-800">
          {KATALOG_HINDERUNG_TEXT[e.hinderung]}
        </p>
      )}
      <div className="max-w-md">
        <Auswahl
          beschriftung="Stufe der Projektwahl"
          wert={e.stufe}
          onAendern={(w) => {
            setMeldung(null);
            setzen.mutate({ stufe: w as KatalogStufe });
          }}
          optionen={optionen}
        />
      </div>
      {e.stufe !== 'aus' && e.projekte_aktiv === 0 && (
        <p role="status" className="text-sm text-orange-800">
          Der Katalog ist leer: Solange keine Projekte importiert sind, tut der Hook nichts.
        </p>
      )}
      {!e.auswahl_erreichbar && (
        <p role="status" className="text-sm text-orange-800">
          {TEXT_NICHT_ERREICHBAR}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Eingabe
            beschriftung="Kontakt bei fehlendem Zugang (z. B. IT-Hotline)"
            wert={kontakt}
            onAendern={setKontakt}
          />
        </div>
        <button
          type="button"
          className={KNOPF_DUNKEL}
          disabled={setzen.isPending || kontakt.trim() === (e.kontakt ?? '')}
          onClick={() => {
            setMeldung(null);
            setzen.mutate({ stufe: e.stufe, kontakt: kontakt.trim() || null });
          }}
        >
          Kontakt speichern
        </button>
      </div>
      {meldung && (
        <p role="alert" className="text-sm text-red-800">
          {meldung}
        </p>
      )}
    </div>
  );
}

const zahlOderNull = (t: string): number | null | 'ungueltig' => {
  const w = t.trim();
  if (w === '') return null;
  const n = Number(w);
  return Number.isInteger(n) && n > 0 ? n : 'ungueltig';
};

/** Letzte Synchronisation, Zähler der letzten Tage, Warnung und ihre Einstellungen. */
function Synchronisation({ e }: { e: KatalogEinstellung }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [stunden, setStunden] = useState(e.sync.warnung_stunden?.toString() ?? '');
  const [tage, setTage] = useState(e.sync.deaktivieren_tage?.toString() ?? '');
  const [prozent, setProzent] = useState(String(e.sync.deaktivieren_max_prozent));
  const [liste, setListe] = useState(e.inaktiv_status.join(', '));
  const [meldung, setMeldung] = useState<string | null>(null);
  const speichern = useMutation({
    mutationFn: (eingabe: KatalogEinstellungEingabe) =>
      api.put('/api/v1/projektkatalog/einstellung', eingabe, katalogEinstellungSchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: EINSTELLUNG_SCHLUESSEL }),
    onError: (f) => setMeldung(speicherFehler(f)),
  });
  const summe = e.sync.tage.reduce(
    (s, t) => ({
      neu: s.neu + t.neu,
      aktualisiert: s.aktualisiert + t.aktualisiert,
      unveraendert: s.unveraendert + t.unveraendert,
      abgelehnt: s.abgelehnt + t.abgelehnt,
    }),
    { neu: 0, aktualisiert: 0, unveraendert: 0, abgelehnt: 0 },
  );
  return (
    <div className="space-y-3 rounded border border-slate-200 bg-white p-4">
      {e.sync.status === 'veraltet' && (
        <p role="alert" className="text-sm text-red-800">
          {TEXT_SYNC_VERALTET}
        </p>
      )}
      {e.sync.bremse_aktiv && (
        <p role="alert" className="text-sm text-red-800">
          {TEXT_BREMSE}
        </p>
      )}
      <Werte
        eintraege={[
          [
            'Letzte Synchronisation',
            e.sync.zuletzt_sync ? datumZeit(e.sync.zuletzt_sync) : 'noch keine',
          ],
          [
            'Letzte 7 Tage',
            `${zahl(summe.neu)} neu, ${zahl(summe.aktualisiert)} aktualisiert, ${zahl(summe.unveraendert)} unverändert, ${zahl(summe.abgelehnt)} abgelehnt`,
          ],
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Eingabe
          beschriftung="Warnen nach Stunden ohne Synchronisation (leer = aus)"
          wert={stunden}
          onAendern={setStunden}
        />
        <Eingabe
          beschriftung="Nicht mehr gesendete Projekte nach Tagen deaktivieren (leer = nie)"
          wert={tage}
          onAendern={setTage}
        />
        <Eingabe
          beschriftung="Höchstens so viel Prozent der aktiven Projekte je Lauf deaktivieren"
          wert={prozent}
          onAendern={setProzent}
        />
      </div>
      <Eingabe
        beschriftung="Status, die ein Projekt inaktiv machen (durch Komma getrennt)"
        wert={liste}
        onAendern={setListe}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={KNOPF_DUNKEL}
          disabled={speichern.isPending}
          onClick={() => {
            setMeldung(null);
            const s = zahlOderNull(stunden);
            const t = zahlOderNull(tage);
            const p = zahlOderNull(prozent);
            if (s === 'ungueltig' || t === 'ungueltig') {
              setMeldung('Stunden und Tage als ganze Zahl größer als 0 oder leer.');
              return;
            }
            if (p === 'ungueltig' || p === null || p > 100) {
              setMeldung('Prozent als ganze Zahl von 1 bis 100.');
              return;
            }
            speichern.mutate({
              sync_warnung_stunden: s,
              sync_deaktivieren_tage: t,
              sync_deaktivieren_max_prozent: p,
              inaktiv_status: liste
                .split(',')
                .map((w) => w.trim())
                .filter(Boolean),
            });
          }}
        >
          Synchronisation speichern
        </button>
        {meldung && (
          <span role="alert" className="text-sm text-red-800">
            {meldung}
          </span>
        )}
      </div>
    </div>
  );
}

const PROJEKTE_MAX_ZEILEN = 100;

/** Alle Projekte mit dem Status, wie ihn das Quellsystem sendet. */
function ProjekteUebersicht() {
  const abfrage = useKatalogAlleProjekte();
  const [filter, setFilter] = useState('');
  return (
    <ZugriffAbfrage
      abfrage={abfrage}
      istLeer={(d) => d.projekte.length === 0}
      leerText="Noch keine Projekte."
    >
      {(d) => {
        const f = filter.trim().toLowerCase();
        const treffer = d.projekte.filter((p) =>
          `${p.nummer} ${p.pfad} ${p.kunde ?? ''} ${p.status ?? ''}`.toLowerCase().includes(f),
        );
        return (
          <>
            <label className="mb-2 block max-w-md text-sm">
              <span className="block font-medium text-slate-700">Projekte filtern</span>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <p className="mb-1 text-xs text-slate-500">
              {zahl(treffer.length)} Projekte
              {treffer.length > PROJEKTE_MAX_ZEILEN
                ? `, die ersten ${PROJEKTE_MAX_ZEILEN} angezeigt`
                : ''}
            </p>
            <Tabelle
              beschriftung="Projekte im Katalog"
              zeilen={treffer.slice(0, PROJEKTE_MAX_ZEILEN)}
              schluessel={(p) => p.id}
              spalten={[
                { titel: 'Nummer', wert: (p) => p.nummer },
                { titel: 'Projekt', wert: (p) => p.pfad },
                { titel: 'Kunde', wert: (p) => p.kunde ?? '–' },
                { titel: 'Status', wert: (p) => p.status ?? '–' },
                { titel: 'Aktiv', wert: (p) => (p.aktiv ? 'ja' : 'nein') },
                { titel: 'Zuletzt gesehen', wert: (p) => datumZeit(p.zuletzt_gesehen) },
              ]}
            />
          </>
        );
      }}
    </ZugriffAbfrage>
  );
}

function Inhalt() {
  const einstellung = useKatalogEinstellung();
  return (
    <ZugriffAbfrage abfrage={einstellung}>
      {(e) => (
        <>
          <Abschnitt titel="Stand">
            <Werte
              eintraege={[
                ['Aktive Projekte', zahl(e.projekte_aktiv)],
                ['Projekte gesamt', zahl(e.projekte_gesamt)],
                ['Letzter Import', e.zuletzt_import ? datumZeit(e.zuletzt_import) : '–'],
                ['Quelle', e.import_quelle ?? '–'],
              ]}
            />
          </Abschnitt>
          <Abschnitt titel="Synchronisation">
            <Synchronisation e={e} />
          </Abschnitt>
          <ImportTokens />
          <Abschnitt titel="Projekte">
            <ProjekteUebersicht />
          </Abschnitt>
          <Abschnitt titel="CSV importieren">
            <Import />
          </Abschnitt>
          <Abschnitt titel="Projektwahl">
            <Projektwahl e={e} />
          </Abschnitt>
          <Abschnitt titel="Zuordnung">
            <Zuordnung />
          </Abschnitt>
        </>
      )}
    </ZugriffAbfrage>
  );
}

export function Projektkatalog() {
  return (
    <section>
      <Seitenkopf titel="Projektkatalog" />
      <p className="mt-2 text-sm text-slate-600">{TEXT_KATALOG}</p>
      <Inhalt />
    </section>
  );
}
