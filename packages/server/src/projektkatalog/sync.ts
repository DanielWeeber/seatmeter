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
/**
 * So grob ist `zuletzt_gesehen`: Ein unveränderter Push schreibt die Zeile nur, wenn der Wert mindestens so alt ist. Ein
 * Lauf je Stunde kostet so keine 240 000 Zeilenänderungen am Tag.
 */
export const GESEHEN_AUFLOESUNG_MS = TAG_MS;
/** Längere Lücke zwischen zwei Pushes gilt als Ausfall. Eine Quelle mit einem Lauf je Tag bleibt darunter. */
const PUSH_LUECKE_STUNDEN = 25;
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
      ...(o.push ? { zuletzt_push: zeit, push_aktiv_ab: zeit } : {}),
    })
    .onConflict((oc) =>
      oc.column('mandant_id').doUpdateSet({
        zuletzt_sync: groesste,
        ...(o.push
          ? {
              zuletzt_push: sql<Date>`greatest(mandant_projektkatalog.zuletzt_push, excluded.zuletzt_push)`,
              // Nach einem Ausfall beginnt die Zählung neu.
              push_aktiv_ab: sql<Date>`CASE
                WHEN mandant_projektkatalog.push_aktiv_ab IS NULL
                  OR excluded.zuletzt_push - mandant_projektkatalog.zuletzt_push > make_interval(hours => ${PUSH_LUECKE_STUNDEN})
                THEN excluded.push_aktiv_ab
                ELSE mandant_projektkatalog.push_aktiv_ab END`,
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
  sync_fenster_ab: Date | null;
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
  /** Quelle ist still oder sendet noch nicht lange genug wieder: Deaktivieren bewusst übersprungen. */
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

interface Bremse {
  /** So viele träfe dieser Lauf. */
  kandidaten: number;
  /** Mit den schon im Zeitraum deaktivierten zusammen. */
  gesamt: number;
  /** Aktive gesendete Projekte plus die im Zeitraum deaktivierten: der Stand zu Beginn des Zeitraums. */
  basis: number;
  erlaubt: number;
  prozent: number;
  zuletztPush: Date;
}

function bremsNachricht(
  mandantId: string,
  b: Bremse,
  oeffentlich: string | undefined,
): AlarmNachricht {
  return {
    schluessel: `seatmeter|katalog-bremse|${mandantId}|${b.zuletztPush.toISOString()}`,
    ereignis: 'seatmeter.katalog_bremse',
    titel: 'Projektkatalog: Deaktivieren angehalten',
    zeilen: [
      `Der Lauf hätte ${b.kandidaten} Projekte deaktiviert, im Zeitraum zusammen ${b.gesamt} von ${b.basis} gesendeten`,
      `Erlaubt: ${b.erlaubt} (${b.prozent} %)`,
      'Vermutlich ist der Lauf im Quellsystem abgebrochen, bitte prüfen',
    ],
    link: alarmLink(oeffentlich),
    daten: {
      anzahl: b.kandidaten,
      gesamt: b.gesamt,
      basis: b.basis,
      erlaubt: b.erlaubt,
      grenze_prozent: b.prozent,
    },
  };
}

/** Fehlerklasse und SQLSTATE: genug zum Einordnen. Der Text bleibt draußen, er kann Werte des Mandanten enthalten. */
export function fehlerArt(fehler: unknown): string {
  const klasse = fehler instanceof Error ? fehler.name : typeof fehler;
  const code = (fehler as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${klasse} ${code}` : klasse;
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
    } catch (fehler) {
      summe.fehlgeschlagen += 1;
      fehlgeschlagen.push(`${id} (${fehlerArt(fehler)})`);
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

    const pruefung = await veralteteDeaktivieren(trx, e, jetzt, summe);
    if (pruefung !== 'frei' && pruefung !== 'still') {
      const bremse = pruefung;
      summe.gebremst += 1;
      if (!e?.sync_bremse_seit) {
        offen.push({
          nachricht: bremsNachricht(id, bremse, oeffentlich),
          merker: 'sync_bremse_seit',
          audit:
            `anzahl:${bremse.kandidaten} gesamt:${bremse.gesamt} basis:${bremse.basis} ` +
            `erlaubt:${bremse.erlaubt} grenze:${bremse.prozent}%`,
        });
      }
    } else if (pruefung === 'frei' && e?.sync_bremse_seit) {
      // Nur nach einer echten Prüfung: Eine stille Quelle sagt nichts darüber, ob der Grund für den Halt weg ist.
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
 * Zusätzlich die Riegel: Quelle still (älter als die Warnfrist), Tage nicht eingestellt, und die Bremse: Sie zählt über
 * einen Zeitraum (die eingestellten Tage plus die Auflösung) alles wegen Alters Deaktivierte plus diesen Lauf, gegen den
 * Stand zu Beginn des Zeitraums. So kommt kein Schwund in kleinen Scheiben durch. CSV-Zeilen altern nicht und zählen nicht
 * mit, ein zurückgekehrtes Projekt auch nicht. Dazu ein vierter Riegel: Nach einer Lücke von über 25 h wartet das Altern,
 * bis die Quelle wieder so lange sendet, wie die Tage sagen (`push_aktiv_ab`). Ergebnis: `still` = nicht geprüft, `frei` = geprüft und nichts spricht
 * dagegen (auch wenn das Deaktivieren aus ist, dann gibt es keinen Halt mehr), sonst die Bremse.
 */
async function veralteteDeaktivieren(
  trx: KatalogTrx,
  e: (Einstellung & { zuletzt_push: Date | null; push_aktiv_ab: Date | null }) | undefined,
  jetzt: Date,
  summe: SyncJobErgebnis,
): Promise<Bremse | 'frei' | 'still'> {
  const tage = e?.sync_deaktivieren_tage ?? null;
  if (tage === null) return 'frei';
  const frist = (e?.sync_warnung_stunden ?? KATALOG_SYNC_WARNUNG_STUNDEN) * STUNDE_MS;
  const zuletztPush = e?.zuletzt_push ? new Date(e.zuletzt_push) : null;
  if (zuletztPush === null || jetzt.getTime() - zuletztPush.getTime() > frist) {
    summe.uebersprungen += 1;
    return 'still';
  }
  // Ein Ausfall darf nicht als Alter zählen: Nach dem Neubeginn sähe jedes Projekt, das ein abgebrochener erster Lauf nicht
  // erreicht, um die ganze Lücke alt aus. Erst wenn die Quelle wieder so lange ohne Lücke sendet, wie die Tage sagen.
  const pushAktivAb = e?.push_aktiv_ab ? new Date(e.push_aktiv_ab).getTime() : null;
  if (pushAktivAb === null || jetzt.getTime() - pushAktivAb < tage * TAG_MS) {
    summe.uebersprungen += 1;
    return 'still';
  }
  // Plus die Auflösung von `zuletzt_gesehen`: Ein Projekt, das jeder Lauf sendet, darf bis dahin alt aussehen. So wird ein
  // nicht mehr gesendetes Projekt nach den eingestellten Tagen bis einem Tag mehr inaktiv, nie früher.
  const spanne = tage * TAG_MS + GESEHEN_AUFLOESUNG_MS;
  const grenze = new Date(zuletztPush.getTime() - spanne);
  const fensterAb = new Date(
    Math.max(
      jetzt.getTime() - spanne,
      e?.sync_fenster_ab ? new Date(e.sync_fenster_ab).getTime() : 0,
    ),
  );
  const zahlen = await sql<{ kandidaten: number; aktive: number; im_fenster: number }>`
    SELECT
      (count(*) FILTER (WHERE aktiv AND zuletzt_gesehen < ${grenze}))::int AS kandidaten,
      (count(*) FILTER (WHERE aktiv))::int AS aktive,
      (count(*) FILTER (WHERE NOT aktiv AND veraltet_seit >= ${fensterAb}))::int AS im_fenster
    FROM katalog_projekt WHERE quelle = 'api'`.execute(trx);
  const kandidaten = Number(zahlen.rows[0]?.kandidaten ?? 0);
  if (kandidaten === 0) return 'frei';
  const imFenster = Number(zahlen.rows[0]?.im_fenster ?? 0);
  const basis = Number(zahlen.rows[0]?.aktive ?? 0) + imFenster;
  const prozent = e?.sync_deaktivieren_max_prozent ?? KATALOG_DEAKTIVIEREN_MAX_PROZENT;
  // Mindestens eins: Sonst käme ein kleiner Katalog nie an einem entfallenen Projekt vorbei. Leer werden kann er dadurch
  // nicht, ein gerade gesendetes Projekt ist nie veraltet.
  const erlaubt = Math.max(1, Math.floor((prozent * basis) / 100));
  const gesamt = imFenster + kandidaten;
  if (gesamt > erlaubt) return { kandidaten, gesamt, basis, erlaubt, prozent, zuletztPush };
  const r = await trx
    .updateTable('katalog_projekt')
    .set({ aktiv: false, veraltet_seit: jetzt })
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
  return 'frei';
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
