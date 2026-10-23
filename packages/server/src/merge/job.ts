// Job `merge.ab` (Architektur §3.4): führt Anfragen aus Quelle A und B zusammen, die sich nicht über
// den Schlüssel getroffen haben (A ohne `request_id` → `msg:<client_request_id>`, B ohne `requestId`
// → `msg:<message.id>`). Der Schlüssel-Upsert beim Ingest erledigt alles andere (Bits, Feldvorrang,
// `abweichung_ab` beim ersten Zusammentreffen).
//
// Heuristik (Punkt 2): Zeile Y nur aus B (`quellen = 2`) und Zeile X mit A-Bit, mindestens eine mit
// `msg:`-Schlüssel, gleiche Sitzung, gleiches Modell, `ts` ± 2 s und exakt gleiches Tupel
// (input, output, cache_read, cache_write). Nur eindeutige Paare (1:1) werden zusammengeführt:
// X behält Schlüssel, `ts` und die Tokens aus A, bekommt Bit B, `heuristisch` und die Felder, die nur
// B kennt (5m/1h-Aufteilung, Websuche, Geo, Tier, Subagent, Projekt); Y wird gelöscht.
// Zeilen mit verschiedenem Tupel werden nie zusammengeführt; ist das Paar sonst eindeutig, bekommen
// beide `abweichung_ab` (Tokens A ≠ B, Datenqualität).
// Vollständigkeit (Punkt 4): Σ anfrage je Sitzung gegen `otel_kontrollsumme` im selben Fenster.
// Idempotent: ein zweiter Lauf findet keine B-Zeile mehr, die schon zusammengeführt ist.
import { QUELLE_A, QUELLE_B } from '@seatmeter/shared';
import { sql, type Transaction } from 'kysely';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import type { PluginKontext } from '../plugin.js';

/** Fenster je Lauf (wie das Tagesaggregat): Anfragen der letzten 35 Tage. */
export const MERGE_TAGE = 35;
/** Zeitabstand A ↔ B in Sekunden (Architektur §3.4). */
export const MERGE_TOLERANZ_S = 2;
/** Abweichung der Vollständigkeit, ab der eine Sitzung als abweichend zählt. */
export const ABDECKUNG_TOLERANZ = 0.01;

export interface MergeErgebnis {
  mandanten: number;
  zusammengefuehrt: number;
  mehrdeutig: number;
  abweichung_markiert: number;
  sitzungen_geprueft: number;
  sitzungen_abweichend: number;
  /** Σ gezählt / Σ Kontrollsumme über alle geprüften Sitzungen in %, `null` ohne Kontrollsummen. */
  abdeckung_prozent: number | null;
}

interface Kandidat {
  a_key: string;
  a_ts: Date;
  b_key: string;
  b_ts: Date;
  gleich: boolean;
}

type Trx = Transaction<Datenbank>;

async function kandidaten(trx: Trx, mandantId: string, ab: Date): Promise<Kandidat[]> {
  const r = await sql<Kandidat>`
    SELECT a.anfrage_key AS a_key, a.ts AS a_ts, b.anfrage_key AS b_key, b.ts AS b_ts,
      (a.input = b.input AND a.output = b.output AND a.cache_read = b.cache_read
        AND a.cache_write = b.cache_write) AS gleich
    FROM anfrage b
    JOIN anfrage a
      ON a.mandant_id = b.mandant_id
     AND a.session_id = b.session_id
     AND a.model = b.model
     AND a.ts BETWEEN b.ts - make_interval(secs => ${MERGE_TOLERANZ_S})
                  AND b.ts + make_interval(secs => ${MERGE_TOLERANZ_S})
     AND a.quellen & ${QUELLE_A} = ${QUELLE_A}
     AND a.anfrage_key <> b.anfrage_key
    WHERE b.mandant_id = ${mandantId}::uuid
      AND b.quellen = ${QUELLE_B}
      AND b.session_id IS NOT NULL
      AND b.ts >= ${ab}
      AND (a.anfrage_key LIKE 'msg:%' OR b.anfrage_key LIKE 'msg:%')
    ORDER BY b.anfrage_key, a.anfrage_key`.execute(trx);
  return r.rows;
}

