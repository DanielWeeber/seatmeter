// Job `aggregation.nah`: heute und gestern je Mandant nahe an der Nutzung, damit das Dashboard nicht bis zum nächsten Morgen
// hinterherhinkt. Dieselbe Rechnung wie der nächtliche Lauf (`tagBerechnen`), aber: Tage ohne Änderung werden gar nicht erst
// gerechnet (Signatur über alle Eingaben), und nur wirklich geänderte Zeilen werden geschrieben. Eine Transaktion je Mandant,
// sonst sähen Leser einen halben Stand. Den Stand der Signaturen hält der Prozess im Speicher: Nach einem Neustart rechnet der
// erste Lauf einmal und schreibt nichts, wenn nichts anders ist. Geld hat so weiter nur eine Quelle.
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Konfiguration } from '../config.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import { aggregiereIssueMonate } from '../issues/aggregat.js';
import type { PluginKontext } from '../plugin.js';
import { ladeEffektivePreistabelle } from '../preise/tabelle.js';
import { tagBerechnen, type TagZeile } from './job.js';
import { aggregationSperreVersuchen } from './sperre.js';
import { heuteIn, plusTage } from './tage.js';

export const AGGREGATION_NAH = 'aggregation.nah';
/** Monate liest das Issue-Aggregat ganz: Das geschieht höchstens so oft, der nächtliche Lauf bleibt die Grundlage. */
const ISSUE_ABSTAND_MS = 3_600_000;
const JE_SCHREIBEN = 500;
/** Solange einer dieser Jobs läuft, setzt der häufige Lauf aus. */
const VORRANG = ['aggregation.tag', 'kalkulation.monatsabschluss'];

/** Cron zum Abstand in Minuten; eine Minute nach `merge.ab`. `null` = aus. */
export function aggregationNahZeitplan(k: Konfiguration): string | null {
  const n = k.SEATMETER_AGGREGATION_INTERVALL_MIN;
  if (n === 0) return null;
  if (n === 1) return '* * * * *';
  return n === 60 ? '1 * * * *' : `1-59/${n} * * * *`;
}

export interface NahErgebnis {
  mandanten: number;
  /** Ein Job mit Vorrang läuft: nichts getan. */
  ausgesetzt: string | null;
  /** Mandanten, an denen gerade jemand anderes arbeitet. */
  gesperrt: number;
  tage_unveraendert: number;
  tage_gerechnet: number;
  anfragen: number;
  zeilen_neu: number;
  zeilen_geaendert: number;
  zeilen_geloescht: number;
  issue_monate: number;
  fehlgeschlagen: number;
}

interface Stand {
  signaturen: Map<string, string>;
  issueOffen: boolean;
  issueZuletzt: number;
}

const staende = new WeakMap<Db, Map<string, Stand>>();

function standVon(db: Db, mandantId: string): Stand {
  let je = staende.get(db);
  if (!je) {
    je = new Map();
    staende.set(db, je);
  }
  let s = je.get(mandantId);
  if (!s) {
    s = { signaturen: new Map(), issueOffen: false, issueZuletzt: 0 };
    je.set(mandantId, s);
  }
  return s;
}

