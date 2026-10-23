// Projektpreise eines Monats (Architektur §5): Schatten, Sitzanteil, Überschreitung und Projektpreis
// je Projekt in USD und EUR. Live aus GET /api/v1/kalkulation; ist der Monat abgeschlossen, zeigt die
// Seite zusätzlich den eingefrorenen Stand (GET /api/v1/monatsabschluss). Admins schließen Monate ab
// (POST /api/v1/jobs/kalkulation/monatsabschluss, mit Bestätigung; erzwingen überschreibt).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { berichtPfad, useKalkulation, useMonatsabschluss } from '../api/abfragen';
import { ApiFehler, istApiFehler, useApi } from '../api/client';
import {
  abschlussErgebnisSchema,
  type AbschlussErgebnis,
  type KalkulationAntwort,
  type ProjektpreisZeile,
} from '../api/typen';
import { useAuth } from '../auth/AuthTor';
import { Abfrage, Hinweis } from '../komponenten/Abfrage';
import {
  Abschnitt,
  MonatsWahl,
  Seitenkopf,
  Tabelle,
  Werte,
  type Spalte,
} from '../komponenten/Bausteine';
import { ausCent, datumZeit, dezimalzahl, prozent, usdAusMikro } from '../format';
import { aktuellerMonat, useMonat } from '../monat';
import { CACHE_ANNAHME_TEXT, kursText, verteilungText, zeilenName } from '../texte';

export const TEXT_KEINE_BERECHTIGUNG = 'Ihre Rolle sieht keine Projektpreise.';
export const TEXT_UEBERSCHREITUNG_NICHT_ABGEZOGEN =
  'Überschreitung nicht abgezogen: Es liegen keine Überschreitungsdaten vor. Nutzung über das Sitzkontingent hinaus steckt deshalb im Schattenpreis.';

const SPALTEN: Spalte<ProjektpreisZeile>[] = [
  {
    titel: 'Projekt',
    wert: (z) =>
      z.topf === 'projekt' ? (
        z.name
      ) : (
        <span className="italic text-slate-700">{zeilenName(z)}</span>
      ),
  },
  { titel: 'Kunde', wert: (z) => z.kunde ?? '' },
  { titel: 'Schattenpreis', wert: (z) => usdAusMikro(z.schatten_usd_micros), zahl: true },
  { titel: 'Sitzanteil', wert: (z) => usdAusMikro(z.sitzanteil_usd_micros), zahl: true },
  { titel: 'Überschreitung', wert: (z) => usdAusMikro(z.ueberschreitung_usd_micros), zahl: true },
  { titel: 'Projektpreis USD', wert: (z) => ausCent(z.projektpreis_usd_cent, 'USD'), zahl: true },
  { titel: 'Projektpreis EUR', wert: (z) => ausCent(z.projektpreis_eur_cent, 'EUR'), zahl: true },
];

/** Summenzeile im Format einer Kalkulationszeile (für den Tabellenfuß). */
function summenZeile(d: KalkulationAntwort): ProjektpreisZeile {
  const leer = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
  return {
    topf: 'projekt',
    projekt_id: null,
    name: 'Summe',
    kunde: null,
    tokens: { ...leer, web_search: 0, gesamt: 0 },
    anfragen: 0,
    preis_version: '',
    ...d.summe,
  };
}

const ABSCHLUSS_TEXT: Record<AbschlussErgebnis['status'], string> = {
  angelegt: 'Monat abgeschlossen',
  vorhanden: 'Der Monat war schon abgeschlossen; nichts geändert.',
  ueberschrieben: 'Monatsabschluss überschrieben',
};

function AbschlussKnopf({ monat, abgeschlossen }: { monat: string; abgeschlossen: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [bestaetigen, setBestaetigen] = useState(false);
  const abschluss = useMutation({
    mutationFn: () =>
      api.post(
        `/api/v1/jobs/kalkulation/monatsabschluss?monat=${encodeURIComponent(monat)}${
          abgeschlossen ? '&erzwingen=1' : ''
        }`,
        {},
        abschlussErgebnisSchema,
      ),
    onSuccess: async () => {
      setBestaetigen(false);
      await queryClient.invalidateQueries({ queryKey: ['monatsabschluss', monat] });
      await queryClient.invalidateQueries({ queryKey: ['kalkulation', monat] });
    },
  });
  const knopf =
    'rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {!bestaetigen ? (
        <button type="button" className={knopf} onClick={() => setBestaetigen(true)}>
          {abgeschlossen ? 'Neu abschließen (erzwingen)' : 'Monat abschließen'}
        </button>
      ) : (
        <>
          <span className="text-sm text-slate-700">
            {abgeschlossen
              ? 'Die eingefrorenen Werte werden mit dem heutigen Stand überschrieben (protokolliert).'
              : 'Die Werte des Monats werden eingefroren.'}
          </span>
          <button
            type="button"
            className={knopf}
            disabled={abschluss.isPending}
            onClick={() => abschluss.mutate()}
          >
            {abgeschlossen ? 'Ja, überschreiben' : 'Ja, abschließen'}
          </button>
          <button type="button" className={knopf} onClick={() => setBestaetigen(false)}>
            Abbrechen
          </button>
        </>
      )}
      {abschluss.isSuccess && (
        <span role="status" className="text-sm text-green-800">
          {ABSCHLUSS_TEXT[abschluss.data.status]}
          {abschluss.data.status === 'vorhanden' ? '' : ` (${abschluss.data.zeilen} Zeilen).`}
        </span>
      )}
      {abschluss.isError && (
        <span role="alert" className="text-sm text-red-800">
          {abschluss.error instanceof ApiFehler && abschluss.error.status === 403
            ? 'Dafür fehlt die Berechtigung.'
            : `Abschluss fehlgeschlagen: ${abschluss.error.message}`}
        </span>
      )}
    </div>
  );
}