/** Wählt eindeutige Paare: je B genau ein Kandidat und dieser A nur von diesem B beansprucht. */
export function paareWaehlen(liste: Kandidat[]): {
  merge: Kandidat[];
  abweichung: Kandidat[];
  mehrdeutig: number;
} {
  const gleich = liste.filter((k) => k.gleich);
  const zaehle = (l: Kandidat[], f: (k: Kandidat) => string) => {
    const m = new Map<string, number>();
    for (const k of l) m.set(f(k), (m.get(f(k)) ?? 0) + 1);
    return m;
  };
  const jeB = zaehle(gleich, (k) => k.b_key);
  const jeA = zaehle(gleich, (k) => k.a_key);
  const merge = gleich.filter((k) => jeB.get(k.b_key) === 1 && jeA.get(k.a_key) === 1);
  const mehrdeutigeB = new Set(gleich.filter((k) => !merge.includes(k)).map((k) => k.b_key));

  // Ungleiche Tupel: nur markieren, wenn das Paar insgesamt eindeutig ist und kein gleiches Paar existiert.
  const alleJeB = zaehle(liste, (k) => k.b_key);
  const alleJeA = zaehle(liste, (k) => k.a_key);
  const abweichung = liste.filter(
    (k) => !k.gleich && alleJeB.get(k.b_key) === 1 && alleJeA.get(k.a_key) === 1,
  );
  return { merge, abweichung, mehrdeutig: mehrdeutigeB.size };
}

async function sperren(trx: Trx, mandantId: string, schluessel: string[]): Promise<void> {
  // Gleiche Sperre wie der Schlüssel-Upsert beim Ingest; feste Reihenfolge gegen Deadlocks.
  for (const k of [...schluessel].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${mandantId}:${k}`}, 0))`.execute(
      trx,
    );
  }
}

async function zusammenfuehren(trx: Trx, mandantId: string, k: Kandidat): Promise<boolean> {
  await sperren(trx, mandantId, [k.a_key, k.b_key]);
  const r = await sql`
    UPDATE anfrage AS x SET
      quellen = x.quellen | ${QUELLE_B},
      heuristisch = true,
      cache_write_1h = COALESCE(y.cache_write_1h, x.cache_write_1h),
      web_search = y.web_search,
      inference_geo = COALESCE(y.inference_geo, x.inference_geo),
      service_tier = COALESCE(y.service_tier, x.service_tier),
      ist_subagent = COALESCE(y.ist_subagent, x.ist_subagent),
      session_id = COALESCE(x.session_id, y.session_id),
      person_id = COALESCE(x.person_id, y.person_id),
      projekt_id = COALESCE(y.projekt_id, x.projekt_id),
      issue_schluessel = COALESCE(y.issue_schluessel, x.issue_schluessel),
      abweichung_ab = x.abweichung_ab OR y.abweichung_ab
    FROM anfrage AS y
    WHERE x.mandant_id = ${mandantId}::uuid AND x.anfrage_key = ${k.a_key} AND x.ts = ${k.a_ts}
      AND x.quellen & ${QUELLE_A} = ${QUELLE_A}
      AND y.mandant_id = ${mandantId}::uuid AND y.anfrage_key = ${k.b_key} AND y.ts = ${k.b_ts}
      AND y.quellen = ${QUELLE_B}
      AND x.input = y.input AND x.output = y.output
      AND x.cache_read = y.cache_read AND x.cache_write = y.cache_write`.execute(trx);
  if (Number(r.numAffectedRows ?? 0) !== 1) return false;
  await sql`
    DELETE FROM anfrage
    WHERE mandant_id = ${mandantId}::uuid AND anfrage_key = ${k.b_key} AND ts = ${k.b_ts}
      AND quellen = ${QUELLE_B}`.execute(trx);
  return true;
}

async function abweichungMarkieren(trx: Trx, mandantId: string, k: Kandidat): Promise<number> {
  const r = await sql`
    UPDATE anfrage SET abweichung_ab = true
    WHERE mandant_id = ${mandantId}::uuid AND NOT abweichung_ab
      AND ((anfrage_key = ${k.a_key} AND ts = ${k.a_ts}) OR (anfrage_key = ${k.b_key} AND ts = ${k.b_ts}))`.execute(
    trx,
  );
  return Number(r.numAffectedRows ?? 0);
}

export interface Abdeckung {
  sitzungen: number;
  abweichend: number;
  kontrolle: number;
  gezaehlt: number;
}

/**
 * Vollständigkeit je Sitzung (Architektur §3.4 Punkt 4): Σ (input + output + cache_read +
 * cache_write) aller gezählten Anfragen gegen Σ `otel_kontrollsumme` ab `abTag`.
 */