/** Hält gerade jemand die Sperre eines Jobs? Nur nachsehen: Selbst zu sperren könnte den nächtlichen Lauf verdrängen. */
async function laufenderVorrang(db: Db): Promise<string | null> {
  for (const job of VORRANG) {
    const r = await sql<{ belegt: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtext(${`seatmeter:job:${job}`})::bigint
      ) AS belegt`.execute(db);
    if (r.rows[0]?.belegt) return job;
  }
  return null;
}

/** Änderung irgendeiner Eingabe, auch ohne neue Anfrage: `merge.ab` etwa ändert Zeilen, statt neue anzulegen. */
async function eingabeSignaturen(
  trx: Transaction<Datenbank>,
  tage: readonly string[],
): Promise<Map<string, string>> {
  const r = await sql<{ tag: string; n: string; h: string }>`
    SELECT to_char(tag, 'YYYY-MM-DD') AS tag, count(*) AS n,
      sum(hashtextextended(ROW(ts, person_id, projekt_id, model, speed, inference_geo, auth_klasse, input, output,
        cache_read, cache_write, cache_write_1h, web_search, issue_schluessel)::text, 0)::numeric)::text AS h
    FROM anfrage WHERE tag = ANY(${[...tage]}::date[]) AND zaehlt_als_abo
    GROUP BY tag`.execute(trx);
  return new Map(r.rows.map((z) => [z.tag, `${z.n}:${z.h}`]));
}

const schluessel = (z: {
  person_id?: string | null | undefined;
  projekt_id?: string | null | undefined;
  model: string;
  speed?: string | undefined;
  auth_klasse: string;
}) => [z.person_id, z.projekt_id, z.model, z.speed, z.auth_klasse].join('|');

const WERTE = [
  'input',
  'output',
  'cache_read',
  'cache_write',
  'cache_write_1h',
  'web_search',
  'anfragen',
  'schatten_usd_micros',
  'abo_anteil',
] as const;

/** Schreibt nur den Unterschied: 288 Runden Löschen und Einfügen am Tag blähten die Tabelle auf. */
async function tagAbgleichen(
  trx: Transaction<Datenbank>,
  tag: string,
  zeilen: readonly TagZeile[],
  summe: NahErgebnis,
): Promise<void> {
  const alt = await trx.selectFrom('tag_aggregat').selectAll().where('tag', '=', tag).execute();
  const altJe = new Map(alt.map((z) => [schluessel(z), z]));
  const schreiben: TagZeile[] = [];
  for (const z of zeilen) {
    const k = schluessel(z);
    const a = altJe.get(k);
    altJe.delete(k);
    if (!a) {
      summe.zeilen_neu += 1;
      schreiben.push(z);
    } else if (
      WERTE.some((f) => Number(a[f]) !== Number(z[f])) ||
      a.preis_version !== z.preis_version
    ) {
      summe.zeilen_geaendert += 1;
      schreiben.push(z);
    }
  }
  for (let i = 0; i < schreiben.length; i += JE_SCHREIBEN) {
    await trx
      .insertInto('tag_aggregat')
      .values(schreiben.slice(i, i + JE_SCHREIBEN))
      .onConflict((oc) =>
        oc
          .columns([
            'mandant_id',
            'tag',
            'person_id',
            'projekt_id',
            'model',
            'speed',
            'auth_klasse',
          ])
          .doUpdateSet((eb) => ({
            input: eb.ref('excluded.input'),
            output: eb.ref('excluded.output'),
            cache_read: eb.ref('excluded.cache_read'),
            cache_write: eb.ref('excluded.cache_write'),
            cache_write_1h: eb.ref('excluded.cache_write_1h'),
            web_search: eb.ref('excluded.web_search'),
            anfragen: eb.ref('excluded.anfragen'),
            schatten_usd_micros: eb.ref('excluded.schatten_usd_micros'),
            preis_version: eb.ref('excluded.preis_version'),
            abo_anteil: eb.ref('excluded.abo_anteil'),
          })),
      )
      .execute();
  }
  // Was übrig ist, hat keine Anfrage mehr, etwa nach einer Umbuchung durch `merge.ab`.
  for (const z of altJe.values()) {
    await sql`
      DELETE FROM tag_aggregat WHERE tag = ${tag}::date AND model = ${z.model} AND speed = ${z.speed}
        AND auth_klasse = ${z.auth_klasse}
        AND person_id IS NOT DISTINCT FROM ${z.person_id}::uuid
        AND projekt_id IS NOT DISTINCT FROM ${z.projekt_id}::uuid`.execute(trx);
    summe.zeilen_geloescht += 1;
  }
}

async function mandantNah(
  db: Db,
  m: { id: string; zeitzone: string; aufbewahrung_anfrage_tage: number },
  jetzt: Date,
  summe: NahErgebnis,
): Promise<void> {
  const stand = standVon(db, m.id);
  const heute = heuteIn(m.zeitzone, jetzt);
  const ab = plusTage(heute, -(m.aufbewahrung_anfrage_tage - 1));
  // Vor der Aufbewahrung fehlen Einzelanfragen: dort nie neu aufbauen (wie der Neuaufbau auf Anforderung).
  const tage = [plusTage(heute, -1), heute].filter((t) => t >= ab);
  const { preise, annahme, signaturen } = await withMandant(db, m.id, async (trx) => {
    const k = await trx
      .selectFrom('mandant')
      .select('cache_write_annahme')
      .executeTakeFirstOrThrow();
    return {
      preise: await ladeEffektivePreistabelle(trx),
      annahme: k.cache_write_annahme,
      signaturen: await eingabeSignaturen(trx, tage),
    };
  });
  // Auch Preise und Annahme gehen ein: Der nächtliche Lauf rechnete sonst etwas anderes als dieser.
  const preisStand = createHash('sha256')
    .update(JSON.stringify([annahme, preise]))
    .digest('base64url');
  const neu = new Map(tage.map((t) => [t, `${preisStand}:${signaturen.get(t) ?? 'leer'}`]));
  const offen = tage.filter((t) => stand.signaturen.get(t) !== neu.get(t));
  summe.tage_unveraendert += tage.length - offen.length;
  const vorher = summe.zeilen_neu + summe.zeilen_geaendert + summe.zeilen_geloescht;
  if (offen.length > 0) {
    const zwischen = { ...summe };
    const erledigt = await withMandant(db, m.id, async (trx) => {
      if (!(await aggregationSperreVersuchen(trx, m.id))) return false;
      for (const tag of offen) {
        const t = await tagBerechnen(trx, m.id, tag, preise, annahme);
        await tagAbgleichen(trx, tag, t.zeilen, zwischen);
        zwischen.tage_gerechnet += 1;
        zwischen.anfragen += t.anfragen;
      }
      return true;
    });
    if (!erledigt) {
      summe.gesperrt += 1;
      return;
    }
    // Erst nach dem Commit: Eine zurückgerollte Transaktion zählt nicht, und der nächste Lauf versucht es erneut.
    Object.assign(summe, zwischen);
    const bekannt = offen.some((t) => stand.signaturen.has(t));
    stand.signaturen = neu;
    const geschrieben = summe.zeilen_neu + summe.zeilen_geaendert + summe.zeilen_geloescht;
    if (bekannt || geschrieben > vorher) stand.issueOffen = true;
  }
  if (stand.issueOffen && jetzt.getTime() - stand.issueZuletzt >= ISSUE_ABSTAND_MS) {
    const i = await aggregiereIssueMonate(db, m.id, tage[0] ?? heute, heute, {
      preise,
      annahme,
      ab,
      nurWennFrei: true,
    });
    if (i.gesperrt) return;
    stand.issueOffen = false;
    stand.issueZuletzt = jetzt.getTime();
    summe.issue_monate += i.monate.length;
  }
}

function fehlerArt(fehler: unknown): string {
  const klasse = fehler instanceof Error ? fehler.name : typeof fehler;
  const code = (fehler as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${klasse} ${code}` : klasse;
}

/** Job `aggregation.nah`. Ein Mandant hält die anderen nicht auf; am Ende wirft der Job, damit `job_lauf` es zeigt. */
export async function aggregationNahJob(
  ctx: PluginKontext,
  jetzt: Date = new Date(),
  nurMandanten?: readonly string[],
): Promise<NahErgebnis> {
  const summe: NahErgebnis = {
    mandanten: 0,
    ausgesetzt: await laufenderVorrang(ctx.db),
    gesperrt: 0,
    tage_unveraendert: 0,
    tage_gerechnet: 0,
    anfragen: 0,
    zeilen_neu: 0,
    zeilen_geaendert: 0,
    zeilen_geloescht: 0,
    issue_monate: 0,
    fehlgeschlagen: 0,
  };
  if (summe.ausgesetzt) return summe;
  let q = ctx.db.selectFrom('mandant').select(['id', 'zeitzone', 'aufbewahrung_anfrage_tage']);
  if (nurMandanten) q = q.where('id', 'in', [...nurMandanten]);
  const mandanten = await q.execute();
  summe.mandanten = mandanten.length;
  const fehler: string[] = [];
  for (const m of mandanten) {
    try {
      await mandantNah(ctx.db, m, jetzt, summe);
    } catch (f) {
      summe.fehlgeschlagen += 1;
      fehler.push(`${m.id} (${fehlerArt(f)})`);
    }
  }
  if (fehler.length > 0) {
    throw new Error(
      `${AGGREGATION_NAH}: ${fehler.length} von ${mandanten.length} Mandanten fehlgeschlagen: ` +
        fehler.slice(0, 20).join(', '),
    );
  }
  return summe;
}
