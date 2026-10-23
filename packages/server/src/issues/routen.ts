// Issue-Auswertung im Dashboard: Kosten je Issue-Schlüssel aus `issue_aggregat`.
// Rechte wie die Projekt-Detailseite: alle Rollen, Projektleiter nur ihre Projekte (fremde → 404), keine
// Personen. `format=csv` liefert dieselben Zeilen als CSV (Excel, `;`, Dezimalkomma) und schreibt `audit`.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  monatSchema,
  projektSchluesselVon,
  type IssueProjektZeile,
  type IssueZeile,
  type IssuesAntwort,
  type Kennzahlen,
  type ProjektIssuesAntwort,
} from '@seatmeter/shared';
import { z } from 'zod';
import { heuteIn, monatsGrenzen } from '../aggregation/tage.js';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireBenutzer, type AnmeldungMitMandant } from '../auth/kontext.js';
import { csv, mikro, text } from '../berichte/csv.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import type { PluginKontext } from '../plugin.js';

type Trx = Transaction<Datenbank>;

const UNZUGEORDNET = 'unzugeordnet';

const abfrageSchema = z.object({
  monat: monatSchema.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

interface SummenRoh {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  web_search: number;
  anfragen: number;
  schatten_usd_micros: number;
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

/** Kennzahlen aus Summen (wie im Modul aggregation). */
export function kennzahlenAus(z: Partial<SummenRoh> | undefined): Kennzahlen {
  const n = (w: number | undefined) => Number(w ?? 0);
  const input = n(z?.input);
  const output = n(z?.output);
  const cacheRead = n(z?.cache_read);
  const cacheWrite = n(z?.cache_write);
  return {
    tokens: {
      input,
      output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cache_write_1h: n(z?.cache_write_1h),
      web_search: n(z?.web_search),
      gesamt: input + output + cacheRead + cacheWrite,
    },
    anfragen: n(z?.anfragen),
    schatten_usd_micros: n(z?.schatten_usd_micros),
  };
}

/** Differenz zweier Kennzahlen, nie negativ (Rundung beim Aufteilen). */
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

/** Anzeigename eines Projekts (wie im Modul aggregation). */
export function projektAnzeigename(p: {
  id: string;
  anzeigename: string | null;
  repo_name: string | null;
  owner: string | null;
  url_norm: string | null;
}): string {
  if (p.anzeigename) return p.anzeigename;
  if (p.repo_name) return p.owner ? `${p.owner}/${p.repo_name}` : p.repo_name;
  return p.url_norm ?? `Projekt ${p.id.slice(0, 8)}`;
}

/** Projektleiter: nur zugewiesene Projekte (ohne „unzugeordnet“); `null` = alle. */
function projektFilter(a: AnmeldungMitMandant): RawBuilder<unknown> {
  if (a.projektIds === null) return sql`true`;
  if (a.projektIds.length === 0) return sql`false`;
  return sql`projekt_id = ANY(${a.projektIds}::uuid[])`;
}

async function monatVon(trx: Trx, monat: string | undefined): Promise<string> {
  if (monat) return monat;
  const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
  return heuteIn(m.zeitzone).slice(0, 7);
}

interface IssueRoh extends SummenRoh {
  schluessel: string;
  projekt_id: string | null;
  sitzungen: number;
}

function issueZeile(z: IssueRoh): IssueZeile {
  return {
    schluessel: z.schluessel,
    projekt_schluessel: projektSchluesselVon(z.schluessel),
    sitzungen: Number(z.sitzungen),
    ...kennzahlenAus(z),
  };
}

const CSV_KOPF = [
  'Monat',
  'Projekt',
  'Issue',
  'Jira-Projekt',
  'Sitzungen',
  'Anfragen',
  'Tokens gesamt',
  'Input',
  'Output',
  'Cache lesen',
  'Cache schreiben',
  'Schattenpreis USD',
];

function csvZeile(monat: string, projekt: string, i: IssueZeile) {
  return [
    monat,
    text(projekt),
    text(i.schluessel),
    text(i.projekt_schluessel),
    i.sitzungen,
    i.anfragen,
    i.tokens.gesamt,
    i.tokens.input,
    i.tokens.output,
    i.tokens.cache_read,
    i.tokens.cache_write,
    mikro(i.schatten_usd_micros),
  ];
}

function csvSenden(reply: FastifyReply, name: string, inhalt: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('cache-control', 'no-store')
    .send(inhalt);
}

export function issueRouten(app: FastifyInstance, ctx: PluginKontext): void {
  const { db } = ctx;

  app.get(
    '/api/v1/projekte/:id/issues',
    { preHandler: requireBenutzer },
    async (request, reply) => {
      const q = abfrageSchema.safeParse(request.query);
      if (!q.success)
        return reply.code(400).send({ fehler: 'monat als JJJJ-MM, format json oder csv' });
      const roh = (request.params as { id?: string }).id ?? '';
      const unzugeordnet = roh === UNZUGEORDNET;
      if (!unzugeordnet && !z.uuid().safeParse(roh).success) {
        return reply.code(404).send({ fehler: 'nicht gefunden' });
      }
      const a = benutzerVon(request);
      if (a.projektIds !== null && (unzugeordnet || !a.projektIds.includes(roh))) {
        return reply.code(404).send({ fehler: 'nicht gefunden' });
      }
      const antwort = await withMandant(
        db,
        a.mandantId,
        async (trx): Promise<ProjektIssuesAntwort | null> => {
          const p = unzugeordnet
            ? null
            : await trx
                .selectFrom('projekt')
                .select(['id', 'anzeigename', 'repo_name', 'owner', 'url_norm'])
                .where('id', '=', roh)
                .executeTakeFirst();
          if (!unzugeordnet && !p) return null;
          const monat = await monatVon(trx, q.data.monat);
          const g = monatsGrenzen(monat);
          const filter = p ? sql`projekt_id = ${p.id}::uuid` : sql`projekt_id IS NULL`;
          const issues = await sql<IssueRoh>`
          SELECT schluessel, projekt_id, sitzungen, ${SUMMEN}
          FROM issue_aggregat WHERE monat = ${g.von}::date AND ${filter}
          GROUP BY schluessel, projekt_id, sitzungen
          ORDER BY schatten_usd_micros DESC, schluessel`.execute(trx);
          const gesamt = await sql<SummenRoh>`
          SELECT ${SUMMEN} FROM tag_aggregat
          WHERE tag >= ${g.von}::date AND tag < ${g.bisExklusiv}::date AND ${filter}`.execute(trx);
          const zeilen = issues.rows.map(issueZeile);
          const summeIssues = kennzahlenAus(
            zeilen.reduce<SummenRoh>(
              (s, i) => ({
                input: s.input + i.tokens.input,
                output: s.output + i.tokens.output,
                cache_read: s.cache_read + i.tokens.cache_read,
                cache_write: s.cache_write + i.tokens.cache_write,
                cache_write_1h: s.cache_write_1h + i.tokens.cache_write_1h,
                web_search: s.web_search + i.tokens.web_search,
                anfragen: s.anfragen + i.anfragen,
                schatten_usd_micros: s.schatten_usd_micros + i.schatten_usd_micros,
              }),
              {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                cache_write_1h: 0,
                web_search: 0,
                anfragen: 0,
                schatten_usd_micros: 0,
              },
            ),
          );
          const summe = kennzahlenAus(gesamt.rows[0]);
          if (q.data.format === 'csv') {
            await protokolliere(trx, {
              benutzerId: a.benutzerId,
              aktion: AUDIT_AKTION.exportIssues,
              objekt: `issues projekt:${p?.id ?? UNZUGEORDNET} monat:${monat} format:csv`,
            });
          }
          return {
            monat,
            projekt: { id: p?.id ?? UNZUGEORDNET, name: p ? projektAnzeigename(p) : UNZUGEORDNET },
            issues: zeilen,
            ohne_schluessel: minus(summe, summeIssues),
            gesamt: summe,
          };
        },
      );
      if (!antwort) return reply.code(404).send({ fehler: 'nicht gefunden' });
      if (q.data.format === 'csv') {
        return csvSenden(
          reply,
          `issues-${antwort.monat}.csv`,
          csv([
            CSV_KOPF,
            ...antwort.issues.map((i) => csvZeile(antwort.monat, antwort.projekt.name, i)),
          ]),
        );
      }
      return antwort;
    },
  );

  app.get('/api/v1/issues', { preHandler: requireBenutzer }, async (request, reply) => {
    const q = abfrageSchema.safeParse(request.query);
    if (!q.success)
      return reply.code(400).send({ fehler: 'monat als JJJJ-MM, format json oder csv' });
    const a = benutzerVon(request);
    const antwort: IssuesAntwort = await withMandant(db, a.mandantId, async (trx) => {
      const monat = await monatVon(trx, q.data.monat);
      const g = monatsGrenzen(monat);
      const r = await sql<IssueRoh>`
        SELECT schluessel, projekt_id, sitzungen, ${SUMMEN}
        FROM issue_aggregat WHERE monat = ${g.von}::date AND ${projektFilter(a)}
        GROUP BY schluessel, projekt_id, sitzungen
        ORDER BY schluessel, schatten_usd_micros DESC`.execute(trx);
      const ids = [...new Set(r.rows.flatMap((z) => (z.projekt_id ? [z.projekt_id] : [])))];
      const projekte = ids.length
        ? await trx
            .selectFrom('projekt')
            .select(['id', 'anzeigename', 'repo_name', 'owner', 'url_norm'])
            .where('id', 'in', ids)
            .execute()
        : [];
      const namen = new Map(projekte.map((p) => [p.id, projektAnzeigename(p)]));
      const issues: IssueProjektZeile[] = r.rows.map((z) => ({
        ...issueZeile(z),
        projekt: z.projekt_id ? { id: z.projekt_id, name: namen.get(z.projekt_id) ?? '' } : null,
      }));
      if (q.data.format === 'csv') {
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_AKTION.exportIssues,
          objekt: `issues monat:${monat} format:csv`,
        });
      }
      return { monat, issues };
    });
    if (q.data.format === 'csv') {
      return csvSenden(
        reply,
        `issues-${antwort.monat}.csv`,
        csv([
          CSV_KOPF,
          ...antwort.issues.map((i) => csvZeile(antwort.monat, i.projekt?.name ?? UNZUGEORDNET, i)),
        ]),
      );
    }
    return antwort;
  });
}
