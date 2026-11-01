// Push aus dem Quellsystem: `PUT /api/v1/projektkatalog/projekte/:externalId`, je Projekt eine Anfrage, und
// `GET /api/v1/projektkatalog/sync-status` für die Überwachung. Der Push nur mit einem Token vom Zweck `katalog_api`, der
// Status auch mit `sync_status`, nie per Cookie. Ein Quellsystem bricht seinen ganzen Lauf bei allem außer HTTP 200 ab. Daraus folgt alles Weitere:
// - Anlegen, Ändern und Unverändert antworten genau 200, auch mit Schrägstrich am Ende und kodierter ID.
// - Die Eingabe wird großzügig gelesen: unbekannte Felder egal, Zahlen werden Text, unbrauchbare Werte gelten als
//   weggelassen, zu lange gekürzt. Nur fehlender Name, unbrauchbare ID, falsches Token und Serverfehler sind Fehler.
// - Kein Ratenlimit für gültige Tokens; begrenzt sind nur Fehlversuche, und das trifft nie ein gültiges Token.
// - Ein voller Lauf je Stunde ist ein normales Muster: Unverändertes liest nur und schreibt die Zeile höchstens einmal in
//   24 h (`zuletzt_gesehen`); Zähler und letzte Synchronisation laufen gebündelt über den Puffer.
// Gleichzeitige Anfragen derselben ID sind sicher: Erst Lesen ohne Sperre. Nur bei einer Änderung INSERT … ON CONFLICT DO
// NOTHING, sonst Zeilensperre und erneuter Vergleich. Das Auffrischen schreibt nur `zuletzt_gesehen`, überschreibt also nie
// die Werte einer anderen Anfrage.
import {
  KATALOG_ID_MAX,
  KATALOG_NAME_MAX,
  KATALOG_NUMMER_MAX,
  KATALOG_STATUS_MAX,
  KATALOG_TOKEN_PRAEFIX,
  katalogJaNein,
  katalogTextUnsauber,
  type KatalogPushAntwort,
  type KatalogSyncStatusAntwort,
  type KatalogTokenScope,
} from '@seatmeter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Ratenbegrenzer } from '../auth/ratenbegrenzer.js';
import { withMandant } from '../db/mandant.js';
import { sha256 } from '../krypto.js';
import type { PluginKontext } from '../plugin.js';
import type { KatalogTrx } from './daten.js';
import { GESEHEN_AUFLOESUNG_MS, inaktivListe, syncPuffer, syncStandLaden } from './sync.js';

const PFAD = '/api/v1/projektkatalog/projekte';
const PFAD_STATUS = '/api/v1/projektkatalog/sync-status';
/** Wie die App: Unbekannte Felder dürfen mitkommen, ein Quellsystem sendet manchmal ganze Beschreibungen. */
const KOERPER_MAX = 4 * 1024 * 1024;
const FEHLVERSUCHE_GRENZE = 30;
const FEHLVERSUCHE_FENSTER_MS = 15 * 60_000;
const UNGUELTIG = Symbol('ungueltiger Koerper');

/**
 * Steuerzeichen werden zu Leerzeichen, Ersetzungszeichen und einzelne Surrogate entfallen; `null`, wenn nichts bleibt.
 * Beim Kürzen nie mitten in einem Zeichen: Die Datenbank speicherte sonst ein Ersetzungszeichen, und der Vergleich fände bei
 * jedem Lauf eine Änderung.
 */
function saeubern(wert: string, max: number): string | null {
  let aus = '';
  for (const c of wert) {
    const n = c.charCodeAt(0);
    if (n === 0xfffd || (c.length === 1 && n >= 0xd800 && n <= 0xdfff)) continue;
    aus += n < 0x20 || (n >= 0x7f && n <= 0x9f) ? ' ' : c;
  }
  const lang = aus.replace(/ {2,}/g, ' ').trim();
  const letztes = lang.charCodeAt(max - 1);
  const gekuerzt = lang.slice(0, letztes >= 0xd800 && letztes <= 0xdbff ? max - 1 : max);
  const t = gekuerzt.trim();
  return t === '' ? null : t;
}

/** `undefined` = weggelassen (auch bei unbrauchbarem Typ), `null` = leeren, sonst der Text. Zahlen werden Text. */
function textFeld(wert: unknown, max: number): string | null | undefined {
  if (wert === undefined) return undefined;
  if (wert === null) return null;
  if (typeof wert === 'number' && Number.isFinite(wert)) return String(wert);
  if (typeof wert !== 'string') return undefined;
  return saeubern(wert, max);
}

