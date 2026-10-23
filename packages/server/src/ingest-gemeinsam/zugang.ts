// Ingest-Zugang: Bearer-Token (Architektur §6), Ratenlimits (ratenlimit.ts), Erkennung „DB nicht erreichbar“.
// Tokens liegen nur als SHA-256 in der DB; Klartext und Header-Werte werden nie geloggt.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MANDANTEN_TOKEN_PRAEFIX, RECHNER_TOKEN_PRAEFIX } from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { sha256 } from '../krypto.js';
import {
  ratenlimitMeldung,
  type Ablehnung,
  type IngestRatenlimit,
  type RatenQuelle,
  type TokenGruppe,
} from './ratenlimit.js';

export type TokenTyp = 'mandant' | 'rechner';

export interface IngestZugang {
  tokenId: string;
  mandantId: string;
  typ: TokenTyp;
  rechnerId: string | null;
}

export { sha256 };

/** Neues Token mit Präfix (`smi_`/`smr_`) und 32 Zufallsbytes; `praefix` = erste 8 Zeichen für die Anzeige. */
export function tokenErzeugen(typ: TokenTyp): {
  klartext: string;
  sha256: Buffer;
  praefix: string;
} {
  const p = typ === 'mandant' ? MANDANTEN_TOKEN_PRAEFIX : RECHNER_TOKEN_PRAEFIX;
  const klartext = `${p}${randomBytes(32).toString('base64url')}`;
  return { klartext, sha256: sha256(klartext), praefix: klartext.slice(0, 8) };
}

/** Liest `Authorization: Bearer smi_…|smr_…`; alles andere ergibt `null`. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const treffer = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = treffer?.[1];
  if (!token) return null;
  if (!token.startsWith(MANDANTEN_TOKEN_PRAEFIX) && !token.startsWith(RECHNER_TOKEN_PRAEFIX)) {
    return null;
  }
  return token.length <= 200 ? token : null;
}

/** Löst ein Token über die SECURITY-DEFINER-Funktion `token_aufloesen` auf (widerrufene ergeben `null`). */
export async function tokenAufloesen(db: Db, token: string): Promise<IngestZugang | null> {
  const ergebnis = await sql<{
    token_id: string;
    mandant_id: string;
    typ: TokenTyp;
    rechner_id: string | null;
  }>`SELECT token_id, mandant_id, typ, rechner_id FROM token_aufloesen(${sha256(token)})`.execute(
    db,
  );
  const zeile = ergebnis.rows[0];
  if (!zeile) return null;
  // Präfix und Typ müssen zusammenpassen.
  const erwartet = zeile.typ === 'mandant' ? MANDANTEN_TOKEN_PRAEFIX : RECHNER_TOKEN_PRAEFIX;
  if (!token.startsWith(erwartet)) return null;
  return {
    tokenId: zeile.token_id,
    mandantId: zeile.mandant_id,
    typ: zeile.typ,
    rechnerId: zeile.rechner_id,
  };
}

const DB_NETZFEHLER = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'EPIPE',
]);

/** Fehler, bei denen der Client später wiederholen soll (503 mit Retry-After). */
export function istDbNichtErreichbar(fehler: unknown): boolean {
  if (typeof fehler !== 'object' || fehler === null) return false;
  const f = fehler as { code?: unknown; message?: unknown; errors?: unknown };
  const code = typeof f.code === 'string' ? f.code : '';
  if (DB_NETZFEHLER.has(code)) return true;
  // SQLSTATE: 08 = Verbindung, 57P0x = Server fährt herunter, 53300 = zu viele Verbindungen,
  // 40001/40P01 = Serialisierung/Deadlock (Wiederholung genügt).
  if (/^08/.test(code) || /^57P0/.test(code) || ['53300', '40001', '40P01'].includes(code)) {
    return true;
  }
  const meldung = typeof f.message === 'string' ? f.message : '';
  if (
    /Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED/i.test(
      meldung,
    )
  ) {
    return true;
  }
  // AggregateError (z. B. IPv4 und IPv6 abgelehnt)
  return Array.isArray(f.errors) && f.errors.some((e) => istDbNichtErreichbar(e));
}

export const RETRY_AFTER_SEKUNDEN = 30;

/** Antwortet 503 mit Retry-After, wenn die DB fehlt; sonst `false` (Aufrufer wirft weiter). */
export function antworteBeiDbAusfall(fehler: unknown, antwort: FastifyReply): boolean {
  if (!istDbNichtErreichbar(fehler)) return false;
  void antwort
    .code(503)
    .header('retry-after', String(RETRY_AFTER_SEKUNDEN))
    .send({ fehler: 'Datenbank nicht erreichbar, bitte später erneut senden' });
  return true;
}

