// Team: Spend-Report-CSV prüfen und importieren. Ablauf: Datei oder Text → Vorschau (erkanntes
// Trennzeichen, Spaltenzuordnung zum Korrigieren, Beispielzeilen mit maskierten E-Mails, Zähler,
// Fehler) → Importieren mit der korrigierten Zuordnung.
// Routen: POST /api/v1/abgleich/csv/vorschau und POST /api/v1/abgleich/csv.
import {
  CSV_BETRAG_EINHEITEN,
  CSV_FELDER,
  abgleichLaufSchema,
  csvVorschauSchema,
  type AbgleichLauf,
  type CsvFeld,
  type CsvVorschau,
} from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { geld, zahl, datum } from '../../format';
import { Tabelle, Werte, type Spalte } from '../../komponenten/Bausteine';
import { Auswahl } from '../../komponenten/Formular';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { KNOPF, KNOPF_DUNKEL } from '../../komponenten/knoepfe';
import { speicherFehler } from '../../komponenten/Zugriff';
import { LAEUFE_SCHLUESSEL, STATUS_SCHLUESSEL } from './abfragen';
import { LaufErgebnis } from './Laeufe';
import { CSV_FELD_TEXT, trennzeichenText } from './texte';

type Zuordnung = Record<CsvFeld, string | null>;
type Einheit = '' | (typeof CSV_BETRAG_EINHEITEN)[number];

const EINHEIT_TEXT: Record<(typeof CSV_BETRAG_EINHEITEN)[number], string> = {
  usd: 'US-Dollar mit Dezimalstellen',
  cent: 'US-Cent',
};

const zuordnungAus = (v: CsvVorschau): Zuordnung =>
  Object.fromEntries(CSV_FELDER.map((f) => [f, v.zuordnung[f] ?? null])) as Zuordnung;

/** Body für Vorschau und Import: derselbe, damit der Import genau das bestätigt, was man sah. */
function koerper(csv: string, zuordnung: Zuordnung | null, einheit: Einheit) {
  return {
    csv,
    ...(zuordnung ? { zuordnung } : {}),
    ...(einheit ? { betrag_einheit: einheit } : {}),
  };
}

function Beispiele({ zeilen }: { zeilen: Record<string, string>[] }) {
  const schluessel = [...new Set(zeilen.flatMap((z) => Object.keys(z)))];
  const spalten: Spalte<Record<string, string>>[] = schluessel.map((s) => ({
    titel: s,
    wert: (z) => z[s] ?? '',
  }));
  return (
    <Tabelle
      beschriftung="Beispielzeilen der CSV"
      spalten={spalten}
      zeilen={zeilen}
      schluessel={(_z, i) => String(i)}
    />
  );
}

