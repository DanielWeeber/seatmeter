// Seite „Projektkosten“ (Auswertung): Katalog als aufklappbarer Baum mit eigenen Kosten und der Summe mit Unterprojekten je
// Projekt, darunter Repos und Sitzungen ohne Repo, CSV-Export und Repos ohne Zuordnung. Route: GET /api/v1/projektkatalog/kosten.
// Mandanten-Admin, Controller und Projektleitung (eigene Repos). Mandanten-Admin und Projektleitung korrigieren hier auch
// die Zuordnung. Kinder und Repo-Tabellen entstehen erst beim Aufklappen, damit tausende Projekte die Seite nicht bremsen.
import {
  kennzahlenMitWerten,
  type KatalogKostenProjekt,
  type KatalogKostenRepo,
} from '@seatmeter/shared';
import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthTor';
import { usdAusMikro, zahl } from '../../format';
import {
  Abschnitt,
  MonatsWahl,
  Seitenkopf,
  Tabelle,
  type Spalte,
} from '../../komponenten/Bausteine';
import { KNOPF, KNOPF_KLEIN } from '../../komponenten/knoepfe';
import { ZugriffAbfrage } from '../../komponenten/Zugriff';
import { useMonat } from '../../monat';
import { katalogKostenCsvPfad, useKatalogKosten } from './abfragen';
import { Zuordnung } from './Zuordnung';

export const TEXT_KEINE_KOSTEN = 'Für diesen Monat liegen keine Daten zu Projekten vor.';
export const TEXT_GESAMT = 'Gesamt im Monat, mit Repos und Sitzungen ohne Projekt';
/** Eine auf eigene Projekte beschränkte Sicht sieht nicht das Gesamt der Firma. */
export const TEXT_SUMME_EIGENE = 'Summe Ihrer Projekte';

const REPO_SPALTEN: Spalte<KatalogKostenRepo>[] = [
  { titel: 'Repo', wert: (r) => r.name },
  { titel: 'Anfragen', wert: (r) => zahl(r.anfragen), zahl: true },
  { titel: 'Tokens', wert: (r) => zahl(r.tokens.gesamt), zahl: true },
  { titel: 'Schattenpreis', wert: (r) => usdAusMikro(r.schatten_usd_micros), zahl: true },
];

type KinderJe = ReadonlyMap<string | null, readonly KatalogKostenProjekt[]>;

/** So viele Projekte je Ebene auf einmal: Tausende Blöcke auf einer Seite bremsen und liest niemand. Die Summen stimmen trotzdem. */
export const KOSTEN_SCHRITT = 200;

function KnotenListe({
  projekte,
  kinder,
}: {
  projekte: readonly KatalogKostenProjekt[];
  kinder: KinderJe;
}) {
  const [anzahl, setAnzahl] = useState(KOSTEN_SCHRITT);
  return (
    <>
      {projekte.slice(0, anzahl).map((p) => (
        <ProjektKnoten key={p.externe_id} p={p} kinder={kinder} />
      ))}
      {projekte.length > anzahl && (
        <button
          type="button"
          className={`${KNOPF_KLEIN} mt-2`}
          onClick={() => setAnzahl(anzahl + KOSTEN_SCHRITT)}
        >
          Weitere Projekte anzeigen ({zahl(anzahl)} von {zahl(projekte.length)})
        </button>
      )}
    </>
  );
}