function Abschlussstand({ monat }: { monat: string }) {
  const { darfVerwalten } = useAuth();
  const abfrage = useMonatsabschluss(monat);
  const vergangen = monat < aktuellerMonat();
  // Fehler (z. B. ältere Server ohne Route) zeigen nur „offen“; die Kalkulation bleibt nutzbar.
  const d = abfrage.data;
  return (
    <Abschnitt titel="Monatsabschluss">
      {abfrage.isPending ? (
        <p className="text-sm text-slate-600">Lade Abschlussstand …</p>
      ) : d?.abgeschlossen && d.abschluss ? (
        <p className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          Abgeschlossen am {datumZeit(d.abschluss.eingefroren_am)} – eingefrorener Projektpreis{' '}
          {ausCent(d.abschluss.summe.projektpreis_eur_cent, 'EUR')} (
          {ausCent(d.abschluss.summe.projektpreis_usd_cent, 'USD')}, Kurs{' '}
          {kursText(d.abschluss.kurs)}).
        </p>
      ) : (
        <p className="text-sm text-slate-600">
          {vergangen
            ? 'Der Monat ist noch nicht abgeschlossen; die Werte sind vorläufig.'
            : 'Laufender Monat: Die Werte sind vorläufig und werden am Monatsersten eingefroren.'}
        </p>
      )}
      {darfVerwalten && vergangen && !abfrage.isPending && (
        <AbschlussKnopf monat={monat} abgeschlossen={!!d?.abgeschlossen} />
      )}
    </Abschnitt>
  );
}

function Inhalt({ d }: { d: KalkulationAntwort }) {
  const e = d.einstellungen;
  return (
    <>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Werte
          eintraege={[
            ['Sitzkosten-Verteilung', verteilungText(e)],
            ['Code-Anteil am Sitz', prozent(e.code_anteil_sitz * 100)],
            ['Schattenfaktor', dezimalzahl(e.schatten_faktor)],
            ['Cache-Annahme', CACHE_ANNAHME_TEXT[e.cache_write_annahme] ?? e.cache_write_annahme],
          ]}
        />
        <Werte
          eintraege={[
            ['Kurs', kursText(d.kurs)],
            ['Sitzkosten im Monat', usdAusMikro(d.sitzkosten_usd_micros)],
            ['Projektpreise gesamt (USD)', ausCent(d.summe.projektpreis_usd_cent, 'USD')],
            ['Projektpreise gesamt (EUR)', ausCent(d.summe.projektpreis_eur_cent, 'EUR')],
          ]}
        />
      </div>
      {!d.ueberschreitung_abgezogen && (
        <p
          role="note"
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {TEXT_UEBERSCHREITUNG_NICHT_ABGEZOGEN}
        </p>
      )}
      {d.hinweise.length > 0 && (
        <ul className="mt-4 list-disc pl-5 text-sm text-slate-700">
          {d.hinweise.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      <Abschnitt titel="Je Projekt">
        {d.zeilen.length === 0 ? (
          <p className="text-slate-600">Für diesen Monat liegen keine Projektpreise vor.</p>
        ) : (
          <Tabelle
            beschriftung="Projektpreise je Projekt"
            spalten={SPALTEN}
            zeilen={d.zeilen}
            schluessel={(z) => `${z.topf}:${z.projekt_id ?? ''}`}
            summe={summenZeile(d)}
          />
        )}
        <p className="mt-2 text-xs text-slate-500">
          Projektpreis = Schattenfaktor × Schattenpreis + Sitzanteil + Überschreitung; erst auf
          US-Cent gerundet, dann mit dem Kurs in Euro umgerechnet.
        </p>
      </Abschnitt>
    </>
  );
}

export function Projektpreise() {
  const [monat] = useMonat();
  const abfrage = useKalkulation(monat);
  const verboten = istApiFehler(abfrage.error, 403);

  return (
    <section>
      <Seitenkopf titel="Projektpreise">
        <div className="flex flex-wrap items-center gap-3">
          {!verboten && (
            <a
              href={berichtPfad('projektabrechnung', monat, 'csv')}
              download
              className="rounded border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100"
            >
              CSV herunterladen
            </a>
          )}
          <MonatsWahl />
        </div>
      </Seitenkopf>
      {verboten ? (
        <Hinweis>{TEXT_KEINE_BERECHTIGUNG}</Hinweis>
      ) : (
        <>
          <Abfrage abfrage={abfrage}>{(d) => <Inhalt d={d} />}</Abfrage>
          {abfrage.isSuccess && <Abschlussstand monat={monat} />}
        </>
      )}
    </section>
  );
}