function aktivFeld(wert: unknown): boolean | undefined {
  if (typeof wert === 'boolean') return wert;
  if (typeof wert === 'number') return wert === 1 ? true : wert === 0 ? false : undefined;
  return typeof wert === 'string' ? katalogJaNein(wert) : undefined;
}

/** Externe ID aus dem Pfad; `null`, wenn sie unbrauchbar ist. */
function idLesen(roh: unknown): string | null {
  if (typeof roh !== 'string') return null;
  const id = roh.trim();
  if (id.length === 0 || id.length > KATALOG_ID_MAX || katalogTextUnsauber(id)) return null;
  return id;
}

/** Elternprojekt nach derselben Regel wie die ID im Pfad, sonst fände es sein Elternprojekt nicht. */
function parentFeld(wert: unknown): string | null | undefined {
  if (wert === undefined) return undefined;
  if (wert === null) return null;
  const text = typeof wert === 'number' && Number.isFinite(wert) ? String(wert) : wert;
  if (typeof text !== 'string') return undefined;
  if (text.trim() === '') return null;
  return idLesen(text) ?? undefined;
}

/**
 * Bytes nach dem `charset` der Anfrage lesen. Ohne brauchbare Angabe erst streng als UTF-8, sonst als Windows-1252:
 * So gehen Umlaute aus älteren Quellsystemen nicht verloren.
 */
