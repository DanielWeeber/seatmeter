// Seite „Projektkosten“ (Auswertung): Kosten je Katalog-Projekt im Monat, aufklappbar je Repo, CSV-Export und
// Repos ohne Zuordnung. Route: GET /api/v1/projektkatalog/kosten. Mandanten-Admin, Controller und Projektleitung
// (eigene Repos). Mandanten-Admin und Projektleitung korrigieren hier auch die Zuordnung.
import type { KatalogKostenProjekt, KatalogKostenRepo } from '@seatmeter/shared';
import { useAuth } from '../../auth/AuthTor';
import { usdAusMikro, zahl } from '../../format';
import {
  Abschnitt,
  MonatsWahl,
  Seitenkopf,
  Tabelle,
  type Spalte,
} from '../../komponenten/Bausteine';
import { KNOPF } from '../../komponenten/knoepfe';
import { ZugriffAbfrage } from '../../komponenten/Zugriff';
import { useMonat } from '../../monat';
import { katalogKostenCsvPfad, useKatalogKosten } from './abfragen';
import { Zuordnung } from './Zuordnung';

export const TEXT_KEINE_KOSTEN = 'Für diesen Monat liegen keine Daten zu Projekten vor.';

const REPO_SPALTEN: Spalte<KatalogKostenRepo>[] = [
  { titel: 'Repo', wert: (r) => r.name },
  { titel: 'Anfragen', wert: (r) => zahl(r.anfragen), zahl: true },
  { titel: 'Tokens', wert: (r) => zahl(r.tokens.gesamt), zahl: true },
  { titel: 'Schattenpreis', wert: (r) => usdAusMikro(r.schatten_usd_micros), zahl: true },
];

function ProjektBlock({ p }: { p: KatalogKostenProjekt }) {
  return (
    <details className="mt-3 rounded border border-slate-200 bg-white p-3">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-semibold">
          {p.nummer} – {p.pfad}
        </span>
        {p.kunde && <span className="text-sm text-slate-600">{p.kunde}</span>}
        <span className="text-sm text-slate-600">
          {zahl(p.repos.length)} Repos · {zahl(p.tokens.gesamt)} Tokens
        </span>
        <span className="ml-auto font-medium">{usdAusMikro(p.schatten_usd_micros)}</span>
      </summary>
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
    </details>
  );
}

function Inhalt() {
  const [monat] = useMonat();
  const abfrage = useKatalogKosten(monat);
  return (
    <ZugriffAbfrage
      abfrage={abfrage}
      istLeer={(d) =>
        d.projekte.length === 0 && d.offen.repos.length === 0 && d.offen.ohne_repo.anfragen === 0
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
          {d.projekte.map((p) => (
            <ProjektBlock key={p.externe_id} p={p} />
          ))}
          {(d.offen.repos.length > 0 || d.offen.ohne_repo.anfragen > 0) && (
            <Abschnitt titel="Ohne Projekt">
              {d.offen.repos.length > 0 && (
                <Tabelle
                  beschriftung="Repos ohne Projekt"
                  zeilen={d.offen.repos}
                  schluessel={(r) => r.id ?? r.name}
                  spalten={REPO_SPALTEN}
                />
              )}
              {d.offen.ohne_repo.anfragen > 0 && (
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
