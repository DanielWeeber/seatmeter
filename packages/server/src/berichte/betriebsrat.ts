// Betriebsrats-Bericht (Architektur §7, §10.5): nur Zähler und Konfiguration, nie Daten einzelner
// Personen (unabhängig von der Auswertungsstufe) und keine Benutzernamen der Dashboard-Konten.
import { ROLLEN, type BetriebsratBericht, type Rolle } from '@seatmeter/shared';
import { sql, type Transaction } from 'kysely';
import { AUDIT_AKTION } from '../audit/protokoll.js';
import { MINDESTGRUPPE } from '../aggregation/routen.js';
import { monatsGrenzen, plusTage } from '../aggregation/tage.js';
import type { Datenbank } from '../db/schema.js';
import { csv, text } from './csv.js';

type Trx = Transaction<Datenbank>;

export const STUFEN_TEXT: Record<number, string> = {
  0: '0 – nur Projekte (keine Personensicht)',
  1: '1 – Pseudonym, Monatssummen, Mindestgruppe 3',
  2: '2 – Pseudonym, Tagesverlauf je Projekt',
  3: '3 – Klarnamen (nur nach Aktivierung durch den Mandanten-Admin)',
};

export const ZWECK =
  'Projektkalkulation und Kostensteuerung der Claude-Code-Nutzung über Abo-Sitze. Ausdrücklich keine ' +
  'Leistungs- oder Verhaltenskontrolle und keine automatisierten Entscheidungen über Beschäftigte.';

export const ERFASST = [
  'Token-Zähler je Anfrage (Input, Output, Cache lesen, Cache schreiben)',
  'Modell, Datum (Tag), Projekt (Git-Repo)',
  'Issue-Schlüssel aus dem Branch-Namen (z. B. ABC-123), nicht der Branch-Name',
  'Person nur als Pseudonym (HMAC mit Mandantensalt)',
  'Rechner-Bezeichnung und Agent-Version',
  'Zugriffs- und Änderungsprotokoll der Dashboard-Konten',
];

export const NICHT_ERFASST = [
  'Inhalte: Prompts, Antworten, Tool-Eingaben und -Ausgaben',
  'Dateinamen, Pfade, Befehle, Branch-Namen (nur der Issue-Schlüssel daraus)',
  'Uhrzeit-Profile oder Stundensichten je Person',
  'Klarnamen und E-Mail-Adressen (außer bei aktivierten Klarnamen)',
];

export const HINWEIS =
  'Einsatz nur auf Grundlage einer Betriebsvereinbarung bzw. Zustimmung des Betriebsrats ' +
  '(§ 87 Abs. 1 Nr. 6 BetrVG). Änderungen an Auswertungsstufe, Klarnamen oder Aufbewahrungsfristen ' +
  'erscheinen in diesem Bericht. Kein Rechtsrat.';

/** Konfigurationsänderungen, die im Bericht erscheinen (ohne personenbezogene Aktionen wie „Sitz geändert“). */
const KONFIG_AKTIONEN = [
  AUDIT_AKTION.einstellungGeaendert,
  AUDIT_AKTION.preisAngelegt,
  AUDIT_AKTION.preisGeaendert,
  AUDIT_AKTION.sitzkostenGeaendert,
  AUDIT_AKTION.kursGesetzt,
  AUDIT_AKTION.kursGeloescht,
  AUDIT_AKTION.monatsabschlussUeberschrieben,
];

const zahl = (w: unknown) => Number(w ?? 0);

