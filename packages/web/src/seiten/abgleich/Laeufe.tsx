// Läufe des Abgleichs: Tabelle mit Kennzahlen je Lauf, Tageswerte je Lauf ausklappbar, Ergebnis-Block.
import type { AbgleichLauf, AbgleichZusammenfassung } from '@seatmeter/shared';
import { datum, datumZeit, prozent, usdAusMikro, zahl } from '../../format';
import { Tabelle, Werte, type Spalte } from '../../komponenten/Bausteine';
import { useState } from 'react';
import { KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { ZugriffAbfrage } from '../../komponenten/Zugriff';
import { useAbgleichLaeufe } from './abfragen';
import { QUELLE_TEXT, STATUS_TEXT, zeitraumText } from './texte';

type Tag = AbgleichZusammenfassung['tage'][number];

const SPALTEN_TAGE: Spalte<Tag>[] = [
  { titel: 'Tag', wert: (t) => datum(t.tag) },
  { titel: 'Tokens laut Quelle', wert: (t) => zahl(t.tokens_quelle), zahl: true },
  { titel: 'Tokens in seatmeter', wert: (t) => zahl(t.tokens_seatmeter), zahl: true },
  { titel: 'Abweichung', wert: (t) => prozent(t.abweichung_prozent), zahl: true },
];

/** Ergebnis eines Laufs als Begriffsliste (nach „Jetzt abgleichen“ und „Importieren“). */
export function LaufErgebnis({ lauf }: { lauf: AbgleichLauf }) {
  const z = lauf.zusammenfassung;
  return (
    <div className="mt-3" role="status" aria-label="Ergebnis des Abgleichs">
      <Werte
        eintraege={[
          ['Quelle', QUELLE_TEXT[lauf.quelle]],
          ['Zeitraum', zeitraumText(lauf.von, lauf.bis)],
          ['Status', STATUS_TEXT[lauf.status]],
          ['Zeilen', zahl(lauf.zeilen)],
          ...(lauf.fehler ? ([['Fehler', lauf.fehler]] as [string, string][]) : []),
          ...(z
            ? ([
                ['Abdeckung', prozent(z.abdeckung_prozent)],
                ['Abweichend', zahl(z.abweichend)],
                ['Innerhalb der Schwelle', zahl(z.innerhalb)],
                ['Ohne Zuordnung', zahl(z.ohne_zuordnung)],
                ['Nur in seatmeter', zahl(z.nur_seatmeter)],
                ['Überschreitung', usdAusMikro(z.ueberschreitung_usd_micros)],
              ] as [string, string][])
            : []),
        ]}
      />
    </div>
  );
}

export function Laeufe() {
  const abfrage = useAbgleichLaeufe();
  const [offen, setOffen] = useState<string | null>(null);

  const spalten: Spalte<AbgleichLauf>[] = [
    { titel: 'Quelle', wert: (l) => QUELLE_TEXT[l.quelle] },
    {
      titel: 'Zeitraum',
      wert: (l) => (
        <>
          {zeitraumText(l.von, l.bis)}
          <span className="block text-xs text-slate-600">{datumZeit(l.gestartet)}</span>
        </>
      ),
    },
    {
      titel: 'Status',
      wert: (l) => (
        <>
          {STATUS_TEXT[l.status]}
          {l.fehler && <span className="block text-xs text-red-800">{l.fehler}</span>}
        </>
      ),
    },
    { titel: 'Zeilen', wert: (l) => zahl(l.zeilen), zahl: true },
    { titel: 'Abdeckung', wert: (l) => prozent(l.zusammenfassung?.abdeckung_prozent), zahl: true },
    { titel: 'Abweichend', wert: (l) => zahl(l.zusammenfassung?.abweichend), zahl: true },
    { titel: 'Innerhalb', wert: (l) => zahl(l.zusammenfassung?.innerhalb), zahl: true },
    { titel: 'Ohne Zuordnung', wert: (l) => zahl(l.zusammenfassung?.ohne_zuordnung), zahl: true },
    { titel: 'Nur seatmeter', wert: (l) => zahl(l.zusammenfassung?.nur_seatmeter), zahl: true },
    {
      titel: 'Überschreitung',
      wert: (l) => usdAusMikro(l.zusammenfassung?.ueberschreitung_usd_micros),
      zahl: true,
    },
    {
      titel: 'Tage',
      wert: (l) =>
        l.zusammenfassung && l.zusammenfassung.tage.length > 0 ? (
          <button
            type="button"
            className={KNOPF_KLEIN}
            aria-expanded={offen === l.id}
            onClick={() => setOffen(offen === l.id ? null : l.id)}
          >
            {offen === l.id ? 'Tage ausblenden' : 'Tage anzeigen'}
          </button>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <ZugriffAbfrage
      abfrage={abfrage}
      istLeer={(d) => d.laeufe.length === 0}
      leerText="Noch kein Abgleich gelaufen."
    >
      {(d) => {
        const aufgeklappt = d.laeufe.find((l) => l.id === offen);
        return (
          <>
            <Tabelle
              beschriftung="Läufe des Abgleichs"
              spalten={spalten}
              zeilen={d.laeufe}
              schluessel={(l) => l.id}
            />
            {aufgeklappt?.zusammenfassung && (
              <div className="mt-4">
                <h3 className="mb-2 font-semibold">
                  Tage des Laufs {zeitraumText(aufgeklappt.von, aufgeklappt.bis)}
                </h3>
                <Tabelle
                  beschriftung="Tageswerte des Laufs"
                  spalten={SPALTEN_TAGE}
                  zeilen={aufgeklappt.zusammenfassung.tage}
                  schluessel={(t) => t.tag}
                />
              </div>
            )}
          </>
        );
      }}
    </ZugriffAbfrage>
  );
}