function textLesen(bytes: Buffer, contentType: string | undefined): string {
  const zeichensatz = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  if (zeichensatz) {
    try {
      return new TextDecoder(zeichensatz).decode(bytes);
    } catch {
      // Unbekannter Name: weiter wie ohne Angabe.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function koerperLesen(bytes: Buffer, contentType: string | undefined): unknown {
  try {
    return JSON.parse(textLesen(bytes, contentType));
  } catch {
    return UNGUELTIG;
  }
}

/** Was der Vergleich braucht; dieselben Spalten mit und ohne Sperre. */
const VERGLEICH_SPALTEN = [
  'nummer',
  'name',
  'kunde',
  'parent_externe_id',
  'status_roh',
  'aktiv',
  'quelle',
  'zuletzt_gesehen',
  'veraltet_seit',
] as const;

interface Eingabe {
  name: string;
  nummer: string | null | undefined;
  kunde: string | null | undefined;
  parent: string | null | undefined;
  status: string | null | undefined;
  aktiv: boolean;
}

interface Gespeichert {
  nummer: string | null;
  name: string;
  kunde: string | null;
  parent_externe_id: string | null;
  status_roh: string | null;
  aktiv: boolean;
  quelle: string;
  veraltet_seit: Date | string | null;
}

/** Die Zeile nach dieser Anfrage: Weggelassen bleibt der gespeicherte Wert, `null` leert ihn. */
function zielwerte(e: Eingabe, alt: Gespeichert) {
  return {
    name: e.name,
    nummer: e.nummer === undefined ? alt.nummer : e.nummer,
    kunde: e.kunde === undefined ? alt.kunde : e.kunde,
    parent_externe_id: e.parent === undefined ? alt.parent_externe_id : e.parent,
    status_roh: e.status === undefined ? alt.status_roh : e.status,
    aktiv: e.aktiv,
    // Mit im Vergleich: Der erste Push einer CSV-Zeile ist eine echte Änderung, erst danach kann sie altern.
    quelle: 'api',
  };
}

function unveraendert(e: Eingabe, alt: Gespeichert): boolean {
  // Wegen Alters deaktiviert und wieder gesendet, auch als inaktiv: Das ist nicht mehr entfallen und darf nicht weiter für
  // die Bremse zählen. Also einmal schreiben und den Merker löschen.
  if (alt.veraltet_seit !== null) return false;
  const werte = zielwerte(e, alt);
  return (Object.keys(werte) as (keyof typeof werte)[]).every((f) => werte[f] === alt[f]);
}

/** Unverändert: nur `zuletzt_gesehen`, und nur wenn es die Auflösung erreicht hat. Gleichzeitig schreibt einer. */
async function gesehenAuffrischen(
  trx: KatalogTrx,
  id: string,
  gesehen: Date | string,
  jetzt: Date,
): Promise<void> {
  const grenze = new Date(jetzt.getTime() - GESEHEN_AUFLOESUNG_MS);
  if (new Date(gesehen) > grenze) return;
  await trx
    .updateTable('katalog_projekt')
    .set({ zuletzt_gesehen: jetzt })
    .where('externe_id', '=', id)
    .where('zuletzt_gesehen', '<=', grenze)
    .execute();
}

interface TokenZugang {
  id: string;
  mandantId: string;
  /** Wie vom Client gesendet; nur für den Zeichensatz. */
  contentType: string | undefined;
}

export function katalogPushRouten(app: FastifyInstance, ctx: PluginKontext) {
  const { db } = ctx;
  const fehlversuche = new Ratenbegrenzer(FEHLVERSUCHE_GRENZE, FEHLVERSUCHE_FENSTER_MS);
  const zugaenge = new WeakMap<FastifyRequest, TokenZugang>();
  const puffer = syncPuffer(db);

  const anmelden =
    (scopes: readonly KatalogTokenScope[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const t = /^Bearer\s+(\S{1,200})\s*$/i.exec(request.headers.authorization ?? '')?.[1];
      const zeile = t?.startsWith(KATALOG_TOKEN_PRAEFIX)
        ? await db
            .selectFrom('katalog_import_token')
            .select(['id', 'mandant_id'])
            .where('token_sha256', '=', sha256(t))
            .where('widerrufen', 'is', null)
            .where('scope', 'in', [...scopes])
            .executeTakeFirst()
        : undefined;
      if (zeile) {
        zugaenge.set(request, {
          id: zeile.id,
          mandantId: zeile.mandant_id,
          contentType: request.headers['content-type'],
        });
        // Einen unlesbaren Content-Type wiese Fastify mit 415 ab, und der Lauf bräche ab. Erst nach der Token-Prüfung
        // ersetzen: Der Körper wird in jedem Fall als JSON gelesen.
        request.headers['content-type'] = 'application/json';
        return undefined;
      }
      // Erst nach der Prüfung begrenzen: Fehlversuche hinter demselben Proxy dürfen einen Lauf nie treffen.
      const ip = request.ip || 'unbekannt';
      if (fehlversuche.gesperrt(ip)) {
        return reply
          .code(429)
          .header('retry-after', String(FEHLVERSUCHE_FENSTER_MS / 1000))
          .send({ fehler: 'Zu viele Fehlversuche' });
      }
      fehlversuche.fehlschlag(ip);
      return reply.code(401).send({ fehler: 'Token fehlt, ist unbekannt oder widerrufen' });
    };

  const zugangVon = (request: FastifyRequest): TokenZugang => {
    const z = zugaenge.get(request);
    if (!z) throw new Error('Anmeldung fehlt an dieser Route');
    return z;
  };

  void app.register(async (kind) => {
    kind.removeAllContentTypeParsers();
    // Jede Art gilt als JSON: Ein abweichender Content-Type soll keinen Lauf abbrechen.
    kind.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: KOERPER_MAX },
      (anfrage, koerper, fertig) =>
        fertig(null, koerperLesen(koerper as Buffer, zugaenge.get(anfrage)?.contentType)),
    );

    const schreiben = async (request: FastifyRequest, reply: FastifyReply) => {
      const zugang = zugangVon(request);
      const id = idLesen((request.params as { externalId?: unknown }).externalId);
      if (id === null)
        return reply.code(400).send({ fehler: 'Externe ID fehlt oder ist unbrauchbar' });
      const b = request.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) {
        return reply.code(400).send({ fehler: 'Körper muss ein JSON-Objekt sein' });
      }
      const k = b as Record<string, unknown>;
      const name = textFeld(k.name, KATALOG_NAME_MAX);
      if (!name) return reply.code(400).send({ fehler: 'name fehlt' });
      const nummer = textFeld(k.number, KATALOG_NUMMER_MAX);
      const kunde = textFeld(k.customer, KATALOG_NAME_MAX);
      const parent = parentFeld(k.parentId);
      const status = textFeld(k.status, KATALOG_STATUS_MAX);
      const signal = aktivFeld(k.active);
      const jetzt = new Date();

      const e = await withMandant(db, zugang.mandantId, async (trx) => {
        const s = await trx
          .selectFrom('mandant_projektkatalog')
          .select('inaktiv_status')
          .executeTakeFirst();
        // `active` schlägt `status`. Unbekannter Status heißt aktiv, ohne beides ebenso: So kommt auch ein wegen Alters
        // deaktiviertes Projekt mit der nächsten Anfrage zurück.
        const aktiv =
          signal ??
          (typeof status === 'string'
            ? !inaktivListe(s?.inaktiv_status).includes(status.toLowerCase())
            : true);
        const eingabe: Eingabe = { name, nummer, kunde, parent, status, aktiv };
        const vorab = await trx
          .selectFrom('katalog_projekt')
          .select(VERGLEICH_SPALTEN)
          .where('externe_id', '=', id)
          .executeTakeFirst();
        if (vorab && unveraendert(eingabe, vorab)) {
          await gesehenAuffrischen(trx, id, vorab.zuletzt_gesehen, jetzt);
          return { ergebnis: 'unveraendert' as const, aktiv };
        }
        if (!vorab) {
          const neu = await trx
            .insertInto('katalog_projekt')
            .values({
              mandant_id: zugang.mandantId,
              externe_id: id,
              nummer: nummer ?? null,
              name,
              kunde: kunde ?? null,
              parent_externe_id: parent ?? null,
              status_roh: status ?? null,
              aktiv,
              quelle: 'api',
              zuletzt_gesehen: jetzt,
            })
            .onConflict((oc) => oc.columns(['mandant_id', 'externe_id']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (neu) return { ergebnis: 'neu' as const, aktiv };
        }
        const alt = await trx
          .selectFrom('katalog_projekt')
          .select(VERGLEICH_SPALTEN)
          .where('externe_id', '=', id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (unveraendert(eingabe, alt)) {
          await gesehenAuffrischen(trx, id, alt.zuletzt_gesehen, jetzt);
          return { ergebnis: 'unveraendert' as const, aktiv };
        }
        await trx
          .updateTable('katalog_projekt')
          .set({ ...zielwerte(eingabe, alt), zuletzt_gesehen: jetzt, veraltet_seit: null })
          .where('externe_id', '=', id)
          .execute();
        return { ergebnis: 'aktualisiert' as const, aktiv };
      });
      puffer.merken(zugang.mandantId, zugang.id, e.ergebnis, jetzt, request.log);
      const antwort: KatalogPushAntwort = {
        externalId: id,
        ergebnis: e.ergebnis,
        active: e.aktiv,
      };
      return reply.code(200).header('cache-control', 'no-store').send(antwort);
    };

    const fehlendeId = (_r: FastifyRequest, reply: FastifyReply) =>
      reply.code(400).send({ fehler: 'Externe ID fehlt oder ist unbrauchbar' });

    // Gültiges Token, aber nicht 200: So sieht ein abgebrochener Lauf aus. Zählt mit, ist aber kein Lebenszeichen.
    const nachAntwort = async (request: FastifyRequest, reply: FastifyReply) => {
      const z = zugaenge.get(request);
      if (z && reply.statusCode !== 200) {
        puffer.merken(z.mandantId, z.id, 'abgelehnt', new Date(), request.log);
      }
    };
    const optionen = { onRequest: anmelden(['katalog_api']), onResponse: nachAntwort };
    kind.put(`${PFAD}/:externalId`, optionen, schreiben);
    // Mit Schrägstrich am Ende dasselbe Ergebnis statt 404 oder Weiterleitung.
    kind.put(`${PFAD}/:externalId/`, optionen, schreiben);
    kind.put(PFAD, optionen, fehlendeId);
    kind.put(`${PFAD}/`, optionen, fehlendeId);

    kind.get(
      PFAD_STATUS,
      { onRequest: anmelden(['katalog_api', 'sync_status']) },
      async (request, reply) => {
        await puffer.leeren();
        const zugang = zugangVon(request);
        const stand = await withMandant(db, zugang.mandantId, async (trx) => {
          const e = await trx.selectFrom('mandant_projektkatalog').selectAll().executeTakeFirst();
          return syncStandLaden(trx, e);
        });
        const heute = new Date().toISOString().slice(0, 10);
        const antwort: KatalogSyncStatusAntwort = {
          status: stand.status,
          zuletzt_sync: stand.zuletzt_sync,
          warnung_stunden: stand.warnung_stunden,
          alter_stunden: stand.alter_stunden,
          abgelehnt_heute: stand.tage.find((t) => t.tag === heute)?.abgelehnt ?? 0,
          abgelehnt_7_tage: stand.tage.reduce((n, t) => n + t.abgelehnt, 0),
        };
        return reply
          .code(stand.status === 'veraltet' ? 503 : 200)
          .header('cache-control', 'no-store')
          .send(antwort);
      },
    );
  });

  app.addHook('onClose', () => puffer.leeren());
}