export function CsvImport() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [csv, setCsv] = useState('');
  const [dateiname, setDateiname] = useState<string | null>(null);
  const [einheit, setEinheit] = useState<Einheit>('');
  const [zuordnung, setZuordnung] = useState<Zuordnung | null>(null);
  const [vorschau, setVorschau] = useState<CsvVorschau | null>(null);
  const [ergebnis, setErgebnis] = useState<AbgleichLauf | null>(null);

  const pruefen = useMutation({
    mutationFn: (b: ReturnType<typeof koerper>) =>
      api.post('/api/v1/abgleich/csv/vorschau', b, csvVorschauSchema),
  });
  const importieren = useMutation({
    mutationFn: (b: ReturnType<typeof koerper>) =>
      api.post('/api/v1/abgleich/csv', b, abgleichLaufSchema),
    onSuccess: async (lauf) => {
      setErgebnis(lauf);
      verwerfen();
      await queryClient.invalidateQueries({ queryKey: STATUS_SCHLUESSEL });
      await queryClient.invalidateQueries({ queryKey: LAEUFE_SCHLUESSEL });
    },
  });

  function verwerfen() {
    setCsv('');
    setDateiname(null);
    setZuordnung(null);
    setVorschau(null);
    pruefen.reset();
  }

  /** Holt die Vorschau; die erste Antwort liefert die erkannte Zuordnung zum Korrigieren. */
  const vorschauLaden = (z: Zuordnung | null, e: Einheit) =>
    pruefen.mutate(koerper(csv, z, e), {
      onSuccess: (v) => {
        setVorschau(v);
        setZuordnung(z ?? zuordnungAus(v));
      },
    });

  const neuerText = (text: string) => {
    setCsv(text);
    setZuordnung(null);
    setVorschau(null);
    setErgebnis(null);
  };

  const dateiGewaehlt = async (datei: File | undefined) => {
    if (!datei) return;
    neuerText(await datei.text());
    setDateiname(datei.name);
  };

  const zuordnenAendern = (feld: CsvFeld, spalte: string) => {
    if (!zuordnung) return;
    const neu = { ...zuordnung, [feld]: spalte === '' ? null : spalte };
    setZuordnung(neu);
    vorschauLaden(neu, einheit);
  };

  return (
    <div className="mt-4 rounded border border-slate-200 bg-white p-4">
      <h3 className="font-semibold">Spend-Report-CSV importieren</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="text-sm">
          <label className="block">
            <span className="block font-medium text-slate-700">CSV-Datei wählen</span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => void dateiGewaehlt(e.target.files?.[0])}
              className="mt-1 block w-full text-sm"
            />
          </label>
          {dateiname ? (
            <p className="mt-2 text-slate-700">
              Datei „{dateiname}“ geladen ({zahl(csv.length)} Zeichen).{' '}
              <button type="button" className="underline" onClick={verwerfen}>
                Verwerfen
              </button>
            </p>
          ) : (
            <label className="mt-3 block">
              <span className="block font-medium text-slate-700">oder CSV-Text einfügen</span>
              <textarea
                value={csv}
                onChange={(e) => neuerText(e.target.value)}
                rows={5}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs"
              />
            </label>
          )}
        </div>
        <div>
          <Auswahl
            beschriftung="Betragseinheit"
            wert={einheit}
            onAendern={(w) => {
              setEinheit(w as Einheit);
              if (vorschau) vorschauLaden(zuordnung, w as Einheit);
            }}
            optionen={[
              ['', 'Automatisch'],
              ...CSV_BETRAG_EINHEITEN.map((e) => [e, EINHEIT_TEXT[e]] as const),
            ]}
          />
          <button
            type="button"
            className={`mt-3 ${KNOPF}`}
            disabled={csv === '' || pruefen.isPending}
            onClick={() => vorschauLaden(zuordnung, einheit)}
          >
            {pruefen.isPending ? 'Prüfe …' : 'Vorschau'}
          </button>
        </div>
      </div>

      {pruefen.isError && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {speicherFehler(pruefen.error)}
        </p>
      )}

      {vorschau && zuordnung && (
        <div className="mt-4">
          <h4 className="mb-2 font-medium">Vorschau</h4>
          <Werte
            eintraege={[
              ['Trennzeichen', trennzeichenText(vorschau.trennzeichen)],
              ['Betragseinheit', EINHEIT_TEXT[vorschau.betrag_einheit]],
              ['Zeilen', zahl(vorschau.zeilen)],
              ['Gültig', zahl(vorschau.gueltig)],
              ['Einer Person zugeordnet', zahl(vorschau.zugeordnet)],
              ['Ohne Zuordnung', zahl(vorschau.ohne_zuordnung)],
              [
                'Zeitraum',
                vorschau.tage.von && vorschau.tage.bis
                  ? `${datum(vorschau.tage.von)} – ${datum(vorschau.tage.bis)}`
                  : '—',
              ],
              ['Summe', geld(vorschau.summe_usd, 'USD')],
            ]}
          />
          {vorschau.fehler.length > 0 && (
            <ul className="mt-3 list-disc rounded border border-amber-200 bg-amber-50 py-2 pl-7 pr-3 text-sm text-amber-900">
              {vorschau.fehler.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}

          <h4 className="mb-2 mt-4 font-medium">Spaltenzuordnung</h4>
          <p className="mb-2 text-xs text-slate-500">
            Die Zuordnung wurde erkannt; bei Abweichungen hier korrigieren, die Vorschau
            aktualisiert sich.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CSV_FELDER.map((feld) => (
              <Auswahl
                key={feld}
                beschriftung={CSV_FELD_TEXT[feld]}
                wert={zuordnung[feld] ?? ''}
                onAendern={(w) => zuordnenAendern(feld, w)}
                optionen={[
                  ['', '— nicht vorhanden —'],
                  ...vorschau.spalten.map((s) => [s, s] as const),
                ]}
              />
            ))}
          </div>

          {vorschau.beispiel.length > 0 && (
            <>
              <h4 className="mb-2 mt-4 font-medium">Beispielzeilen</h4>
              <Beispiele zeilen={vorschau.beispiel} />
              <p className="mt-1 text-xs text-slate-500">
                E-Mail-Adressen sind maskiert; sie dienen nur zur Kontrolle der Zuordnung.
              </p>
            </>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={KNOPF_DUNKEL}
              disabled={importieren.isPending || pruefen.isPending || vorschau.gueltig === 0}
              onClick={() => importieren.mutate(koerper(csv, zuordnung, einheit))}
            >
              {importieren.isPending ? 'Importiere …' : 'Importieren'}
            </button>
            <button type="button" className={KNOPF} onClick={verwerfen}>
              Verwerfen
            </button>
          </div>
        </div>
      )}

      {importieren.isError && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {speicherFehler(importieren.error)}
        </p>
      )}
      {ergebnis && <LaufErgebnis lauf={ergebnis} />}
    </div>
  );
}
