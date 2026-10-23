// Dashboard-Lesezugriffe (Architektur §2.4, §7): alles aus `tag_aggregat` (Abdeckung A/B aus
// `anfrage`), je Mandant über withMandant, Personen nur gemäß Auswertungsstufe und Rolle.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import {
  fehlerKoerper,
  monatAbfrageSchema,
  type AbdeckungQuellen,
  type Datenqualitaet,
  type Kennzahlen,
  type ModellZeile,
  type PersonenAntwort,
  type PersonenHinweis,
  type PersonZeile,
  type ProjektDetail,
  type ProjektZeile,
  type TagZeile,
  type Uebersicht,
} from '@seatmeter/shared';
import { z } from 'zod';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireBenutzer, type AnmeldungMitMandant } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import { entschluessele } from '../krypto.js';
import type { PluginKontext } from '../plugin.js';
import { heuteIn, monatsGrenzen } from './tage.js';

type Trx = Transaction<Datenbank>;

/** Mindestgruppe je Ausweis in Auswertungsstufe 1 (Architektur §7). */
export const MINDESTGRUPPE = 3;
export const UNZUGEORDNET_NAME = 'unzugeordnet';

interface MandantSicht {
  zeitzone: string;
  auswertungsstufe: number;
  klarnamen_aktiv: boolean;
}

interface Bereich {
  monat: string;
  von: string;
  bisExklusiv: string;
}

const SUMMEN_SQL = sql`
  coalesce(sum(input), 0)::bigint AS input,
  coalesce(sum(output), 0)::bigint AS output,
  coalesce(sum(cache_read), 0)::bigint AS cache_read,
  coalesce(sum(cache_write), 0)::bigint AS cache_write,
  coalesce(sum(cache_write_1h), 0)::bigint AS cache_write_1h,
  coalesce(sum(web_search), 0)::bigint AS web_search,
  coalesce(sum(anfragen), 0)::bigint AS anfragen,
  coalesce(sum(schatten_usd_micros), 0)::bigint AS schatten_usd_micros`;

interface SummenZeile {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  web_search: number;
  anfragen: number;
  schatten_usd_micros: number;
}