export async function erstelleBetriebsratBericht(
  trx: Trx,
  monat: string,
  jetzt: Date = new Date(),
): Promise<BetriebsratBericht> {
  const { von, bisExklusiv } = monatsGrenzen(monat);
  const m = await trx.selectFrom('mandant').selectAll().executeTakeFirstOrThrow();
  const tz = m.zeitzone;
  // Zeitstempel (UTC) nach Kalendertag in der Mandanten-Zeitzone filtern.
  const imMonat = (spalte: string) =>
    sql<boolean>`(${sql.ref(spalte)} AT TIME ZONE ${tz})::date >= ${von}::date
      AND (${sql.ref(spalte)} AT TIME ZONE ${tz})::date < ${bisExklusiv}::date`;

  const statistik = await trx
    .selectFrom('ingest_statistik')
    .select([
      'quelle',
      sql<number>`sum(angenommen)::bigint`.as('angenommen'),
      sql<number>`sum(verworfen_inhalt)::bigint`.as('verworfen_inhalt'),
      sql<number>`sum(verworfen_api)::bigint`.as('verworfen_api'),
      sql<number>`sum(verworfen_fremd_org)::bigint`.as('verworfen_fremd_org'),
      sql<number>`sum(unzugeordnet)::bigint`.as('unzugeordnet'),
    ])
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .groupBy('quelle')
    .execute();
  const quelleAktiv = (q: 'a' | 'b' | 'c') =>
    statistik.some((s) => s.quelle === q && zahl(s.angenommen) > 0);
  const summeStatistik = (
    f: 'angenommen' | 'verworfen_inhalt' | 'verworfen_api' | 'verworfen_fremd_org' | 'unzugeordnet',
  ) => statistik.reduce((s, z) => s + zahl(z[f]), 0);

  const aenderungen = await trx
    .selectFrom('audit')
    .select(['ts', 'aktion', 'objekt'])
    .where('aktion', 'in', KONFIG_AKTIONEN)
    .where(imMonat('ts'))
    .orderBy('ts')
    .limit(500)
    .execute();

  const konten = await trx
    .selectFrom('rolle')
    .select(['rolle', sql<number>`count(DISTINCT benutzer_id)::int`.as('anzahl')])
    .groupBy('rolle')
    .execute();

  const protokoll = await trx
    .selectFrom('audit')
    .select(['aktion', sql<number>`count(*)::int`.as('anzahl')])
    .where(imMonat('ts'))
    .groupBy('aktion')
    .orderBy('aktion')
    .execute();
  const anzahlAktion = (pred: (a: string) => boolean) =>
    protokoll.filter((p) => pred(p.aktion)).reduce((s, p) => s + zahl(p.anzahl), 0);

  const mengen = await trx
    .selectFrom('tag_aggregat')
    .select([
      sql<number>`count(DISTINCT person_id)::int`.as('personen'),
      sql<number>`count(DISTINCT projekt_id)::int`.as('projekte'),
      sql<number>`coalesce(sum(anfragen), 0)::bigint`.as('anfragen'),
      sql<number>`coalesce(sum(input + output + cache_read + cache_write), 0)::bigint`.as('tokens'),
    ])
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .executeTakeFirstOrThrow();

  const rechner = await trx
    .selectFrom('rechner')
    .select([
      sql<number>`count(*) FILTER (WHERE widerrufen IS NULL)::int`.as('aktiv'),
      sql<
        string[]
      >`coalesce(array_agg(DISTINCT agent_version) FILTER (WHERE widerrufen IS NULL AND agent_version IS NOT NULL), '{}')`.as(
        'versionen',
      ),
    ])
    .executeTakeFirstOrThrow();

  const loeschlaeufe = await trx
    .selectFrom('loeschlauf')
    .select(['ts', 'tabelle', 'bis', 'anzahl'])
    .where(imMonat('ts'))
    .orderBy('ts')
    .limit(500)
    .execute();

  const rollenAnzahl = new Map(konten.map((k) => [k.rolle, zahl(k.anzahl)]));
  return {
    monat,
    zeitraum: { von, bis: plusTage(bisExklusiv, -1) },
    erstellt: jetzt.toISOString(),
    zweck: ZWECK,
    konfiguration: {
      auswertungsstufe: m.auswertungsstufe,
      auswertungsstufe_text: STUFEN_TEXT[m.auswertungsstufe] ?? String(m.auswertungsstufe),
      klarnamen_aktiv: m.klarnamen_aktiv,
      mindestgruppe: MINDESTGRUPPE,
      aufbewahrung: {
        anfrage_tage: m.aufbewahrung_anfrage_tage,
        aggregat_monate: m.aufbewahrung_aggregat_monate,
        abschluss_monate: m.aufbewahrung_abschluss_monate,
        kontrollsumme_tage: m.aufbewahrung_kontrollsumme_tage,
        statistik_monate: m.aufbewahrung_statistik_monate,
        audit_monate: m.aufbewahrung_audit_monate,
      },
      quellen: { a: quelleAktiv('a'), b: quelleAktiv('b'), c: quelleAktiv('c') },
      aenderungen: aenderungen.map((a) => ({
        ts: new Date(a.ts).toISOString(),
        aktion: a.aktion,
        objekt: a.objekt,
      })),
    },
    datenkategorien: { erfasst: ERFASST, nicht_erfasst: NICHT_ERFASST },
    zugriffe: {
      konten: (ROLLEN as readonly Rolle[]).map((rolle) => ({
        rolle,
        anzahl: rollenAnzahl.get(rolle) ?? 0,
      })),
      personensichten: anzahlAktion((a) => a === AUDIT_AKTION.personensicht),
      exporte: anzahlAktion((a) => a.startsWith(AUDIT_AKTION.export)),
      ansichten: anzahlAktion((a) => a.startsWith(AUDIT_AKTION.ansicht)),
      protokoll: protokoll.map((p) => ({ aktion: p.aktion, anzahl: zahl(p.anzahl) })),
    },
    mengen: {
      personen: zahl(mengen.personen),
      rechner: zahl(rechner.aktiv),
      projekte: zahl(mengen.projekte),
      anfragen: zahl(mengen.anfragen),
      tokens: zahl(mengen.tokens),
    },
    datenschutz: {
      angenommen: summeStatistik('angenommen'),
      verworfen_inhalt: summeStatistik('verworfen_inhalt'),
      verworfen_api: summeStatistik('verworfen_api'),
      verworfen_fremd_org: summeStatistik('verworfen_fremd_org'),
      unzugeordnet: summeStatistik('unzugeordnet'),
      loeschlaeufe: loeschlaeufe.map((l) => ({
        ts: new Date(l.ts).toISOString(),
        tabelle: l.tabelle,
        bis: l.bis,
        anzahl: zahl(l.anzahl),
      })),
    },
    version: {
      seatmeter: process.env.SEATMETER_VERSION || 'unbekannt',
      agenten: [...(rechner.versionen ?? [])].sort(),
    },
    hinweis: HINWEIS,
  };
}

