// Gemeinsame Schreibpfade für Quelle A (OTLP) und Quelle B (Agent), immer innerhalb von `withMandant`.
// Person (§3.2), Projekt (§3.3), Sitzung, Anfrage (§3.4 Schlüssel-Upsert mit Quellen-Bits) und
// `ingest_statistik`. Die A/B-Heuristik für `msg:`-Schlüssel gehört zum Modul `merge` (Phase 2).
import { sql, type Transaction } from 'kysely';
import {
  QUELLE_A,
  QUELLE_B,
  normalisiereRepoUrl,
  repoInfoAusUrlNorm,
  type AuthKlasse,
  type RepoInfo,
} from '@seatmeter/shared';
import { personKeyEmail, personKeyKonto, projektKey, pseudonym } from '@seatmeter/shared/hmac';
import type { Datenbank } from '../db/schema.js';
import type { MandantKontext } from './kontext.js';

type Trx = Transaction<Datenbank>;

// ---------------------------------------------------------------------------------------------
// Person

export interface PersonKennung {
  /** `user.account_uuid` bzw. `user.account_id` (Primärkennung, §3.2). */
  konto: string | null;
  /** `user.account_id` (getaggte ID der Analytics API, `actor.user_id`); zweite Zuordnung für den Abgleich. */
  kontoId?: string | null;
  /** Nur als HMAC gespeichert; der Rohwert verlässt diese Funktion nicht. */
  email: string | null;
}

/** Schlüssel einer Person, sofort gehasht (Rohwerte werden danach verworfen). */
export interface PersonSchluessel {
  keyKonto: Buffer | null;
  keyEmail: Buffer | null;
  /** HMAC(account_id), nur Quelle A (Spalte `person.key_konto_id`, Abgleich ee). */
  keyKontoId?: Buffer | null;
}

export function personSchluessel(personSalt: Uint8Array, k: PersonKennung): PersonSchluessel {
  const konto = k.konto?.trim() ? k.konto.trim() : null;
  const email = k.email?.trim() ? k.email : null;
  const kontoId = k.kontoId?.trim() ? k.kontoId.trim() : null;
  return {
    keyKonto: konto ? personKeyKonto(personSalt, konto) : null,
    keyEmail: email ? personKeyEmail(personSalt, email) : null,
    keyKontoId: kontoId ? personKeyKonto(personSalt, kontoId) : null,
  };
}

/** Sucht oder legt die Person an (Upsert über `key_konto`, sonst `key_email`) und pflegt Nutzungstage. */
export async function personAufloesen(
  trx: Trx,
  ctx: MandantKontext,
  s: PersonSchluessel,
  tag: string,
  cache: Map<string, string>,
): Promise<string | null> {
  if (!s.keyKonto && !s.keyEmail) return null;
  const cacheKey = `${s.keyKonto?.toString('hex') ?? ''}|${s.keyEmail?.toString('hex') ?? ''}`;
  const bekannt = cache.get(cacheKey);
  if (bekannt) {
    await nutzungstagPflegen(trx, bekannt, tag);
    return bekannt;
  }

  const finden = async () => {
    if (s.keyKonto) {
      const z = await trx
        .selectFrom('person')
        .select(['id', 'key_konto', 'key_email'])
        .where('mandant_id', '=', ctx.mandantId)
        .where('key_konto', '=', s.keyKonto)
        .executeTakeFirst();
      if (z) return z;
    }
    if (s.keyEmail) {
      return trx
        .selectFrom('person')
        .select(['id', 'key_konto', 'key_email'])
        .where('mandant_id', '=', ctx.mandantId)
        .where('key_email', '=', s.keyEmail)
        .executeTakeFirst();
    }
    return undefined;
  };

  let person = await finden();
  if (!person) {
    // Anlegen; Konflikte (gleichzeitiges Anlegen, Pseudonym-Kollision) über DO NOTHING abfangen.
    const basis = s.keyKonto ?? s.keyEmail;
    if (!basis) return null;
    for (let versuch = 0; versuch < 8 && !person; versuch++) {
      const neu = await trx
        .insertInto('person')
        .values({
          mandant_id: ctx.mandantId,
          pseudonym: pseudonym(ctx.personSalt, basis, versuch),
          key_konto: s.keyKonto,
          key_email: s.keyEmail,
          erste_nutzung: tag,
          letzte_nutzung: tag,
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'key_konto', 'key_email'])
        .executeTakeFirst();
      person = neu ?? (await finden());
    }
    if (!person) throw new Error('Person konnte nicht angelegt werden');
  } else {
    // Fehlende Schlüssel nachtragen, aber nie einen Schlüssel einer anderen Person übernehmen.
    if (s.keyKonto && !person.key_konto) {
      // Über die E-Mail gefunden: `finden` hätte eine Person mit diesem Kontoschlüssel zuerst geliefert.
      await trx
        .updateTable('person')
        .set({ key_konto: s.keyKonto })
        .where('id', '=', person.id)
        .where('key_konto', 'is', null)
        .execute();
    }
    if (s.keyEmail && !person.key_email) {
      await sql`
        UPDATE person SET key_email = ${s.keyEmail}
        WHERE id = ${person.id}::uuid AND key_email IS NULL AND NOT EXISTS (
          SELECT 1 FROM person p2
          WHERE p2.mandant_id = ${ctx.mandantId}::uuid AND p2.key_email = ${s.keyEmail})`.execute(
        trx,
      );
    }
  }
  if (s.keyKontoId) {
    // Zweite Zuordnung (account_id) nachtragen, nie die einer anderen Person übernehmen.
    await sql`
      UPDATE person SET key_konto_id = ${s.keyKontoId}
      WHERE id = ${person.id}::uuid AND key_konto_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM person p2
        WHERE p2.mandant_id = ${ctx.mandantId}::uuid AND p2.key_konto_id = ${s.keyKontoId})`.execute(
      trx,
    );
  }
  cache.set(cacheKey, person.id);
  await nutzungstagPflegen(trx, person.id, tag);
  return person.id;
}