export async function abdeckungJeSitzung(
  trx: Trx,
  mandantId: string,
  abTag: string,
): Promise<Abdeckung> {
  const r = await sql<{
    sitzungen: string;
    abweichend: string;
    kontrolle: string;
    gezaehlt: string;
  }>`
    WITH k AS (
      SELECT session_id, sum(wert)::bigint AS w FROM otel_kontrollsumme
      WHERE mandant_id = ${mandantId}::uuid AND tag >= ${abTag}::date GROUP BY session_id
    ), g AS (
      SELECT session_id, sum(input + output + cache_read + cache_write)::bigint AS w
      FROM anfrage
      WHERE mandant_id = ${mandantId}::uuid AND tag >= ${abTag}::date AND zaehlt_als_abo
        AND session_id IN (SELECT session_id FROM k)
      GROUP BY session_id
    )
    SELECT count(*) AS sitzungen,
      count(*) FILTER (WHERE abs(coalesce(g.w, 0) - k.w) > k.w * ${ABDECKUNG_TOLERANZ}::numeric) AS abweichend,
      coalesce(sum(k.w), 0)::bigint AS kontrolle,
      coalesce(sum(g.w), 0)::bigint AS gezaehlt
    FROM k LEFT JOIN g USING (session_id)`.execute(trx);
  const z = r.rows[0];
  return {
    sitzungen: Number(z?.sitzungen ?? 0),
    abweichend: Number(z?.abweichend ?? 0),
    kontrolle: Number(z?.kontrolle ?? 0),
    gezaehlt: Number(z?.gezaehlt ?? 0),
  };
}

/** Ein Lauf für einen Mandanten (eine Transaktion unter RLS). */
export async function mergeMandant(
  ctx: PluginKontext,
  mandantId: string,
  jetzt = new Date(),
): Promise<
  Omit<MergeErgebnis, 'mandanten' | 'abdeckung_prozent'> & { kontrolle: number; gezaehlt: number }
> {
  const ab = new Date(jetzt.getTime() - MERGE_TAGE * 86_400_000);
  return withMandant(ctx.db, mandantId, async (trx) => {
    const { merge, abweichung, mehrdeutig } = paareWaehlen(await kandidaten(trx, mandantId, ab));
    let zusammengefuehrt = 0;
    for (const k of merge) if (await zusammenfuehren(trx, mandantId, k)) zusammengefuehrt++;
    let markiert = 0;
    for (const k of abweichung) markiert += await abweichungMarkieren(trx, mandantId, k);
    const abd = await abdeckungJeSitzung(trx, mandantId, ab.toISOString().slice(0, 10));
    return {
      zusammengefuehrt,
      mehrdeutig,
      abweichung_markiert: markiert,
      sitzungen_geprueft: abd.sitzungen,
      sitzungen_abweichend: abd.abweichend,
      kontrolle: abd.kontrolle,
      gezaehlt: abd.gezaehlt,
    };
  });
}

/** Job `merge.ab`: alle Mandanten; Ergebnis (nur Zähler) landet in `job_lauf.ergebnis`. */
export async function mergeJob(ctx: PluginKontext, jetzt = new Date()): Promise<MergeErgebnis> {
  const mandanten = await ctx.db.selectFrom('mandant').select('id').execute();
  const e: MergeErgebnis = {
    mandanten: 0,
    zusammengefuehrt: 0,
    mehrdeutig: 0,
    abweichung_markiert: 0,
    sitzungen_geprueft: 0,
    sitzungen_abweichend: 0,
    abdeckung_prozent: null,
  };
  let kontrolle = 0;
  let gezaehlt = 0;
  for (const m of mandanten) {
    const r = await mergeMandant(ctx, m.id, jetzt);
    e.mandanten++;
    e.zusammengefuehrt += r.zusammengefuehrt;
    e.mehrdeutig += r.mehrdeutig;
    e.abweichung_markiert += r.abweichung_markiert;
    e.sitzungen_geprueft += r.sitzungen_geprueft;
    e.sitzungen_abweichend += r.sitzungen_abweichend;
    kontrolle += r.kontrolle;
    gezaehlt += r.gezaehlt;
  }
  if (kontrolle > 0) e.abdeckung_prozent = Math.round((gezaehlt / kontrolle) * 10_000) / 100;
  return e;
}
