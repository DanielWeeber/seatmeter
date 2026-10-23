// Kosten je Jira-Projekt und Issue: aus dem Kern-Aggregat `issue_aggregat` (Schlüssel)
// und der Zuordnung seatmeter-Projekt → Jira-Projekt. Ein Issue gehört zum Jira-Projekt seines
// Schlüsselpräfixes (`ABC-123` → `ABC`), gleich aus welchem seatmeter-Projekt; Nutzung ohne Schlüssel
// zählt zum zugeordneten Jira-Projekt des seatmeter-Projekts. Titel und Status kommen aus dem
// Zwischenspeicher, fehlende werden außerhalb der Transaktion nachgeladen (höchstens 50 je Aufruf).
import { monatsGrenzen } from '../aggregation/tage.js';
import type { AnmeldungMitMandant } from '../auth/kontext.js';
import { kennzahlenAus, projektAnzeigename } from '../issues/routen.js';
import {
  projektSchluesselVon,
  type JiraKostenAntwort,
  type JiraKostenIssue,
  type JiraKostenProjekt,
  type Kennzahlen,
} from '@seatmeter/shared';
import { sql, type RawBuilder } from 'kysely';
import { jiraIssue, JiraFehler, type JiraClientOptionen, type JiraZugang } from './client.js';
import { CACHE_MS, titelLaden, type JiraTrx, type TitelEintrag } from './daten.js';

/** Höchstens so viele Issues lädt ein Aufruf aus Jira nach. */
export const NACHLADEN_MAX = 50;
const PARALLEL = 5;

const NULL_KENNZAHLEN: Kennzahlen = kennzahlenAus(undefined);

function plus(a: Kennzahlen, b: Kennzahlen): Kennzahlen {
  const t = {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    cache_read: a.tokens.cache_read + b.tokens.cache_read,
    cache_write: a.tokens.cache_write + b.tokens.cache_write,
    cache_write_1h: a.tokens.cache_write_1h + b.tokens.cache_write_1h,
    web_search: a.tokens.web_search + b.tokens.web_search,
  };
  return {
    tokens: { ...t, gesamt: t.input + t.output + t.cache_read + t.cache_write },
    anfragen: a.anfragen + b.anfragen,
    schatten_usd_micros: a.schatten_usd_micros + b.schatten_usd_micros,
  };
}

function minus(a: Kennzahlen, b: Kennzahlen): Kennzahlen {
  const d = (x: number, y: number) => Math.max(0, x - y);
  const t = {
    input: d(a.tokens.input, b.tokens.input),
    output: d(a.tokens.output, b.tokens.output),
    cache_read: d(a.tokens.cache_read, b.tokens.cache_read),
    cache_write: d(a.tokens.cache_write, b.tokens.cache_write),
    cache_write_1h: d(a.tokens.cache_write_1h, b.tokens.cache_write_1h),
    web_search: d(a.tokens.web_search, b.tokens.web_search),
  };
  return {
    tokens: { ...t, gesamt: t.input + t.output + t.cache_read + t.cache_write },
    anfragen: d(a.anfragen, b.anfragen),
    schatten_usd_micros: d(a.schatten_usd_micros, b.schatten_usd_micros),
  };
}

const SUMMEN = sql`
  coalesce(sum(input), 0)::bigint AS input,
  coalesce(sum(output), 0)::bigint AS output,
  coalesce(sum(cache_read), 0)::bigint AS cache_read,
  coalesce(sum(cache_write), 0)::bigint AS cache_write,
  coalesce(sum(cache_write_1h), 0)::bigint AS cache_write_1h,
  coalesce(sum(web_search), 0)::bigint AS web_search,
  coalesce(sum(anfragen), 0)::bigint AS anfragen,
  coalesce(sum(schatten_usd_micros), 0)::bigint AS schatten_usd_micros`;

type SummenRoh = Parameters<typeof kennzahlenAus>[0];

/** Projektleiter: nur zugewiesene Projekte; `null` = alle. */
function projektFilter(a: AnmeldungMitMandant, spalte = 'projekt_id'): RawBuilder<unknown> {
  if (a.projektIds === null) return sql`true`;
  if (a.projektIds.length === 0) return sql`false`;
  return sql`${sql.ref(spalte)} = ANY(${a.projektIds}::uuid[])`;
}

