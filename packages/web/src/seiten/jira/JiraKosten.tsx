// Seite „Jira-Kosten“ (Auswertung): Kosten je Jira-Projekt im Monat, aufklappbar je Issue (Titel, Status,
// Sitzungen, Tokens, Schattenpreis), CSV-Export. Route: GET /api/v1/jira/kosten?monat=&format=.
// Mandanten-Admin, Controller und Projektleiter (eigene Projekte); Titel lädt der Server aus Jira nach.
import type { JiraKostenIssue, JiraKostenProjekt } from '@seatmeter/shared';
import { usdAusMikro, zahl } from '../../format';
import { MonatsWahl, Seitenkopf, type Spalte, Tabelle } from '../../komponenten/Bausteine';
import { KNOPF } from '../../komponenten/knoepfe';
import { useMonat } from '../../monat';
import { ZugriffAbfrage } from '../../komponenten/Zugriff';
import { jiraKostenCsvPfad, useJiraKosten } from './abfragen';

export const TEXT_KEINE_JIRA_KOSTEN =
  'Für diesen Monat liegen keine Issue-Schlüssel und keine zugeordneten Projekte vor.';

function issueTitel(i: JiraKostenIssue): string {
  if (i.gefunden === false) return 'in Jira nicht gefunden';
  return i.titel ?? 'Titel noch nicht geladen';
}

const ISSUE_SPALTEN: Spalte<JiraKostenIssue>[] = [
  { titel: 'Issue', wert: (i) => <code className="text-xs">{i.schluessel}</code> },
  { titel: 'Titel', wert: issueTitel },
  { titel: 'Status', wert: (i) => i.status ?? '–' },
  { titel: 'Sitzungen', wert: (i) => zahl(i.sitzungen), zahl: true },
  { titel: 'Tokens', wert: (i) => zahl(i.tokens.gesamt), zahl: true },
  { titel: 'Schattenpreis', wert: (i) => usdAusMikro(i.schatten_usd_micros), zahl: true },
];

function ProjektBlock({ p }: { p: JiraKostenProjekt }) {
  const projekte = p.seatmeter_projekte.map((s) => s.name).join(', ');
  return (
    <details className="mt-3 rounded border border-slate-200 bg-white p-3">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-semibold">
          {p.schluessel}
          {p.name ? ` – ${p.name}` : ''}
        </span>
        <span className="text-sm text-slate-600">
          {zahl(p.issues.length)} Issues · {zahl(p.tokens.gesamt)} Tokens
        </span>
        <span className="ml-auto font-medium">{usdAusMikro(p.schatten_usd_micros)}</span>
      </summary>
      <p className="mt-2 text-sm text-slate-600">
        seatmeter-Projekte: {projekte || 'keine Zuordnung (nur über den Schlüsselpräfix)'}
      </p>
      {p.issues.length > 0 && (
        <div className="mt-2">
          <Tabelle
            beschriftung={`Issues ${p.schluessel}`}
            zeilen={p.issues}
            schluessel={(i) => i.schluessel}
            spalten={ISSUE_SPALTEN}
          />
        </div>
      )}
      {p.ohne_issue.anfragen > 0 && (
        <p className="mt-2 text-sm text-slate-700">
          Ohne Issue-Schlüssel (zugeordnete Projekte): {zahl(p.ohne_issue.tokens.gesamt)} Tokens,{' '}
          {usdAusMikro(p.ohne_issue.schatten_usd_micros)}
        </p>
      )}
    </details>
  );
}

function JiraKostenInhalt() {
  const [monat] = useMonat();
  const abfrage = useJiraKosten(monat);
  return (
    <ZugriffAbfrage
      abfrage={abfrage}
      istLeer={(d) => d.jira_projekte.length === 0}
      leerText={TEXT_KEINE_JIRA_KOSTEN}
    >
      {(d) => (
        <>
          {(d.titel.fehler || d.titel.offen > 0) && (
            <p className="mt-2 text-sm text-slate-600">
              {d.titel.offen} Titel noch offen
              {d.titel.fehler ? ` (Jira: ${d.titel.fehler})` : ''}; sie werden beim nächsten Aufruf
              nachgeladen.
            </p>
          )}
          {d.jira_projekte.map((p) => (
            <ProjektBlock key={p.schluessel} p={p} />
          ))}
          <a href={jiraKostenCsvPfad(d.monat)} download className={`${KNOPF} mt-4 inline-block`}>
            Jira-Kosten als CSV herunterladen
          </a>
        </>
      )}
    </ZugriffAbfrage>
  );
}

export function JiraKosten() {
  return (
    <section>
      <Seitenkopf titel="Jira-Kosten">
        <MonatsWahl />
      </Seitenkopf>
      <JiraKostenInhalt />
    </section>
  );
}
