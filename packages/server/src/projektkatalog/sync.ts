// Letzte Synchronisation und Signal, wenn sie ausbleibt. Ein Lauf des Quellsystems sind tausende Anfragen, darum schreibt
// der Push nicht je Anfrage in dieselbe Zeile: Zähler, letzte Nutzung des Tokens und `zuletzt_sync` sammelt ein Puffer im
// Speicher und schreibt sie gebündelt (spätestens nach 15 s, vor jedem Lesen und beim Beenden). Stirbt der Prozess, fehlen
// höchstens diese Sekunden in den Zählern; die Projekte selbst sind dann längst gespeichert.
//
// Job `projektkatalog.sync` (stündlich): Alarm einmal je Ausfall über die Alarmkanäle, optional veraltete Projekte
// deaktivieren, je Tag und Token eine Audit-Zeile.
import {
  KATALOG_DEAKTIVIEREN_MAX_PROZENT,
  KATALOG_INAKTIV_STATUS_STANDARD,
  KATALOG_SYNC_WARNUNG_STUNDEN,
} from '@seatmeter/shared';
import type { KatalogSyncStand, KatalogSyncStatus } from '@seatmeter/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { protokolliere } from '../audit/protokoll.js';
import {
  kanalDaten,
  ladeKanaele,
  zustellen,
  type AlarmNachricht,
  type KanalDaten,
  type ZustellOptionen,
} from '../budgets/kanal.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { PluginKontext } from '../plugin.js';
import { AUDIT_KATALOG } from './audit.js';
import type { KatalogTrx } from './daten.js';

export type PushErgebnis = 'neu' | 'aktualisiert' | 'unveraendert';

const LEEREN_NACH_MS = 15_000;
const STUNDE_MS = 3_600_000;
const TAG_MS = 24 * STUNDE_MS;
/** So lange bleiben Tageszähler stehen. */
const ZAEHLER_TAGE = 90;
/** SQLSTATE: Der Mandant ist inzwischen gelöscht. */
const FREMDSCHLUESSEL_FEHLT = '23503';

interface Zaehler {
  mandantId: string;
  tokenId: string;
  tag: string;
  neu: number;
  aktualisiert: number;
  unveraendert: number;
  abgelehnt: number;
  zeit: Date;
}

export class KatalogSyncPuffer {
  private zaehler = new Map<string, Zaehler>();
  private zuletzt = new Map<string, Date>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private kette: Promise<void> = Promise.resolve();
  private log: FastifyBaseLogger | null = null;

  constructor(private readonly db: Db) {}

  /** `abgelehnt`: gültiges Token, aber nicht 200. Das zählt mit, ist aber kein Lebenszeichen der Quelle. */
  merken(
    mandantId: string,
    tokenId: string,
    ergebnis: PushErgebnis | 'abgelehnt',
    jetzt = new Date(),
    log?: FastifyBaseLogger,
  ): void {
    if (log) this.log = log;
    const tag = jetzt.toISOString().slice(0, 10);
    const schluessel = `${mandantId}|${tokenId}|${tag}`;
    let z = this.zaehler.get(schluessel);
    if (!z) {
      z = {
        mandantId,
        tokenId,
        tag,
        neu: 0,
        aktualisiert: 0,
        unveraendert: 0,
        abgelehnt: 0,
        zeit: jetzt,
      };
      this.zaehler.set(schluessel, z);
    }
    z[ergebnis] += 1;
    z.zeit = jetzt;
    if (ergebnis !== 'abgelehnt') this.zuletzt.set(mandantId, jetzt);
    this.planen();
  }