async function nutzungstagPflegen(trx: Trx, personId: string, tag: string): Promise<void> {
  await sql`
    UPDATE person SET
      erste_nutzung = LEAST(COALESCE(erste_nutzung, ${tag}::date), ${tag}::date),
      letzte_nutzung = GREATEST(COALESCE(letzte_nutzung, ${tag}::date), ${tag}::date)
    WHERE id = ${personId}::uuid
      AND (erste_nutzung IS NULL OR letzte_nutzung IS NULL
           OR erste_nutzung > ${tag}::date OR letzte_nutzung < ${tag}::date)`.execute(trx);
}

// ---------------------------------------------------------------------------------------------
// Projekt

export interface ProjektRoh {
  /** Repo-URL (A: `vcs.repository.url.full`, B: `url_norm`); wird erneut normalisiert. */
  url: string;
  owner?: string | null;
  repoName?: string | null;
  provider?: string | null;
}

const PROVIDER = new Set(['github', 'gitlab', 'gitea', 'unknown']);

/** Nur lesen: Projekt-ID zur normalisierten URL (Alias zuerst), legt nichts an; `null` = unbekannt. */
export async function projektFinden(
  trx: Trx,
  mandantId: string,
  projektSalt: Buffer,
  urlNorm: string,
): Promise<string | null> {
  const key = projektKey(projektSalt, urlNorm);
  const alias = await trx
    .selectFrom('projekt_alias')
    .select('projekt_id')
    .where('mandant_id', '=', mandantId)
    .where('projekt_key', '=', key)
    .executeTakeFirst();
  if (alias) return alias.projekt_id;
  const p = await trx
    .selectFrom('projekt')
    .select('id')
    .where('mandant_id', '=', mandantId)
    .where('projekt_key', '=', key)
    .executeTakeFirst();
  return p?.id ?? null;
}

/** Projekt-ID zur Repo-URL (Alias zuerst, sonst Upsert über `projekt_key`); `null` = unzugeordnet. */
export async function projektAufloesen(
  trx: Trx,
  ctx: MandantKontext,
  roh: ProjektRoh | null,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!roh) return null;
  const info = normalisiereRepoUrl(roh.url);
  if (!info) return null;
  const bekannt = cache.get(info.urlNorm);
  if (bekannt !== undefined) return bekannt;

  const key = projektKey(ctx.projektSalt, info.urlNorm);
  const alias = await trx
    .selectFrom('projekt_alias')
    .select('projekt_id')
    .where('mandant_id', '=', ctx.mandantId)
    .where('projekt_key', '=', key)
    .executeTakeFirst();
  let id = alias?.projekt_id ?? null;
  if (!id) {
    const providerRoh = roh.provider?.toLowerCase() ?? null;
    const provider =
      providerRoh && PROVIDER.has(providerRoh)
        ? (providerRoh as 'github' | 'gitlab' | 'gitea' | 'unknown')
        : info.provider;
    id = await projektEinfuegen(trx, ctx.mandantId, key, {
      ...info,
      repoName: roh.repoName?.toLowerCase() || info.repoName,
      owner: roh.owner?.toLowerCase() || info.owner,
      provider,
    });
  }
  cache.set(info.urlNorm, id);
  return id;
}