function kennzahlen(z: SummenZeile | undefined): Kennzahlen {
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

function prozent(teil: number, ganz: number): number | null {
  return ganz > 0 ? Math.round((teil / ganz) * 1000) / 10 : null;
}

/** Filter für Projektleiter (nur zugewiesene Projekte); `null` = alle. */
function projektFilter(a: AnmeldungMitMandant, spalte = 'projekt_id'): RawBuilder<unknown> {
  if (a.projektIds === null) return sql`true`;
  if (a.projektIds.length === 0) return sql`false`;
  return sql`${sql.ref(spalte)} = ANY(${a.projektIds}::uuid[])`;
}

function personenErlaubt(a: AnmeldungMitMandant): boolean {
  return a.rollen.includes('mandanten_admin') || a.rollen.includes('projektleiter');
}

function personenHinweis(stufe: number, anzahl: number): PersonenHinweis | null {
  if (stufe <= 0) return 'Auswertungsstufe 0';
  if (stufe === 1 && anzahl < MINDESTGRUPPE) return 'zu wenige Personen';
  return null;
}

async function mandantSicht(trx: Trx): Promise<MandantSicht> {
  return trx
    .selectFrom('mandant')
    .select(['zeitzone', 'auswertungsstufe', 'klarnamen_aktiv'])
    .executeTakeFirstOrThrow();
}

function bereich(monat: string | undefined, zeitzone: string): Bereich {
  const m = monat ?? heuteIn(zeitzone).slice(0, 7);
  return { monat: m, ...monatsGrenzen(m) };
}

function imMonat(b: Bereich): RawBuilder<unknown> {
  return sql`tag >= ${b.von}::date AND tag < ${b.bisExklusiv}::date`;
}

async function abdeckung(trx: Trx, b: Bereich, filter: RawBuilder<unknown>) {
  const r = await sql<{
    n: number;
    nur_a: number;
    nur_b: number;
    beide: number;
    heuristisch: number;
    abweichung_ab: number;
  }>`
    SELECT count(*) AS n,
      count(*) FILTER (WHERE quellen & 3 = 1) AS nur_a,
      count(*) FILTER (WHERE quellen & 3 = 2) AS nur_b,
      count(*) FILTER (WHERE quellen & 3 = 3) AS beide,
      count(*) FILTER (WHERE heuristisch) AS heuristisch,
      count(*) FILTER (WHERE abweichung_ab) AS abweichung_ab
    FROM anfrage WHERE ${imMonat(b)} AND zaehlt_als_abo AND ${filter}`.execute(trx);
  const z = r.rows[0];
  const n = Number(z?.n ?? 0);
  const nurA = Number(z?.nur_a ?? 0);
  const nurB = Number(z?.nur_b ?? 0);
  const beide = Number(z?.beide ?? 0);
  const quellen: AbdeckungQuellen = {
    anfragen: n,
    nur_a: nurA,
    nur_b: nurB,
    beide,
    a_prozent: prozent(nurA + beide, n),
    b_prozent: prozent(nurB + beide, n),
  };
  return {
    ...quellen,
    heuristisch: Number(z?.heuristisch ?? 0),
    abweichung_ab: Number(z?.abweichung_ab ?? 0),
  };
}

async function nachModell(
  trx: Trx,
  b: Bereich,
  filter: RawBuilder<unknown>,
): Promise<ModellZeile[]> {
  const r = await sql<SummenZeile & { model: string }>`
    SELECT model, ${SUMMEN_SQL} FROM tag_aggregat
    WHERE ${imMonat(b)} AND ${filter}
    GROUP BY model ORDER BY schatten_usd_micros DESC, model`.execute(trx);
  return r.rows.map((z) => ({ model: z.model, ...kennzahlen(z) }));
}

async function nachTag(trx: Trx, b: Bereich, filter: RawBuilder<unknown>): Promise<TagZeile[]> {
  const r = await sql<SummenZeile & { tag: string }>`
    SELECT tag, ${SUMMEN_SQL} FROM tag_aggregat
    WHERE ${imMonat(b)} AND ${filter}
    GROUP BY tag ORDER BY tag`.execute(trx);
  return r.rows.map((z) => ({ tag: z.tag, ...kennzahlen(z) }));
}

function projektName(p: {
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

/**
 * Personenzeilen mit Monatssummen (ab Stufe 2 mit Tagesverlauf), Klarnamen nur bei Opt-in.
 * `filter` bezieht sich auf den Alias `t` (tag_aggregat).
 */
async function personenZeilen(
  trx: Trx,
  ctx: PluginKontext,
  b: Bereich,
  filter: RawBuilder<unknown>,
  sicht: MandantSicht,
): Promise<PersonZeile[]> {
  const r = await sql<SummenZeile & { person_id: string; pseudonym: string }>`
    SELECT t.person_id, p.pseudonym, ${SUMMEN_SQL}
    FROM tag_aggregat t JOIN person p ON p.id = t.person_id
    WHERE ${imMonat(b)} AND ${filter}
    GROUP BY t.person_id, p.pseudonym ORDER BY schatten_usd_micros DESC, p.pseudonym`.execute(trx);
  const ids = r.rows.map((z) => z.person_id);
  const klar = new Map<string, { email: string | null; name: string | null }>();
  if (sicht.klarnamen_aktiv && ids.length > 0) {
    const zeilen = await trx
      .selectFrom('person_klar')
      .select(['person_id', 'email_enc', 'name_enc'])
      .where('person_id', 'in', ids)
      .execute();
    const lies = (wert: Buffer | null, aad: string) => {
      if (!wert) return null;
      try {
        return entschluessele(ctx.konfiguration.SEATMETER_MASTER_KEY, wert, aad).toString('utf8');
      } catch {
        return null;
      }
    };
    for (const z of zeilen) {
      klar.set(z.person_id, {
        email: lies(z.email_enc, 'person_klar.email_enc'),
        name: lies(z.name_enc, 'person_klar.name_enc'),
      });
    }
  }
  const tage = new Map<string, TagZeile[]>();
  if (sicht.auswertungsstufe >= 2 && ids.length > 0) {
    const t = await sql<SummenZeile & { person_id: string; tag: string }>`
      SELECT t.person_id, t.tag, ${SUMMEN_SQL} FROM tag_aggregat t
      WHERE ${imMonat(b)} AND ${filter} AND t.person_id = ANY(${ids}::uuid[])
      GROUP BY t.person_id, t.tag ORDER BY t.tag`.execute(trx);
    for (const z of t.rows) {
      const liste = tage.get(z.person_id) ?? [];
      liste.push({ tag: z.tag, ...kennzahlen(z) });
      tage.set(z.person_id, liste);
    }
  }
  return r.rows.map((z) => ({
    id: z.person_id,
    pseudonym: z.pseudonym,
    klarname: klar.get(z.person_id) ?? null,
    ...kennzahlen(z),
    ...(sicht.auswertungsstufe >= 2 ? { nach_tag: tage.get(z.person_id) ?? [] } : {}),
  }));
}

function abfrage(request: FastifyRequest, reply: FastifyReply): { monat?: string } | null {
  const q = monatAbfrageSchema.safeParse(request.query);
  if (!q.success) {
    void reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
    return null;
  }
  return q.data;
}

export function dashboardRouten(app: FastifyInstance, ctx: PluginKontext): void {
  const { db } = ctx;

  app.get('/api/v1/uebersicht', { preHandler: requireBenutzer }, async (request, reply) => {
    const q = abfrage(request, reply);
    if (!q) return reply;
    const a = benutzerVon(request);
    const antwort: Uebersicht = await withMandant(db, a.mandantId, async (trx) => {
      const sicht = await mandantSicht(trx);
      const b = bereich(q.monat, sicht.zeitzone);
      const filter = projektFilter(a);
      const summe = await sql<SummenZeile>`
        SELECT ${SUMMEN_SQL} FROM tag_aggregat WHERE ${imMonat(b)} AND ${filter}`.execute(trx);
      const gefiltert = await sql<{ api: number; fremd_org: number; inhalt: number }>`
        SELECT coalesce(sum(verworfen_api), 0)::bigint AS api,
          coalesce(sum(verworfen_fremd_org), 0)::bigint AS fremd_org,
          coalesce(sum(verworfen_inhalt), 0)::bigint AS inhalt
        FROM ingest_statistik WHERE ${imMonat(b)}`.execute(trx);
      const { heuristisch: _h, abweichung_ab: _w, ...quellen } = await abdeckung(trx, b, filter);
      return {
        monat: b.monat,
        ...kennzahlen(summe.rows[0]),
        nach_modell: await nachModell(trx, b, filter),
        abdeckung: quellen,
        gefiltert: {
          api: Number(gefiltert.rows[0]?.api ?? 0),
          fremd_org: Number(gefiltert.rows[0]?.fremd_org ?? 0),
          inhalt_verworfen: Number(gefiltert.rows[0]?.inhalt ?? 0),
        },
      };
    });
    return antwort;
  });

  app.get('/api/v1/projekte', { preHandler: requireBenutzer }, async (request, reply) => {
    const q = abfrage(request, reply);
    if (!q) return reply;
    const a = benutzerVon(request);
    return withMandant(db, a.mandantId, async (trx) => {
      const sicht = await mandantSicht(trx);
      const b = bereich(q.monat, sicht.zeitzone);
      const r = await sql<SummenZeile & { projekt_id: string | null; personen: number }>`
        SELECT projekt_id, count(DISTINCT person_id) AS personen, ${SUMMEN_SQL}
        FROM tag_aggregat WHERE ${imMonat(b)} AND ${projektFilter(a)}
        GROUP BY projekt_id ORDER BY schatten_usd_micros DESC`.execute(trx);
      const ids = r.rows.flatMap((z) => (z.projekt_id ? [z.projekt_id] : []));
      const projekte = ids.length
        ? await trx
            .selectFrom('projekt')
            .select(['id', 'anzeigename', 'repo_name', 'owner', 'url_norm', 'kunde'])
            .where('id', 'in', ids)
            .execute()
        : [];
      const info = new Map(projekte.map((p) => [p.id, p]));
      const liste: ProjektZeile[] = r.rows.map((z) => {
        const p = z.projekt_id ? info.get(z.projekt_id) : undefined;
        const anzahl = Number(z.personen);
        const hinweis = personenHinweis(sicht.auswertungsstufe, anzahl);
        return {
          id: z.projekt_id,
          name: p ? projektName(p) : UNZUGEORDNET_NAME,
          kunde: p?.kunde ?? null,
          url_norm: p?.url_norm ?? null,
          personen: hinweis ? null : anzahl,
          personen_hinweis: hinweis,
          ...kennzahlen(z),
        };
      });
      return { monat: b.monat, auswertungsstufe: sicht.auswertungsstufe, projekte: liste };
    });
  });

  app.get('/api/v1/projekte/:id', { preHandler: requireBenutzer }, async (request, reply) => {
    const q = abfrage(request, reply);
    if (!q) return reply;
    const roh = (request.params as { id?: string }).id ?? '';
    const unzugeordnet = roh === UNZUGEORDNET_NAME;
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
      async (trx): Promise<ProjektDetail | null> => {
        const sicht = await mandantSicht(trx);
        const b = bereich(q.monat, sicht.zeitzone);
        const p = unzugeordnet
          ? null
          : await trx
              .selectFrom('projekt')
              .select(['id', 'anzeigename', 'repo_name', 'owner', 'url_norm', 'kunde'])
              .where('id', '=', roh)
              .executeTakeFirst();
        if (!unzugeordnet && !p) return null;
        const filter = p ? sql`projekt_id = ${p.id}::uuid` : sql`projekt_id IS NULL`;
        const summe = await sql<SummenZeile & { personen: number }>`
        SELECT count(DISTINCT person_id) AS personen, ${SUMMEN_SQL}
        FROM tag_aggregat WHERE ${imMonat(b)} AND ${filter}`.execute(trx);
        const anzahl = Number(summe.rows[0]?.personen ?? 0);
        let hinweis: PersonenHinweis | null = personenHinweis(sicht.auswertungsstufe, anzahl);
        let personen: PersonZeile[] | null = null;
        if (!hinweis && !personenErlaubt(a)) hinweis = 'Rolle ohne Personensicht';
        if (!hinweis) {
          const tFilter = p ? sql`t.projekt_id = ${p.id}::uuid` : sql`t.projekt_id IS NULL`;
          personen = await personenZeilen(trx, ctx, b, tFilter, sicht);
          await protokolliere(trx, {
            benutzerId: a.benutzerId,
            aktion: AUDIT_AKTION.personensicht,
            objekt: `projekt:${p?.id ?? UNZUGEORDNET_NAME} ${b.monat}${sicht.klarnamen_aktiv ? ' (Klarnamen)' : ''}`,
          });
        }
        return {
          monat: b.monat,
          projekt: {
            id: p?.id ?? null,
            name: p ? projektName(p) : UNZUGEORDNET_NAME,
            kunde: p?.kunde ?? null,
            url_norm: p?.url_norm ?? null,
            personen:
              hinweis === 'Auswertungsstufe 0' || hinweis === 'zu wenige Personen' ? null : anzahl,
            personen_hinweis: hinweis,
          },
          ...kennzahlen(summe.rows[0]),
          nach_modell: await nachModell(trx, b, filter),
          nach_tag: await nachTag(trx, b, filter),
          auswertungsstufe: sicht.auswertungsstufe,
          personen,
          personen_hinweis: hinweis,
        };
      },
    );
    if (!antwort) return reply.code(404).send({ fehler: 'nicht gefunden' });
    return antwort;
  });

  app.get('/api/v1/personen', { preHandler: requireBenutzer }, async (request, reply) => {
    const q = abfrage(request, reply);
    if (!q) return reply;
    const a = benutzerVon(request);
    // Ganze Ressource verboten → 403 `rolle_fehlt`; in `/projekte/:id` dagegen `personen: null` + Hinweis.
    if (!personenErlaubt(a)) {
      return reply.code(403).send(fehlerKoerper('rolle_fehlt', 'Rolle ohne Personensicht'));
    }
    const antwort: PersonenAntwort = await withMandant(db, a.mandantId, async (trx) => {
      const sicht = await mandantSicht(trx);
      const b = bereich(q.monat, sicht.zeitzone);
      const filter = projektFilter(a, 't.projekt_id');
      const n = await sql<{ n: number }>`
        SELECT count(DISTINCT person_id) AS n FROM tag_aggregat t
        WHERE ${imMonat(b)} AND ${filter}`.execute(trx);
      const hinweis = personenHinweis(sicht.auswertungsstufe, Number(n.rows[0]?.n ?? 0));
      const basis = {
        monat: b.monat,
        auswertungsstufe: sicht.auswertungsstufe,
        klarnamen_aktiv: sicht.klarnamen_aktiv,
      };
      if (hinweis) return { ...basis, personen: null, personen_hinweis: hinweis };
      const personen = await personenZeilen(trx, ctx, b, filter, sicht);
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_AKTION.personensicht,
        objekt: `personen ${b.monat}${sicht.klarnamen_aktiv ? ' (Klarnamen)' : ''}`,
      });
      return { ...basis, personen, personen_hinweis: null };
    });
    return antwort;
  });

  app.get('/api/v1/datenqualitaet', { preHandler: requireBenutzer }, async (request, reply) => {
    const q = abfrage(request, reply);
    if (!q) return reply;
    const a = benutzerVon(request);
    const antwort: Datenqualitaet = await withMandant(db, a.mandantId, async (trx) => {
      const sicht = await mandantSicht(trx);
      const b = bereich(q.monat, sicht.zeitzone);
      const filter = projektFilter(a);
      const unz = await sql<{ tokens: number; unz_tokens: number; unz_anfragen: number }>`
        SELECT coalesce(sum(input + output + cache_read + cache_write), 0)::bigint AS tokens,
          coalesce(sum(input + output + cache_read + cache_write) FILTER (WHERE projekt_id IS NULL), 0)::bigint AS unz_tokens,
          coalesce(sum(anfragen) FILTER (WHERE projekt_id IS NULL), 0)::bigint AS unz_anfragen
        FROM tag_aggregat WHERE ${imMonat(b)} AND ${filter}`.execute(trx);
      const ohnePreis = await sql<{ model: string }>`
        SELECT DISTINCT model FROM tag_aggregat
        WHERE ${imMonat(b)} AND preis_version IS NULL AND ${filter} ORDER BY model`.execute(trx);
      // Ingest-Zähler haben keine Projektdimension: mandantenweit wie `gefiltert` in der Übersicht.
      const ingest = await sql<{
        quelle: 'a' | 'b' | 'c';
        angenommen: number;
        verworfen_inhalt: number;
        verworfen_api: number;
        verworfen_fremd_org: number;
        unzugeordnet: number;
      }>`
        SELECT quelle, sum(angenommen)::bigint AS angenommen,
          sum(verworfen_inhalt)::bigint AS verworfen_inhalt,
          sum(verworfen_api)::bigint AS verworfen_api,
          sum(verworfen_fremd_org)::bigint AS verworfen_fremd_org,
          sum(unzugeordnet)::bigint AS unzugeordnet
        FROM ingest_statistik WHERE ${imMonat(b)} GROUP BY quelle ORDER BY quelle`.execute(trx);
      // Vollständigkeit: OTel-Kontrollsumme je Sitzung gegen die gezählten Tokens (alle Typen).
      // Projektleiter: nur Sitzungen, deren Anfragen im Monat alle in sichtbaren Projekten liegen
      // (die Kontrollsumme kennt kein Projekt; gemischte Sitzungen verrieten fremde Projekte).
      const sitzungen =
        a.projektIds === null
          ? sql`true`
          : sql`session_id IN (
              SELECT session_id FROM anfrage
              WHERE ${imMonat(b)} AND session_id IS NOT NULL
              GROUP BY session_id HAVING bool_and(coalesce(${projektFilter(a)}, false)))`;
      const kontrolle = await sql<{
        sitzungen: number;
        abweichend: number;
        kontrolle: number;
        gezaehlt: number;
      }>`
        WITH k AS (
          SELECT session_id, sum(wert)::bigint AS w FROM otel_kontrollsumme
          WHERE ${imMonat(b)} AND typ IN ('input', 'output', 'cacheRead', 'cacheCreation')
            AND ${sitzungen}
          GROUP BY session_id
        ), g AS (
          SELECT session_id, sum(input + output + cache_read + cache_write)::bigint AS w
          FROM anfrage WHERE ${imMonat(b)} AND session_id IN (SELECT session_id FROM k)
          GROUP BY session_id
        )
        SELECT count(*) AS sitzungen,
          count(*) FILTER (WHERE abs(coalesce(g.w, 0) - k.w) > k.w * 0.01) AS abweichend,
          coalesce(sum(k.w), 0)::bigint AS kontrolle,
          coalesce(sum(g.w), 0)::bigint AS gezaehlt
        FROM k LEFT JOIN g USING (session_id)`.execute(trx);
      const u = unz.rows[0];
      const k = kontrolle.rows[0];
      const tokensKontrolle = Number(k?.kontrolle ?? 0);
      const tokensGezaehlt = Number(k?.gezaehlt ?? 0);
      return {
        monat: b.monat,
        abdeckung: await abdeckung(trx, b, filter),
        unzugeordnet: {
          tokens: Number(u?.unz_tokens ?? 0),
          anfragen: Number(u?.unz_anfragen ?? 0),
          tokens_prozent: prozent(Number(u?.unz_tokens ?? 0), Number(u?.tokens ?? 0)),
        },
        modelle_ohne_preis: ohnePreis.rows.map((z) => z.model),
        ingest: ingest.rows.map((z) => ({
          quelle: z.quelle,
          angenommen: Number(z.angenommen),
          verworfen_inhalt: Number(z.verworfen_inhalt),
          verworfen_api: Number(z.verworfen_api),
          verworfen_fremd_org: Number(z.verworfen_fremd_org),
          unzugeordnet: Number(z.unzugeordnet),
        })),
        kontrollsumme: {
          sitzungen: Number(k?.sitzungen ?? 0),
          sitzungen_abweichend: Number(k?.abweichend ?? 0),
          tokens_kontrolle: tokensKontrolle,
          tokens_gezaehlt: tokensGezaehlt,
          prozent: prozent(tokensGezaehlt, tokensKontrolle),
        },
      };
    });
    return antwort;
  });
}