  private planen(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.leeren();
    }, LEEREN_NACH_MS);
    this.timer.unref();
  }

  /** Schreibt alles Gesammelte; läuft schon ein Schreiben, reiht es sich dahinter ein. */
  leeren(): Promise<void> {
    this.kette = this.kette.then(() => this.schreiben());
    return this.kette;
  }

  private async schreiben(): Promise<void> {
    if (this.zaehler.size === 0 && this.zuletzt.size === 0) return;
    const zaehler = [...this.zaehler.values()];
    const zuletzt = this.zuletzt;
    this.zaehler = new Map();
    this.zuletzt = new Map();
    const mandanten = new Set([...zaehler.map((z) => z.mandantId), ...zuletzt.keys()]);
    for (const mandantId of mandanten) {
      const eigene = zaehler.filter((z) => z.mandantId === mandantId);
      const zeit = zuletzt.get(mandantId) ?? null;
      try {
        await withMandant(this.db, mandantId, (trx) =>
          tenantSchreiben(trx, mandantId, zeit, eigene),
        );
      } catch (fehler) {
        // Mandant gelöscht: Die Zähler haben kein Ziel mehr, ein neuer Versuch liefe ewig ins Leere.
        if ((fehler as { code?: unknown }).code === FREMDSCHLUESSEL_FEHLT) continue;
        // Nicht verlieren: beim nächsten Mal erneut versuchen.
        for (const z of eigene) {
          const s = `${z.mandantId}|${z.tokenId}|${z.tag}`;
          const a = this.zaehler.get(s);
          if (a) {
            a.neu += z.neu;
            a.aktualisiert += z.aktualisiert;
            a.unveraendert += z.unveraendert;
            a.abgelehnt += z.abgelehnt;
          } else this.zaehler.set(s, z);
        }
        if (zeit && !this.zuletzt.has(mandantId)) this.zuletzt.set(mandantId, zeit);
        this.log?.warn({ err: fehler, mandantId }, 'Katalog-Sync: Zähler nicht geschrieben');
        this.planen();
      }
    }
  }
}

async function tenantSchreiben(
  trx: KatalogTrx,
  mandantId: string,
  zeit: Date | null,
  zaehler: readonly Zaehler[],
): Promise<void> {
  for (const z of zaehler) {
    await trx
      .insertInto('katalog_sync_tag')
      .values({
        mandant_id: mandantId,
        tag: z.tag,
        token_id: z.tokenId,
        neu: z.neu,
        aktualisiert: z.aktualisiert,
        unveraendert: z.unveraendert,
        abgelehnt: z.abgelehnt,
      })
      .onConflict((oc) =>
        oc.columns(['mandant_id', 'tag', 'token_id']).doUpdateSet({
          neu: sql`katalog_sync_tag.neu + excluded.neu`,
          aktualisiert: sql`katalog_sync_tag.aktualisiert + excluded.aktualisiert`,
          unveraendert: sql`katalog_sync_tag.unveraendert + excluded.unveraendert`,
          abgelehnt: sql`katalog_sync_tag.abgelehnt + excluded.abgelehnt`,
        }),
      )
      .execute();
    await trx
      .updateTable('katalog_import_token')
      .set({ zuletzt_genutzt: z.zeit })
      .where('id', '=', z.tokenId)
      .execute();
  }
  // Eine abgelehnte Anfrage ist kein Lebenszeichen, nur erfolgreiche zählen.
  if (zeit) await syncZeitSetzen(trx, mandantId, zeit, { push: true });
}

/**
 * Merkt die letzte automatische Synchronisation, ohne eine neuere zu überschreiben. `push`: auch der Zeitpunkt, an dem
 * das Altern der Projekte gemessen wird; eine Teilliste per CSV hält die Quelle dafür nicht am Leben.
 */
export async function syncZeitSetzen(
  trx: KatalogTrx,
  mandantId: string,
  zeit: Date,
  o: { push?: boolean } = {},
): Promise<void> {
  const groesste = sql<Date>`greatest(mandant_projektkatalog.zuletzt_sync, excluded.zuletzt_sync)`;
  await trx
    .insertInto('mandant_projektkatalog')
    .values({
      mandant_id: mandantId,
      zuletzt_sync: zeit,
      ...(o.push ? { zuletzt_push: zeit } : {}),
    })
    .onConflict((oc) =>
      oc.column('mandant_id').doUpdateSet({
        zuletzt_sync: groesste,
        ...(o.push
          ? {
              zuletzt_push: sql<Date>`greatest(mandant_projektkatalog.zuletzt_push, excluded.zuletzt_push)`,
            }
          : {}),
      }),
    )
    .execute();
}