type IssueRoh = Omit<JiraKostenIssue, 'titel' | 'status' | 'gefunden'>;
type ProjektRoh = Omit<JiraKostenProjekt, 'issues'> & { issues: IssueRoh[] };

/** Ergebnis ohne Titel, dazu der Zwischenspeicher der vorkommenden Schlüssel. */
export interface KostenRoh {
  monat: string;
  projekte: ProjektRoh[];
  titel: Map<string, TitelEintrag>;
}

export async function kostenBerechnen(
  trx: JiraTrx,
  a: AnmeldungMitMandant,
  monat: string,
): Promise<KostenRoh> {
  const g = monatsGrenzen(monat);
  const issues = await sql<
    NonNullable<SummenRoh> & { schluessel: string; projekt_id: string | null; sitzungen: number }
  >`
    SELECT schluessel, projekt_id, sitzungen, ${SUMMEN}
    FROM issue_aggregat WHERE monat = ${g.von}::date AND ${projektFilter(a)}
    GROUP BY schluessel, projekt_id, sitzungen`.execute(trx);
  const zuordnung = await trx
    .selectFrom('projekt_jira')
    .innerJoin('projekt', 'projekt.id', 'projekt_jira.projekt_id')
    .select([
      'projekt_jira.projekt_id',
      'projekt_jira.jira_projekt_schluessel',
      'projekt_jira.jira_projekt_name',
      'projekt.anzeigename',
      'projekt.repo_name',
      'projekt.owner',
      'projekt.url_norm',
    ])
    .where(projektFilter(a, 'projekt_jira.projekt_id') as RawBuilder<boolean>)
    .execute();
  const zugeordnet = zuordnung.map((z) => z.projekt_id);
  const summen = zugeordnet.length
    ? await sql<NonNullable<SummenRoh> & { projekt_id: string }>`
        SELECT projekt_id, ${SUMMEN} FROM tag_aggregat
        WHERE tag >= ${g.von}::date AND tag < ${g.bisExklusiv}::date
          AND projekt_id = ANY(${zugeordnet}::uuid[])
        GROUP BY projekt_id`.execute(trx)
    : { rows: [] };
  const gesamtJeProjekt = new Map(summen.rows.map((z) => [z.projekt_id, kennzahlenAus(z)]));

  // Issues je Schlüssel (über seatmeter-Projekte summiert) und Schlüsselsummen je seatmeter-Projekt.
  const jeSchluessel = new Map<string, { k: Kennzahlen; sitzungen: number }>();
  const mitSchluesselJeProjekt = new Map<string, Kennzahlen>();
  for (const z of issues.rows) {
    const k = kennzahlenAus(z);
    const v = jeSchluessel.get(z.schluessel);
    jeSchluessel.set(z.schluessel, {
      k: v ? plus(v.k, k) : k,
      sitzungen: (v?.sitzungen ?? 0) + Number(z.sitzungen),
    });
    if (z.projekt_id)
      mitSchluesselJeProjekt.set(
        z.projekt_id,
        plus(mitSchluesselJeProjekt.get(z.projekt_id) ?? NULL_KENNZAHLEN, k),
      );
  }

  const jira = new Map<
    string,
    {
      name: string | null;
      seatmeter: { id: string; name: string }[];
      ohne: Kennzahlen;
      issues: IssueRoh[];
    }
  >();
  const jiraProjekt = (s: string) => {
    let j = jira.get(s);
    if (!j) {
      j = { name: null, seatmeter: [], ohne: NULL_KENNZAHLEN, issues: [] };
      jira.set(s, j);
    }
    return j;
  };
  for (const z of zuordnung) {
    const j = jiraProjekt(z.jira_projekt_schluessel);
    j.name ??= z.jira_projekt_name;
    j.seatmeter.push({ id: z.projekt_id, name: projektAnzeigename({ ...z, id: z.projekt_id }) });
    const ohne = minus(
      gesamtJeProjekt.get(z.projekt_id) ?? NULL_KENNZAHLEN,
      mitSchluesselJeProjekt.get(z.projekt_id) ?? NULL_KENNZAHLEN,
    );
    j.ohne = plus(j.ohne, ohne);
  }
  for (const [schluessel, v] of jeSchluessel)
    jiraProjekt(projektSchluesselVon(schluessel)).issues.push({
      schluessel,
      sitzungen: v.sitzungen,
      ...v.k,
    });

  const projekte = [...jira.entries()]
    .map(([schluessel, j]) => {
      const issuesSortiert = j.issues.sort(
        (x, y) =>
          y.schatten_usd_micros - x.schatten_usd_micros || x.schluessel.localeCompare(y.schluessel),
      );
      const summe = issuesSortiert.reduce<Kennzahlen>((s, i) => plus(s, i), j.ohne);
      return {
        schluessel,
        name: j.name,
        seatmeter_projekte: j.seatmeter.sort((x, y) => x.name.localeCompare(y.name)),
        issues: issuesSortiert,
        ohne_issue: j.ohne,
        ...summe,
      };
    })
    .sort(
      (x, y) =>
        y.schatten_usd_micros - x.schatten_usd_micros || x.schluessel.localeCompare(y.schluessel),
    );
  return { monat, projekte, titel: await titelLaden(trx, [...jeSchluessel.keys()]) };
}