const zugaenge = new WeakMap<FastifyRequest, IngestZugang>();

export function zugangSetzen(anfrage: FastifyRequest, zugang: IngestZugang): void {
  zugaenge.set(anfrage, zugang);
}

export function zugangVon(anfrage: FastifyRequest): IngestZugang {
  const z = zugaenge.get(anfrage);
  if (!z) throw new Error('Ingest-Zugang fehlt (onRequest-Hook nicht registriert)');
  return z;
}

export interface ZugangOptionen {
  db: Db;
  /** Erlaubte Token-Typen dieser Routen. */
  typen: readonly TokenTyp[];
  ratenlimit: IngestRatenlimit;
  /** Eimer je Token (`otlp`) bzw. je Rechner (`agent`). */
  gruppe: TokenGruppe;
  /** Quelle für den 429-Zähler in `/api/health/ingest`. */
  quelle: RatenQuelle;
  /** Antwort bei 401/429/503 (OTLP verlangt eigene Körperformate). */
  fehlerAntwort?: (antwort: FastifyReply, status: number, meldung: string) => FastifyReply;
}

/**
 * onRequest-Hook: prüft Ratenlimits und Token, bevor der Körper gelesen wird. Reihenfolge: Eimer je IP,
 * Vorprüfung ohne DB (bekanntes Token bzw. Fehlversuchs-Sperre der IP), Token in der DB, Eimer je Token
 * bzw. Rechner mit der Grenze des Mandanten. Fehlversuche (401) zählen je IP.
 */
export function zugangsHook(optionen: ZugangOptionen) {
  const senden =
    optionen.fehlerAntwort ??
    ((antwort: FastifyReply, status: number, meldung: string) =>
      antwort.code(status).send({ fehler: meldung }));
  const rl = optionen.ratenlimit;
  return async (
    anfrage: FastifyRequest,
    antwort: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    const zuViel = (a: Ablehnung) => {
      rl.ablehnen(anfrage, antwort, optionen.quelle, a);
      return senden(antwort, 429, ratenlimitMeldung(a));
    };
    const ip = anfrage.ip;
    const jeIp = rl.ip(ip);
    if (jeIp) return zuViel(jeIp);
    const token = bearerToken(anfrage.headers.authorization);
    const hash = token ? sha256(token).toString('hex') : '';
    const vorab = rl.vorPruefung(ip, hash);
    if (vorab) return zuViel(vorab);
    if (!token) {
      rl.fehlversuch(ip);
      return senden(antwort, 401, 'Bearer-Token fehlt oder ist ungültig');
    }
    let zugang: IngestZugang | null;
    let sperre: Ablehnung | null = null;
    try {
      zugang = await tokenAufloesen(optionen.db, token);
      if (zugang && optionen.typen.includes(zugang.typ)) {
        sperre = await rl.nachToken(optionen.db, optionen.gruppe, zugang, hash);
      }
    } catch (fehler) {
      if (istDbNichtErreichbar(fehler)) {
        antwort.header('retry-after', String(RETRY_AFTER_SEKUNDEN));
        return senden(antwort, 503, 'Datenbank nicht erreichbar, bitte später erneut senden');
      }
      throw fehler;
    }
    if (!zugang || !optionen.typen.includes(zugang.typ)) {
      rl.fehlversuch(ip, hash);
      return senden(antwort, 401, 'Token unbekannt, widerrufen oder hier nicht zulässig');
    }
    if (sperre) return zuViel(sperre);
    zugangSetzen(anfrage, zugang);
    return undefined;
  };
}

/**
 * Fehlerbehandlung für Ingest-Kontexte: Client-Fehler ohne Fastify-Meldung beantworten (die
 * JSON-Parser-Meldung kann Teile des Körpers enthalten), Serverfehler nur mit Art und Code loggen.
 */
export function sichererFehlerHandler(
  fehler: Error & { statusCode?: number; code?: string },
  anfrage: FastifyRequest,
  antwort: FastifyReply,
): FastifyReply {
  if (antworteBeiDbAusfall(fehler, antwort)) return antwort;
  const status =
    fehler.statusCode && fehler.statusCode >= 400 && fehler.statusCode < 500
      ? fehler.statusCode
      : 500;
  if (status === 500) {
    anfrage.log.error({ fehlerart: fehler.name, code: fehler.code }, 'Ingest fehlgeschlagen');
  }
  const meldungen: Record<number, string> = {
    400: 'Körper ungültig',
    413: 'Körper zu groß',
    415: 'Content-Type nicht unterstützt',
  };
  return antwort.code(status).send({
    fehler: meldungen[status] ?? (status === 500 ? 'Interner Fehler' : 'Anfrage abgelehnt'),
  });
}