/** Dieselbe Sperre je Mandant wie beim Import: Listen-Import und Job rechnen nie gegen denselben alten Stand. */
export async function katalogSperren(trx: KatalogTrx, mandantId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`katalog-import:${mandantId}`}, 0))`.execute(
    trx,
  );
}

const puffer = new WeakMap<Db, KatalogSyncPuffer>();

/** Ein Puffer je Datenbank: Route und Job sehen denselben. */
export function syncPuffer(db: Db): KatalogSyncPuffer {
  let p = puffer.get(db);
  if (!p) {
    p = new KatalogSyncPuffer(db);
    puffer.set(db, p);
  }
  return p;
}

/** Eingestellte Liste klein geschrieben; `null`/fehlend = Standardliste. */
export function inaktivListe(gespeichert: readonly string[] | null | undefined): string[] {
  return (gespeichert ?? KATALOG_INAKTIV_STATUS_STANDARD).map((s) => s.trim().toLowerCase());
}

export interface SyncBewertung {
  status: KatalogSyncStatus;
  alterStunden: number | null;
}

/**
 * Bewertet erst, wenn ein Token existiert oder schon synchronisiert wurde. Ohne bisherige Synchronisation zählt das
 * Alter des ältesten aktiven Tokens als Frist für die Einrichtung.
 */
export function syncBewerten(
  warnungStunden: number | null,
  zuletztSync: Date | null,
  aeltestesToken: Date | null,
  jetzt = new Date(),
): SyncBewertung {
  const alterStunden = zuletztSync
    ? Math.round(((jetzt.getTime() - zuletztSync.getTime()) / STUNDE_MS) * 10) / 10
    : null;
  if (warnungStunden === null) return { status: 'aus', alterStunden };
  const bezug = zuletztSync ?? aeltestesToken;
  if (!bezug) return { status: 'nicht_bewertet', alterStunden };
  const veraltet = jetzt.getTime() - bezug.getTime() > warnungStunden * STUNDE_MS;
  return { status: veraltet ? 'veraltet' : 'ok', alterStunden };
}

interface Einstellung {
  zuletzt_sync: Date | null;
  sync_warnung_stunden: number | null;
  sync_deaktivieren_tage: number | null;
  sync_deaktivieren_max_prozent: number;
  sync_bremse_seit: Date | null;
}

const warnungAus = (e: Pick<Einstellung, 'sync_warnung_stunden'> | undefined) =>
  e ? e.sync_warnung_stunden : KATALOG_SYNC_WARNUNG_STUNDEN;

async function bewerten(trx: KatalogTrx, e: Einstellung | undefined, jetzt: Date) {
  const token = await trx
    .selectFrom('katalog_import_token')
    .select('erstellt')
    .where('widerrufen', 'is', null)
    .orderBy('erstellt')
    .limit(1)
    .executeTakeFirst();
  return syncBewerten(
    warnungAus(e),
    e?.zuletzt_sync ? new Date(e.zuletzt_sync) : null,
    token ? new Date(token.erstellt) : null,
    jetzt,
  );
}

/** Stand für Seite und Status-Route. */
export async function syncStandLaden(
  trx: KatalogTrx,
  e: Einstellung | undefined,
  jetzt = new Date(),
): Promise<KatalogSyncStand & { alter_stunden: number | null }> {
  const b = await bewerten(trx, e, jetzt);
  const seit = new Date(jetzt.getTime() - 6 * TAG_MS).toISOString().slice(0, 10);
  const tage = await sql<{
    tag: string;
    neu: string;
    aktualisiert: string;
    unveraendert: string;
    abgelehnt: string;
  }>`
    SELECT to_char(tag, 'YYYY-MM-DD') AS tag, sum(neu) AS neu, sum(aktualisiert) AS aktualisiert,
      sum(unveraendert) AS unveraendert, sum(abgelehnt) AS abgelehnt
    FROM katalog_sync_tag WHERE tag >= ${seit}::date GROUP BY tag ORDER BY tag DESC`.execute(trx);
  return {
    status: b.status,
    alter_stunden: b.alterStunden,
    zuletzt_sync: e?.zuletzt_sync ? new Date(e.zuletzt_sync).toISOString() : null,
    warnung_stunden: warnungAus(e),
    deaktivieren_tage: e?.sync_deaktivieren_tage ?? null,
    deaktivieren_max_prozent: e?.sync_deaktivieren_max_prozent ?? KATALOG_DEAKTIVIEREN_MAX_PROZENT,
    bremse_aktiv: Boolean(e?.sync_bremse_seit),
    tage: tage.rows.map((z) => ({
      tag: z.tag,
      neu: Number(z.neu),
      aktualisiert: Number(z.aktualisiert),
      unveraendert: Number(z.unveraendert),
      abgelehnt: Number(z.abgelehnt),
    })),
  };
}

export interface SyncJobOptionen {
  jetzt?: Date;
  /** Nur diese Mandanten (Tests, Anstoß von Hand). */
  mandantId?: string;
  mandantIds?: readonly string[];
  zustell?: ZustellOptionen;
}

export interface SyncJobErgebnis {
  mandanten: number;
  veraltet: number;
  alarme: number;
  zustellfehler: number;
  deaktiviert: number;
  /** Quelle ist still: Deaktivieren bewusst übersprungen. */
  uebersprungen: number;
  /** Lauf hätte zu viele Projekte deaktiviert und hat angehalten. */
  gebremst: number;
  tageszeilen: number;
  fehlgeschlagen: number;
}

type Merker = 'sync_alarm_seit' | 'sync_bremse_seit';

interface OffenerAlarm {
  nachricht: AlarmNachricht;
  merker: Merker;
  /** Audit, sobald der Alarm erledigt ist. */
  audit?: string;
}

function alarmLink(oeffentlich: string | undefined): string | null {
  return oeffentlich ? new URL('/einrichtung/projektkatalog', oeffentlich).toString() : null;
}

function alarmNachricht(
  mandantId: string,
  e: Pick<Einstellung, 'zuletzt_sync' | 'sync_warnung_stunden'> | undefined,
  oeffentlich: string | undefined,
): AlarmNachricht {
  const zuletzt = e?.zuletzt_sync ? new Date(e.zuletzt_sync).toISOString() : null;
  return {
    // Mit dem Beginn des Ausfalls: Ein neuer Ausfall ist ein neuer Vorfall, kein alter wieder offen.
    schluessel: `seatmeter|katalog-sync|${mandantId}|${zuletzt ?? 'nie'}`,
    ereignis: 'seatmeter.katalog_sync',
    titel: 'Projektkatalog: Synchronisation bleibt aus',
    zeilen: [
      zuletzt ? `Letzte Synchronisation: ${zuletzt}` : 'Noch keine Synchronisation',
      `Warnung nach: ${warnungAus(e)} Stunden`,
      'Bitte den Lauf im Quellsystem prüfen',
    ],
    link: alarmLink(oeffentlich),
    daten: { zuletzt_sync: zuletzt, warnung_stunden: warnungAus(e) },
  };
}

function bremsNachricht(
  mandantId: string,
  kandidaten: number,
  aktive: number,
  prozent: number,
  zuletztPush: Date,
  oeffentlich: string | undefined,
): AlarmNachricht {
  return {
    schluessel: `seatmeter|katalog-bremse|${mandantId}|${zuletztPush.toISOString()}`,
    ereignis: 'seatmeter.katalog_bremse',
    titel: 'Projektkatalog: Deaktivieren angehalten',
    zeilen: [
      `Der Lauf hätte ${kandidaten} von ${aktive} aktiven Projekten deaktiviert`,
      `Grenze: ${prozent} %`,
      'Vermutlich ist der Lauf im Quellsystem abgebrochen, bitte prüfen',
    ],
    link: alarmLink(oeffentlich),
    daten: { anzahl: kandidaten, aktiv: aktive, grenze_prozent: prozent },
  };
}

export async function syncJob(
  ctx: PluginKontext,
  o: SyncJobOptionen = {},
): Promise<SyncJobErgebnis> {
  const { db } = ctx;
  const jetzt = o.jetzt ?? new Date();
  await syncPuffer(db).leeren();
  let q = db.selectFrom('mandant').select('id');
  if (o.mandantId) q = q.where('id', '=', o.mandantId);
  if (o.mandantIds) q = q.where('id', 'in', [...o.mandantIds]);
  const mandanten = await q.execute();
  const summe: SyncJobErgebnis = {
    mandanten: mandanten.length,
    veraltet: 0,
    alarme: 0,
    zustellfehler: 0,
    deaktiviert: 0,
    uebersprungen: 0,
    gebremst: 0,
    tageszeilen: 0,
    fehlgeschlagen: 0,
  };
  const heute = jetzt.toISOString().slice(0, 10);
  const fehlgeschlagen: string[] = [];
  for (const { id } of mandanten) {
    // Ein Mandant darf die anderen nicht aufhalten. Am Ende wirft der Job, damit `job_lauf` den Fehler zeigt.
    try {
      await mandantPruefen(ctx, id, jetzt, heute, summe, o);
    } catch {
      summe.fehlgeschlagen += 1;
      fehlgeschlagen.push(id);
    }
  }
  if (fehlgeschlagen.length > 0) {
    throw new Error(
      `projektkatalog.sync: ${fehlgeschlagen.length} von ${mandanten.length} Mandanten fehlgeschlagen: ` +
        fehlgeschlagen.slice(0, 20).join(', '),
    );
  }
  return summe;
}

async function mandantPruefen(
  ctx: PluginKontext,
  id: string,
  jetzt: Date,
  heute: string,
  summe: SyncJobErgebnis,
  o: SyncJobOptionen,
): Promise<void> {
  const { db, konfiguration } = ctx;
  const oeffentlich = konfiguration.SEATMETER_PUBLIC_URL;
  const { alarme, kanaele } = await withMandant(db, id, async (trx) => {
    // Vor dem ersten Lesen: Ein laufender Import und dieser Lauf rechnen nie gegen denselben alten Stand.
    await katalogSperren(trx, id);
    const e = await trx.selectFrom('mandant_projektkatalog').selectAll().executeTakeFirst();
    const b = await bewerten(trx, e, jetzt);
    const offen: OffenerAlarm[] = [];
    if (b.status === 'veraltet') {
      summe.veraltet += 1;
      if (!e?.sync_alarm_seit) {
        offen.push({ nachricht: alarmNachricht(id, e, oeffentlich), merker: 'sync_alarm_seit' });
      }
    } else if (e?.sync_alarm_seit) {
      // Wieder frisch: Beim nächsten Ausfall gibt es einen neuen Alarm, eine Entwarnung nicht.
      await trx.updateTable('mandant_projektkatalog').set({ sync_alarm_seit: null }).execute();
    }

    const bremse = await veralteteDeaktivieren(trx, e, jetzt, summe);
    if (bremse) {
      summe.gebremst += 1;
      if (!e?.sync_bremse_seit) {
        offen.push({
          nachricht: bremsNachricht(
            id,
            bremse.kandidaten,
            bremse.aktive,
            bremse.prozent,
            bremse.zuletztPush,
            oeffentlich,
          ),
          merker: 'sync_bremse_seit',
          audit: `anzahl:${bremse.kandidaten} aktiv:${bremse.aktive} grenze:${bremse.prozent}%`,
        });
      }
    } else if (e?.sync_bremse_seit) {
      await trx.updateTable('mandant_projektkatalog').set({ sync_bremse_seit: null }).execute();
    }

    await tageszeilenSchreiben(trx, heute, summe);
    const alt = new Date(jetzt.getTime() - ZAEHLER_TAGE * TAG_MS).toISOString().slice(0, 10);
    await trx.deleteFrom('katalog_sync_tag').where('tag', '<', alt).execute();
    const kanaele: KanalDaten[] =
      offen.length > 0
        ? (await ladeKanaele(trx, true)).map((k) =>
            kanalDaten(konfiguration.SEATMETER_MASTER_KEY, k),
          )
        : [];
    return { alarme: offen, kanaele };
  });

  for (const alarm of alarme) {
    // Außerhalb der Transaktion zustellen. Der Merker verhindert Wiederholungen; scheitern alle Kanäle, versucht es der
    // nächste Lauf erneut. Ohne Kanal gilt der Alarm als erledigt, die Seite zeigt ihn trotzdem.
    let zugestellt = 0;
    for (const k of kanaele) {
      try {
        await zustellen(k, alarm.nachricht, o.zustell);
        zugestellt += 1;
      } catch {
        summe.zustellfehler += 1;
      }
    }
    if (zugestellt === 0 && kanaele.length > 0) continue;
    summe.alarme += 1;
    await withMandant(db, id, async (trx) => {
      await trx
        .insertInto('mandant_projektkatalog')
        .values({ mandant_id: id, [alarm.merker]: jetzt })
        .onConflict((oc) => oc.column('mandant_id').doUpdateSet({ [alarm.merker]: jetzt }))
        .execute();
      if (alarm.audit) {
        await protokolliere(trx, {
          benutzerId: null,
          aktion: AUDIT_KATALOG.deaktivierenAngehalten,
          objekt: alarm.audit,
        });
      }
    });
  }
}

/**
 * Optional: Projekte, die das Quellsystem nicht mehr sendet, werden inaktiv. Nur per Push angelegte oder gesendete
 * (`quelle = 'api'`). Das Alter zählt gegen den letzten Push, nicht gegen die Uhr: Verstummt die Quelle, altert nichts.
 * Zusätzlich drei Riegel: Quelle still (älter als die Warnfrist), Tage nicht eingestellt, und die Bremse, wenn ein Lauf
 * mehr als den eingestellten Anteil der aktiven Projekte träfe. Dann war der Lauf der Quelle vermutlich abgebrochen.
 */
async function veralteteDeaktivieren(
  trx: KatalogTrx,
  e: (Einstellung & { zuletzt_push: Date | null }) | undefined,
  jetzt: Date,
  summe: SyncJobErgebnis,
): Promise<{ kandidaten: number; aktive: number; prozent: number; zuletztPush: Date } | null> {
  const tage = e?.sync_deaktivieren_tage ?? null;
  if (tage === null) return null;
  const frist = (e?.sync_warnung_stunden ?? KATALOG_SYNC_WARNUNG_STUNDEN) * STUNDE_MS;
  const zuletztPush = e?.zuletzt_push ? new Date(e.zuletzt_push) : null;
  if (zuletztPush === null || jetzt.getTime() - zuletztPush.getTime() > frist) {
    summe.uebersprungen += 1;
    return null;
  }
  const grenze = new Date(zuletztPush.getTime() - tage * TAG_MS);
  const zahlen = await sql<{ kandidaten: number; aktive: number }>`
    SELECT
      (count(*) FILTER (WHERE quelle = 'api' AND zuletzt_gesehen < ${grenze}))::int AS kandidaten,
      count(*)::int AS aktive
    FROM katalog_projekt WHERE aktiv`.execute(trx);
  const kandidaten = Number(zahlen.rows[0]?.kandidaten ?? 0);
  const aktive = Number(zahlen.rows[0]?.aktive ?? 0);
  if (kandidaten === 0) return null;
  const prozent = e?.sync_deaktivieren_max_prozent ?? KATALOG_DEAKTIVIEREN_MAX_PROZENT;
  if (kandidaten * 100 > prozent * aktive) return { kandidaten, aktive, prozent, zuletztPush };
  const r = await trx
    .updateTable('katalog_projekt')
    .set({ aktiv: false })
    .where('aktiv', '=', true)
    .where('quelle', '=', 'api')
    .where('zuletzt_gesehen', '<', grenze)
    .executeTakeFirst();
  const n = Number(r.numUpdatedRows);
  if (n > 0) {
    summe.deaktiviert += n;
    await protokolliere(trx, {
      benutzerId: null,
      aktion: AUDIT_KATALOG.veraltetDeaktiviert,
      objekt: `anzahl:${n} tage:${tage}`,
    });
  }
  return null;
}

/** Je abgeschlossenem Tag und Token eine Zeile, nie je Anfrage und nie mit dem Token selbst. */
async function tageszeilenSchreiben(
  trx: KatalogTrx,
  heute: string,
  summe: SyncJobErgebnis,
): Promise<void> {
  const fertige = await trx
    .selectFrom('katalog_sync_tag')
    .innerJoin('katalog_import_token', 'katalog_import_token.id', 'katalog_sync_tag.token_id')
    .select([
      'katalog_sync_tag.token_id',
      'katalog_sync_tag.neu',
      'katalog_sync_tag.aktualisiert',
      'katalog_sync_tag.unveraendert',
      'katalog_sync_tag.abgelehnt',
      'katalog_import_token.praefix',
      sql<string>`to_char(katalog_sync_tag.tag, 'YYYY-MM-DD')`.as('tag'),
    ])
    .where('katalog_sync_tag.protokolliert', '=', false)
    .where('katalog_sync_tag.tag', '<', heute)
    .execute();
  for (const z of fertige) {
    await protokolliere(trx, {
      benutzerId: null,
      aktion: AUDIT_KATALOG.apiTag,
      objekt:
        `tag:${z.tag} token:${z.praefix} neu:${z.neu} aktualisiert:${z.aktualisiert} ` +
        `unveraendert:${z.unveraendert} abgelehnt:${z.abgelehnt}`,
    });
    await trx
      .updateTable('katalog_sync_tag')
      .set({ protokolliert: true })
      .where('token_id', '=', z.token_id)
      .where('tag', '=', z.tag)
      .execute();
    summe.tageszeilen += 1;
  }
}