/** Schlüssel ohne gültigen Titel im Zwischenspeicher (fehlend oder älter als 24 h). */
export function nachzuladen(roh: KostenRoh, jetzt = new Date()): string[] {
  const alle = roh.projekte.flatMap((p) => p.issues.map((i) => i.schluessel));
  return alle.filter((s) => {
    const t = roh.titel.get(s);
    return !t || jetzt.getTime() - t.geholt.getTime() > CACHE_MS;
  });
}

export interface NachladeErgebnis {
  eintraege: {
    schluessel: string;
    titel: string | null;
    status: string | null;
    gefunden: boolean;
  }[];
  fehler: string | null;
}

/**
 * Lädt Titel und Status aus Jira nach (höchstens `NACHLADEN_MAX`, 5 parallel). Fehler blockieren nicht:
 * bei Zugangs-, Netz- und Zielfehlern endet das Nachladen mit einer Meldung ohne Token.
 */
export async function titelNachladen(
  zugang: JiraZugang,
  schluessel: readonly string[],
  o: JiraClientOptionen = {},
): Promise<NachladeErgebnis> {
  const liste = schluessel.slice(0, NACHLADEN_MAX);
  const ergebnis: NachladeErgebnis = { eintraege: [], fehler: null };
  for (let i = 0; i < liste.length && !ergebnis.fehler; i += PARALLEL) {
    const teil = liste.slice(i, i + PARALLEL);
    const antworten = await Promise.allSettled(teil.map((s) => jiraIssue(zugang, s, o)));
    antworten.forEach((r, n) => {
      const s = teil[n] as string;
      if (r.status === 'fulfilled') {
        ergebnis.eintraege.push(
          r.value
            ? { schluessel: s, titel: r.value.titel, status: r.value.status, gefunden: true }
            : { schluessel: s, titel: null, status: null, gefunden: false },
        );
      } else if (!ergebnis.fehler) {
        ergebnis.fehler =
          r.reason instanceof JiraFehler ? r.reason.message : 'Titel konnten nicht geladen werden';
      }
    });
  }
  return ergebnis;
}

/** Fügt Titel (Zwischenspeicher plus frisch geladene) in das Ergebnis ein. */
export function mitTiteln(
  roh: KostenRoh,
  frisch: NachladeErgebnis['eintraege'],
  fehler: string | null,
): JiraKostenAntwort {
  const titel = new Map(roh.titel);
  for (const e of frisch) titel.set(e.schluessel, { ...e, geholt: new Date() });
  let offen = 0;
  const jira_projekte: JiraKostenProjekt[] = roh.projekte.map((p) => ({
    ...p,
    issues: p.issues.map((i) => {
      const t = titel.get(i.schluessel);
      if (!t) offen += 1;
      return {
        ...i,
        titel: t?.titel ?? null,
        status: t?.status ?? null,
        gefunden: t ? t.gefunden : null,
      };
    }),
  }));
  return {
    monat: roh.monat,
    jira_projekte,
    titel: { nachgeladen: frisch.length, offen, fehler },
  };
}