function ProjektKnoten({ p, kinder }: { p: KatalogKostenProjekt; kinder: KinderJe }) {
  const [offen, setOffen] = useState(false);
  const unter = kinder.get(p.externe_id) ?? [];
  return (
    <div
      className={
        p.tiefe === 0
          ? 'mt-3 rounded border border-slate-200 bg-white p-3'
          : 'mt-2 border-l-2 border-slate-200 pl-3'
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <button
          type="button"
          aria-expanded={offen}
          onClick={() => setOffen(!offen)}
          className="cursor-pointer text-left font-semibold"
        >
          <span aria-hidden="true">{offen ? '▾ ' : '▸ '}</span>
          {p.nummer} – {p.tiefe === 0 ? p.pfad : p.name}
        </button>
        {p.kunde && <span className="text-sm text-slate-600">{p.kunde}</span>}
        <span className="text-sm text-slate-600">
          {zahl(p.repos.length)} Repos · {zahl(p.tokens.gesamt)} Tokens
        </span>
        <span className="ml-auto flex flex-wrap items-baseline gap-x-4">
          <span className="text-sm text-slate-700">
            Eigene Kosten <span className="font-medium">{usdAusMikro(p.schatten_usd_micros)}</span>
          </span>
          {unter.length > 0 && (
            <span className="text-sm text-slate-700">
              Mit Unterprojekten{' '}
              <span className="font-medium">{usdAusMikro(p.summe.schatten_usd_micros)}</span>
            </span>
          )}
        </span>
      </div>
      {offen && (
        <>
          {p.repos.length > 0 && (
            <div className="mt-2">
              <Tabelle
                beschriftung={`Repos von ${p.nummer}`}
                zeilen={p.repos}
                schluessel={(r) => r.id ?? r.name}
                spalten={REPO_SPALTEN}
              />
            </div>
          )}
          {p.sitzungen_ohne_repo > 0 && (
            <p className="mt-2 text-sm text-slate-700">
              Ohne Repo: {zahl(p.sitzungen_ohne_repo)} Sitzungen, {zahl(p.ohne_repo.tokens.gesamt)}{' '}
              Tokens, {usdAusMikro(p.ohne_repo.schatten_usd_micros)}
            </p>
          )}
          <KnotenListe projekte={unter} kinder={kinder} />
        </>
      )}
    </div>
  );
}

export function KostenBaum({ projekte }: { projekte: readonly KatalogKostenProjekt[] }) {
  const kinder = useMemo(() => {
    const je = new Map<string | null, KatalogKostenProjekt[]>();
    for (const p of projekte) {
      const liste = je.get(p.eltern_externe_id);
      if (liste) liste.push(p);
      else je.set(p.eltern_externe_id, [p]);
    }
    return je;
  }, [projekte]);
  return <KnotenListe projekte={kinder.get(null) ?? []} kinder={kinder} />;
}

function Inhalt() {
  const [monat] = useMonat();
  const abfrage = useKatalogKosten(monat);
  return (
    <ZugriffAbfrage
      abfrage={abfrage}
      istLeer={(d) =>
        d.projekte.length === 0 &&
        d.offen.repos.length === 0 &&
        !kennzahlenMitWerten(d.offen.ohne_repo)
      }
      leerText={TEXT_KEINE_KOSTEN}
    >
      {(d) => (
        <>
          {d.quelle === 'monatsabschluss' && (
            <p className="mt-2 text-sm text-slate-600">
              Monat abgeschlossen: Stand beim Abschluss, spätere Zuordnungen ändern ihn nicht.
            </p>
          )}
          <p className="mt-2 text-sm text-slate-800">
            {d.eingeschraenkt ? TEXT_SUMME_EIGENE : TEXT_GESAMT}:{' '}
            <span className="font-semibold">{usdAusMikro(d.gesamt.schatten_usd_micros)}</span>,{' '}
            {zahl(d.gesamt.tokens.gesamt)} Tokens
          </p>
          <KostenBaum projekte={d.projekte} />
          {(d.offen.repos.length > 0 || kennzahlenMitWerten(d.offen.ohne_repo)) && (
            <Abschnitt titel="Ohne Projekt">
              {d.offen.repos.length > 0 && (
                <Tabelle
                  beschriftung="Repos ohne Projekt"
                  zeilen={d.offen.repos}
                  schluessel={(r) => r.id ?? r.name}
                  spalten={REPO_SPALTEN}
                />
              )}
              {kennzahlenMitWerten(d.offen.ohne_repo) && (
                <p className="mt-2 text-sm text-slate-700">
                  Sitzungen ohne Repo und ohne Wahl: {zahl(d.offen.ohne_repo.tokens.gesamt)} Tokens,{' '}
                  {usdAusMikro(d.offen.ohne_repo.schatten_usd_micros)}
                </p>
              )}
            </Abschnitt>
          )}
          <a href={katalogKostenCsvPfad(d.monat)} download className={`${KNOPF} mt-4 inline-block`}>
            Projektkosten als CSV herunterladen
          </a>
        </>
      )}
    </ZugriffAbfrage>
  );
}

export function ProjektKosten() {
  const { me } = useAuth();
  const rollen = me?.rollen ?? [];
  const darfZuordnen =
    me === null || rollen.includes('mandanten_admin') || rollen.includes('projektleiter');
  return (
    <section>
      <Seitenkopf titel="Projektkosten">
        <MonatsWahl />
      </Seitenkopf>
      <Inhalt />
      {darfZuordnen && (
        <Abschnitt titel="Zuordnung Repo zu Projekt">
          <Zuordnung />
        </Abschnitt>
      )}
    </section>
  );
}