/** Legt das Projekt unter genau diesem Schlüssel an, auch bei gleichzeitigem Anlegen; liefert seine ID. */
async function projektEinfuegen(
  trx: Trx,
  mandantId: string,
  key: Buffer,
  info: RepoInfo,
): Promise<string> {
  const neu = await trx
    .insertInto('projekt')
    .values({
      mandant_id: mandantId,
      projekt_key: key,
      url_norm: info.urlNorm,
      repo_name: info.repoName,
      owner: info.owner,
      provider: info.provider,
    })
    .onConflict((oc) => oc.columns(['mandant_id', 'projekt_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (neu) return neu.id;
  const vorhanden = await trx
    .selectFrom('projekt')
    .select('id')
    .where('mandant_id', '=', mandantId)
    .where('projekt_key', '=', key)
    .executeTakeFirstOrThrow();
  return vorhanden.id;
}

/**
 * Projekt-ID zu einer schon normalisierten URL (Alias zuerst), ohne sie noch einmal zu normalisieren: Die Projektwahl
 * sucht und legt unter genau dem Schlüssel an, den die Prüf-Route gelesen hat. `null`, wenn die URL keine solche Form hat.
 */
export async function projektZuUrlNorm(
  trx: Trx,
  ctx: MandantKontext,
  urlNorm: string,
): Promise<string | null> {
  const info = repoInfoAusUrlNorm(urlNorm);
  if (!info) return null;
  return (
    (await projektFinden(trx, ctx.mandantId, ctx.projektSalt, urlNorm)) ??
    projektEinfuegen(trx, ctx.mandantId, projektKey(ctx.projektSalt, urlNorm), info)
  );
}

/**
 * Projekt-ID zu einem Pfad-Projekt des Agenten (`{ typ: 'pfad', name }`): Schlüssel
 * HMAC(projekt_salt, 'pfad:' + name), `url_norm` NULL, `anzeigename` = name, Provider `pfad`.
 */
export async function pfadProjektAufloesen(
  trx: Trx,
  ctx: MandantKontext,
  name: string,
  cache: Map<string, string | null>,
): Promise<string> {
  const cacheKey = `pfad:${name}`;
  const bekannt = cache.get(cacheKey);
  if (bekannt) return bekannt;
  const key = projektKey(ctx.projektSalt, cacheKey);
  const alias = await trx
    .selectFrom('projekt_alias')
    .select('projekt_id')
    .where('mandant_id', '=', ctx.mandantId)
    .where('projekt_key', '=', key)
    .executeTakeFirst();
  let id = alias?.projekt_id ?? null;
  if (!id) {
    const neu = await trx
      .insertInto('projekt')
      .values({
        mandant_id: ctx.mandantId,
        projekt_key: key,
        url_norm: null,
        repo_name: null,
        owner: null,
        provider: 'pfad',
        anzeigename: name,
      })
      .onConflict((oc) => oc.columns(['mandant_id', 'projekt_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    id =
      neu?.id ??
      (
        await trx
          .selectFrom('projekt')
          .select('id')
          .where('mandant_id', '=', ctx.mandantId)
          .where('projekt_key', '=', key)
          .executeTakeFirstOrThrow()
      ).id;
  }
  cache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Sitzung

export interface SitzungEingang {
  quelle: typeof QUELLE_A | typeof QUELLE_B;
  sessionId: string;
  personId: string | null;
  rechnerId: string | null;
  projektId: string | null;
  orgUuid: string | null;
  authKlasse: AuthKlasse;
  ccVersion: string | null;
  start: Date;
  ende: Date;
}

/** Fasst mehrere Eingänge derselben Sitzung zusammen (frühester Start, spätestes Ende). */
export function sitzungenBuendeln(eingaenge: SitzungEingang[]): SitzungEingang[] {
  const je = new Map<string, SitzungEingang>();
  for (const e of eingaenge) {
    const v = je.get(e.sessionId);
    if (!v) {
      je.set(e.sessionId, { ...e });
      continue;
    }
    if (e.start < v.start) v.start = e.start;
    if (e.ende > v.ende) v.ende = e.ende;
    v.personId ??= e.personId;
    v.projektId ??= e.projektId;
    v.orgUuid ??= e.orgUuid;
    v.ccVersion = e.ccVersion ?? v.ccVersion;
  }
  return [...je.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/**
 * Upsert je (`mandant_id`, `session_id`): Bit der Quelle setzen, Person/Projekt/Org nur ergänzen
 * (erstes Projekt bleibt), Auth-Klasse aus A hat Vorrang vor dem Hinweis aus B.
 */
export async function sitzungSpeichern(
  trx: Trx,
  mandantId: string,
  s: SitzungEingang,
): Promise<void> {
  const ausA = s.quelle === QUELLE_A;
  await sql`
    INSERT INTO sitzung AS si (mandant_id, session_id, person_id, rechner_id, projekt_id, org_uuid,
                               auth_klasse, quellen, cc_version, start, ende)
    VALUES (${mandantId}::uuid, ${s.sessionId}, ${s.personId}::uuid, ${s.rechnerId}::uuid,
            ${s.projektId}::uuid, ${s.orgUuid}::uuid, ${s.authKlasse}, ${s.quelle}, ${s.ccVersion},
            ${s.start}, ${s.ende})
    ON CONFLICT (mandant_id, session_id) DO UPDATE SET
      person_id = ${ausA ? sql`COALESCE(EXCLUDED.person_id, si.person_id)` : sql`COALESCE(si.person_id, EXCLUDED.person_id)`},
      rechner_id = COALESCE(EXCLUDED.rechner_id, si.rechner_id),
      projekt_id = COALESCE(si.projekt_id, EXCLUDED.projekt_id),
      org_uuid = COALESCE(si.org_uuid, EXCLUDED.org_uuid),
      auth_klasse = ${ausA ? sql`EXCLUDED.auth_klasse` : sql`CASE WHEN si.quellen & 1 = 1 THEN si.auth_klasse ELSE EXCLUDED.auth_klasse END`},
      quellen = si.quellen | EXCLUDED.quellen,
      cc_version = COALESCE(EXCLUDED.cc_version, si.cc_version),
      start = LEAST(COALESCE(si.start, EXCLUDED.start), EXCLUDED.start),
      ende = GREATEST(COALESCE(si.ende, EXCLUDED.ende), EXCLUDED.ende)`.execute(trx);
}

// ---------------------------------------------------------------------------------------------
// Anfrage

export interface AnfrageEingang {
  quelle: typeof QUELLE_A | typeof QUELLE_B;
  anfrageKey: string;
  ts: Date;
  tag: string;
  sessionId: string | null;
  personId: string | null;
  projektId: string | null;
  model: string;
  speed: string | null;
  inferenceGeo: string | null;
  serviceTier: string | null;
  querySource: string | null;
  istSubagent: boolean | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Nur Quelle B kennt die 1h-Aufteilung. */
  cacheWrite1h: number | null;
  webSearch: number;
  authKlasse: AuthKlasse;
  zaehltAlsAbo: boolean;
  ccKostenUsdMicros: number | null;
  /**
   * Issue-Schlüssel (nie der Branch-Name), bereits geprüft und nach der Positivliste des Mandanten
   * gefiltert; `null` = unbekannt, `[]` = Branch ohne Schlüssel. Vorrang B (je Transkriptzeile) vor A
   * (Branch beim Sitzungsstart).
   */
  issueSchluessel?: string[] | null;
}

export type AnfrageErgebnis = 'neu' | 'ergaenzt' | 'wiederholt';

interface AnfrageZeile {
  ts: Date;
  quellen: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Schlüssel-Upsert (Architektur §3.4, Punkt 1 und 3). Die Tabelle ist nach `ts` partitioniert,
 * der Primärschlüssel enthält `ts`; deshalb sucht der Upsert eine vorhandene Zeile über
 * (`mandant_id`, `anfrage_key`) in einem Fenster von ±1 Tag und aktualisiert sie, statt an
 * Monatsgrenzen blind einzufügen. Ein Advisory-Lock je Schlüssel verhindert Doppelzeilen bei
 * gleichzeitigen Pushes aus A und B. Feldvorrang: Tokens, Person, Auth-Klasse aus A; Projekt,
 * 5m/1h-Aufteilung, Geo/Tier aus B.
 */
export async function anfrageSpeichern(
  trx: Trx,
  mandantId: string,
  e: AnfrageEingang,
): Promise<AnfrageErgebnis> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${mandantId}:${e.anfrageKey}`}, 0))`.execute(
    trx,
  );
  const vorhanden = (
    await sql<AnfrageZeile>`
      SELECT ts, quellen, input, output, cache_read, cache_write FROM anfrage
      WHERE mandant_id = ${mandantId}::uuid AND anfrage_key = ${e.anfrageKey}
        AND ts BETWEEN ${e.ts}::timestamptz - interval '1 day' AND ${e.ts}::timestamptz + interval '1 day'
      ORDER BY ts LIMIT 1`.execute(trx)
  ).rows[0];

  if (!vorhanden) {
    await trx
      .insertInto('anfrage')
      .values({
        mandant_id: mandantId,
        anfrage_key: e.anfrageKey,
        ts: e.ts,
        tag: e.tag,
        session_id: e.sessionId,
        person_id: e.personId,
        projekt_id: e.projektId,
        model: e.model,
        speed: e.speed,
        inference_geo: e.inferenceGeo,
        service_tier: e.serviceTier,
        query_source: e.querySource,
        ist_subagent: e.istSubagent,
        input: e.input,
        output: e.output,
        cache_read: e.cacheRead,
        cache_write: e.cacheWrite,
        cache_write_1h: e.cacheWrite1h,
        web_search: e.webSearch,
        quellen: e.quelle,
        auth_klasse: e.authKlasse,
        zaehlt_als_abo: e.zaehltAlsAbo,
        cc_kosten_usd_micros: e.ccKostenUsdMicros,
        issue_schluessel: e.issueSchluessel ?? null,
      })
      .execute();
    return 'neu';
  }

  const hatteBit = (vorhanden.quellen & e.quelle) !== 0;
  const andere = e.quelle === QUELLE_A ? QUELLE_B : QUELLE_A;
  // Erstes Zusammentreffen von A und B: Tokens vergleichen (danach bleibt das Kennzeichen stehen).
  const ersterAbgleich = !hatteBit && (vorhanden.quellen & andere) !== 0;
  const abweichung =
    ersterAbgleich &&
    (Number(vorhanden.input) !== e.input ||
      Number(vorhanden.output) !== e.output ||
      Number(vorhanden.cache_read) !== e.cacheRead ||
      Number(vorhanden.cache_write) !== e.cacheWrite);
  const habenA = ((vorhanden.quellen | e.quelle) & QUELLE_A) !== 0;

  // A überschreibt Tokens immer; B nur, solange keine A-Daten vorliegen.
  const tokensUebernehmen = e.quelle === QUELLE_A || !habenA;
  const wo = sql`WHERE mandant_id = ${mandantId}::uuid AND anfrage_key = ${e.anfrageKey} AND ts = ${vorhanden.ts}`;
  const issue = e.issueSchluessel ?? null;
  if (e.quelle === QUELLE_A) {
    await sql`
      UPDATE anfrage SET
        quellen = quellen | ${QUELLE_A},
        input = ${e.input}, output = ${e.output}, cache_read = ${e.cacheRead},
        cache_write = ${e.cacheWrite},
        model = ${e.model},
        session_id = COALESCE(${e.sessionId}, session_id),
        person_id = COALESCE(${e.personId}::uuid, person_id),
        projekt_id = CASE WHEN quellen & ${QUELLE_B} = ${QUELLE_B}
                          THEN COALESCE(projekt_id, ${e.projektId}::uuid)
                          ELSE COALESCE(${e.projektId}::uuid, projekt_id) END,
        speed = COALESCE(${e.speed}, speed),
        query_source = COALESCE(${e.querySource}, query_source),
        auth_klasse = ${e.authKlasse},
        zaehlt_als_abo = ${e.zaehltAlsAbo},
        cc_kosten_usd_micros = COALESCE(${e.ccKostenUsdMicros}::bigint, cc_kosten_usd_micros),
        issue_schluessel = CASE WHEN quellen & ${QUELLE_B} = ${QUELLE_B}
                                THEN COALESCE(issue_schluessel, ${issue}::text[])
                                ELSE COALESCE(${issue}::text[], issue_schluessel) END,
        abweichung_ab = abweichung_ab OR ${abweichung}
      ${wo}`.execute(trx);
  } else {
    await sql`
      UPDATE anfrage SET
        quellen = quellen | ${QUELLE_B},
        ${
          tokensUebernehmen
            ? sql`input = ${e.input}, output = ${e.output}, cache_read = ${e.cacheRead},
                  cache_write = ${e.cacheWrite}, model = ${e.model},
                  auth_klasse = ${e.authKlasse}, zaehlt_als_abo = ${e.zaehltAlsAbo},
                  speed = COALESCE(${e.speed}, speed),`
            : sql``
        }
        cache_write_1h = ${e.cacheWrite1h}::bigint,
        web_search = ${e.webSearch},
        inference_geo = COALESCE(${e.inferenceGeo}, inference_geo),
        service_tier = COALESCE(${e.serviceTier}, service_tier),
        ist_subagent = COALESCE(${e.istSubagent}::boolean, ist_subagent),
        session_id = COALESCE(session_id, ${e.sessionId}),
        person_id = COALESCE(person_id, ${e.personId}::uuid),
        projekt_id = COALESCE(${e.projektId}::uuid, projekt_id),
        issue_schluessel = COALESCE(${issue}::text[], issue_schluessel),
        abweichung_ab = abweichung_ab OR ${abweichung}
      ${wo}`.execute(trx);
  }
  return hatteBit ? 'wiederholt' : 'ergaenzt';
}

// ---------------------------------------------------------------------------------------------
// Statistik

export interface StatistikZaehler {
  angenommen: number;
  verworfen_inhalt: number;
  verworfen_api: number;
  verworfen_fremd_org: number;
  unzugeordnet: number;
}

export function leereStatistik(): StatistikZaehler {
  return {
    angenommen: 0,
    verworfen_inhalt: 0,
    verworfen_api: 0,
    verworfen_fremd_org: 0,
    unzugeordnet: 0,
  };
}

/** Addiert die Zähler auf (`mandant_id`, `tag` = Annahmetag in Mandanten-Zeitzone, `quelle`). */
export async function statistikErhoehen(
  trx: Trx,
  mandantId: string,
  tag: string,
  quelle: 'a' | 'b',
  z: StatistikZaehler,
): Promise<void> {
  await trx
    .insertInto('ingest_statistik')
    .values({ mandant_id: mandantId, tag, quelle, ...z, zuletzt: new Date() })
    .onConflict((oc) =>
      oc.columns(['mandant_id', 'tag', 'quelle']).doUpdateSet({
        angenommen: sql`ingest_statistik.angenommen + EXCLUDED.angenommen`,
        verworfen_inhalt: sql`ingest_statistik.verworfen_inhalt + EXCLUDED.verworfen_inhalt`,
        verworfen_api: sql`ingest_statistik.verworfen_api + EXCLUDED.verworfen_api`,
        verworfen_fremd_org: sql`ingest_statistik.verworfen_fremd_org + EXCLUDED.verworfen_fremd_org`,
        unzugeordnet: sql`ingest_statistik.unzugeordnet + EXCLUDED.unzugeordnet`,
        zuletzt: sql`GREATEST(ingest_statistik.zuletzt, EXCLUDED.zuletzt)`,
      }),
    )
    .execute();
}

const zuletztGemeldet = new Map<string, number>();

/** Pflegt `ingest_token.zuletzt_genutzt` und `rechner.zuletzt_gesehen`, höchstens einmal je Minute. */
export async function nutzungVermerken(
  trx: Trx,
  tokenId: string,
  rechnerId: string | null,
  agentVersion?: string,
): Promise<void> {
  const jetzt = Date.now();
  if (!agentVersion && jetzt - (zuletztGemeldet.get(tokenId) ?? 0) < 60_000) return;
  zuletztGemeldet.set(tokenId, jetzt);
  await trx
    .updateTable('ingest_token')
    .set({ zuletzt_genutzt: new Date(jetzt) })
    .where('id', '=', tokenId)
    .execute();
  if (rechnerId) {
    await trx
      .updateTable('rechner')
      .set({
        zuletzt_gesehen: new Date(jetzt),
        ...(agentVersion ? { agent_version: agentVersion } : {}),
      })
      .where('id', '=', rechnerId)
      .execute();
  }
}