const ROLLEN_TEXT: Record<Rolle, string> = {
  mandanten_admin: 'Mandanten-Admin',
  projektleiter: 'Projektleitung',
  controller: 'Controller/Leser',
  betriebsrat: 'Betriebsrat',
  entwickler: 'Entwicklung (nur Projektwahl)',
};

const janein = (w: boolean) => (w ? 'ja' : 'nein');

/** Zeilen (Abschnitt, Kennzahl, Wert) für CSV und HTML. */
function zeilen(b: BetriebsratBericht): [string, string, string][] {
  const k = b.konfiguration;
  const z: [string, string, string][] = [
    ['Zeitraum', 'Monat', b.monat],
    ['Zeitraum', 'von', b.zeitraum.von],
    ['Zeitraum', 'bis', b.zeitraum.bis],
    ['Zeitraum', 'erstellt', b.erstellt],
    ['Zweck', 'Zweck', b.zweck],
    ['Konfiguration', 'Auswertungsstufe', k.auswertungsstufe_text],
    ['Konfiguration', 'Klarnamen aktiv', janein(k.klarnamen_aktiv)],
    ['Konfiguration', 'Mindestgruppe je Ausweis', String(k.mindestgruppe)],
    ['Konfiguration', 'Aufbewahrung Einzelanfragen (Tage)', String(k.aufbewahrung.anfrage_tage)],
    [
      'Konfiguration',
      'Aufbewahrung Tagesaggregat mit Person (Monate)',
      String(k.aufbewahrung.aggregat_monate),
    ],
    [
      'Konfiguration',
      'Aufbewahrung Monatsabschluss (Monate)',
      String(k.aufbewahrung.abschluss_monate),
    ],
    [
      'Konfiguration',
      'Aufbewahrung Kontrollsummen (Tage)',
      String(k.aufbewahrung.kontrollsumme_tage),
    ],
    [
      'Konfiguration',
      'Aufbewahrung Ingest-Statistik (Monate)',
      String(k.aufbewahrung.statistik_monate),
    ],
    [
      'Konfiguration',
      'Aufbewahrung Zugriffsprotokoll (Monate)',
      String(k.aufbewahrung.audit_monate),
    ],
    ['Konfiguration', 'Quelle A (OpenTelemetry) aktiv', janein(k.quellen.a)],
    ['Konfiguration', 'Quelle B (Agent) aktiv', janein(k.quellen.b)],
    ['Konfiguration', 'Quelle C (Abgleich) aktiv', janein(k.quellen.c)],
    ...k.aenderungen.map((a): [string, string, string] => [
      'Änderung',
      `${a.ts} ${a.aktion}`,
      a.objekt ?? '',
    ]),
    ...b.datenkategorien.erfasst.map((t): [string, string, string] => [
      'Datenkategorien',
      'erfasst',
      t,
    ]),
    ...b.datenkategorien.nicht_erfasst.map((t): [string, string, string] => [
      'Datenkategorien',
      'nicht erfasst',
      t,
    ]),
    ...b.zugriffe.konten.map((r): [string, string, string] => [
      'Zugriffe',
      `Konten mit Rolle ${ROLLEN_TEXT[r.rolle]}`,
      String(r.anzahl),
    ]),
    ['Zugriffe', 'Personensichten geöffnet', String(b.zugriffe.personensichten)],
    ['Zugriffe', 'Exporte', String(b.zugriffe.exporte)],
    ['Zugriffe', 'Berichtsansichten', String(b.zugriffe.ansichten)],
    ...b.zugriffe.protokoll.map((p): [string, string, string] => [
      'Zugriffsprotokoll',
      p.aktion,
      String(p.anzahl),
    ]),
    ['Mengen', 'Gezählte Personen (Pseudonyme)', String(b.mengen.personen)],
    ['Mengen', 'Registrierte Rechner', String(b.mengen.rechner)],
    ['Mengen', 'Projekte', String(b.mengen.projekte)],
    ['Mengen', 'Anfragen', String(b.mengen.anfragen)],
    ['Mengen', 'Tokens', String(b.mengen.tokens)],
    ['Datenschutz', 'Angenommene Anfragen', String(b.datenschutz.angenommen)],
    ['Datenschutz', 'Verworfene Ereignisse mit Inhalten', String(b.datenschutz.verworfen_inhalt)],
    ['Datenschutz', 'Gefilterte API-Anfragen', String(b.datenschutz.verworfen_api)],
    [
      'Datenschutz',
      'Gefilterte Anfragen fremder Organisationen',
      String(b.datenschutz.verworfen_fremd_org),
    ],
    ['Datenschutz', 'Unzugeordnete Anfragen', String(b.datenschutz.unzugeordnet)],
    ...b.datenschutz.loeschlaeufe.map((l): [string, string, string] => [
      'Löschlauf',
      `${l.ts} ${l.tabelle} bis ${l.bis}`,
      String(l.anzahl),
    ]),
    ['Version', 'seatmeter', b.version.seatmeter],
    ['Version', 'Agenten', b.version.agenten.join(', ') || '–'],
    ['Hinweis', 'Betriebsvereinbarung', b.hinweis],
  ];
  return z;
}

export function betriebsratCsv(b: BetriebsratBericht): string {
  return csv([
    ['Abschnitt', 'Kennzahl', 'Wert'],
    ...zeilen(b).map(([a, k, w]) => [text(a), text(k), text(w)]),
  ]);
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export function betriebsratHtml(b: BetriebsratBericht): string {
  const abschnitte = new Map<string, [string, string][]>();
  for (const [a, k, w] of zeilen(b)) {
    const liste = abschnitte.get(a) ?? [];
    liste.push([k, w]);
    abschnitte.set(a, liste);
  }
  const teile = [...abschnitte].map(
    ([titel, liste]) =>
      `<h2>${esc(titel)}</h2>\n<table>${liste
        .map(([k, w]) => `<tr><th>${esc(k)}</th><td>${esc(w)}</td></tr>`)
        .join('')}</table>`,
  );
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Betriebsrats-Bericht ${esc(b.monat)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1e293b}
table{border-collapse:collapse;width:100%;margin-bottom:1rem}th,td{border:1px solid #cbd5e1;padding:.3rem .5rem;text-align:left;vertical-align:top}
th{width:45%;font-weight:600;background:#f8fafc}</style></head>
<body><h1>seatmeter – Betriebsrats-Bericht ${esc(b.monat)}</h1>
<p>Nur Zähler und Konfiguration, keine Daten einzelner Personen.</p>
${teile.join('\n')}
</body></html>
`;
}
