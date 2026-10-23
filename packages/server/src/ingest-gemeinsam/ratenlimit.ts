// Ratenlimits der Ingest-Pfade (Entscheidung Daniel 2026-10-22): app-seitig, im Speicher
// des Prozesses (eine Server-Instanz, kein Redis), als Token-Bucket je Schlüssel.
//   - je Client-IP über alle Ingest-Pfade (vor der Token-Prüfung)
//   - je Client-IP für Fehlversuche (fehlendes, unbekanntes oder widerrufenes Token): ist der Vorrat leer,
//     antwortet der Server mit 429, ohne die Datenbank zu fragen (bekannte gültige Tokens ausgenommen)
//   - je Token (OTLP) bzw. je Rechner (Agent), Grenze je Mandant überschreibbar (`mandant.ratenlimit_*`)
//   - Enrollment je Client-IP für alle Versuche und, enger, für falsche Einmalcodes
// Schlüssel (IPs, Token-Hashes) erscheinen nie im Log; geloggt wird nur die Schlüsselart.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RATENLIMIT_ARTEN } from '@seatmeter/shared';
import type { Grenze, Konfiguration } from '../config.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';

export type { Grenze };

/** Art des Schlüssels, an dem eine Anfrage abgelehnt wurde (für Log und Health). */
export type SchluesselArt = (typeof RATENLIMIT_ARTEN)[number];

/** Quelle laut Health: a = `/otlp/v1/*`, b = `/api/ingest/v1/*` und `/api/agent/v1/*`. */
export type RatenQuelle = 'a' | 'b';

/** Token-Gruppen mit eigener Grenze je Mandant. */
export type TokenGruppe = 'otlp' | 'agent';

export interface Ablehnung {
  art: SchluesselArt;
  /** Sekunden bis zum nächsten freien Platz (für `Retry-After`), mindestens 1. */
  retryAfter: number;
}

interface Eimer {
  fuellung: number;
  stand: number;
}

/** Token-Bucket je Schlüssel; die Grenze kommt je Aufruf (Mandanten-Überschreibung). */
export class TokenEimer {
  private readonly eimer = new Map<string, Eimer>();

  constructor(private readonly jetzt: () => number = Date.now) {}

  private auffuellen(schluessel: string, g: Grenze): Eimer {
    const t = this.jetzt();
    const e = this.eimer.get(schluessel) ?? { fuellung: g.stoss, stand: t };
    e.fuellung = Math.min(g.stoss, e.fuellung + ((t - e.stand) / 60_000) * g.proMinute);
    e.stand = t;
    this.eimer.set(schluessel, e);
    if (this.eimer.size > 20_000) this.aufraeumen(t);
    return e;
  }

  private warten(e: Eimer, g: Grenze): number {
    return Math.max(1, Math.ceil(((1 - e.fuellung) * 60) / g.proMinute));
  }

  /** Verbraucht einen Platz: `0` = erlaubt, sonst Sekunden bis zum nächsten freien Platz. */
  pruefen(schluessel: string, g: Grenze): number {
    const e = this.auffuellen(schluessel, g);
    if (e.fuellung >= 1) {
      e.fuellung -= 1;
      return 0;
    }
    return this.warten(e, g);
  }

  /** Wie `pruefen`, verbraucht aber nichts (Fehlversuche werden erst nach dem Ergebnis gezählt). */
  frei(schluessel: string, g: Grenze): number {
    const e = this.auffuellen(schluessel, g);
    return e.fuellung >= 1 ? 0 : this.warten(e, g);
  }

  /** Verbraucht einen Platz ohne Prüfung (Fehlversuch nach dem Ergebnis); nie unter -1. */
  verbrauchen(schluessel: string, g: Grenze): void {
    const e = this.auffuellen(schluessel, g);
    e.fuellung = Math.max(-1, e.fuellung - 1);
  }

  private aufraeumen(t: number): void {
    // Eimer, die seit 15 min unberührt sind, wären ohnehin wieder voll.
    for (const [k, e] of this.eimer) if (t - e.stand > 15 * 60_000) this.eimer.delete(k);
  }
}

// ---------------------------------------------------------------------------------------------
// Zähler abgelehnter Anfragen (429) der letzten 24 h, je Quelle und Schlüsselart, in Stundenfächern.
// Prozessweit (eine Server-Instanz); nach einem Neustart beginnt die Zählung neu (`seit`).

const STUNDE = 3_600_000;

export interface RatenlimitStand {
  /** Beginn der Zählung (Serverstart bzw. vor 24 h, je nachdem, was später liegt). */
  seit: string;
  /** Abgelehnte Anfragen (429) der letzten 24 h je Quelle. */
  quellen: Record<RatenQuelle, number>;
  /** Abgelehnte Anfragen (429) der letzten 24 h je Schlüsselart. */
  je_art: Record<SchluesselArt, number>;
}

export class AblehnungsZaehler {
  private readonly faecher = new Map<number, Map<string, number>>();
  private readonly start: number;

  constructor(private readonly jetzt: () => number = Date.now) {
    this.start = jetzt();
  }

  zaehlen(quelle: RatenQuelle, art: SchluesselArt): void {
    const stunde = Math.floor(this.jetzt() / STUNDE);
    let fach = this.faecher.get(stunde);
    if (!fach) {
      fach = new Map();
      this.faecher.set(stunde, fach);
      for (const s of this.faecher.keys()) if (s < stunde - 24) this.faecher.delete(s);
    }
    const k = `${quelle}:${art}`;
    fach.set(k, (fach.get(k) ?? 0) + 1);
  }

  stand(): RatenlimitStand {
    const t = this.jetzt();
    // 24 Stundenfächer: das laufende und die 23 davor.
    const ab = Math.floor(t / STUNDE) - 23;
    const quellen: Record<RatenQuelle, number> = { a: 0, b: 0 };
    const jeArt = Object.fromEntries(RATENLIMIT_ARTEN.map((a) => [a, 0])) as Record<
      SchluesselArt,
      number
    >;
    for (const [stunde, fach] of this.faecher) {
      if (stunde < ab) continue;
      for (const [k, n] of fach) {
        const [q, art] = k.split(':') as [RatenQuelle, SchluesselArt];
        quellen[q] += n;
        jeArt[art] += n;
      }
    }
    return {
      seit: new Date(Math.max(this.start, ab * STUNDE)).toISOString(),
      quellen,
      je_art: jeArt,
    };
  }
}

/** Prozessweiter Zähler, gelesen von `/api/health/ingest`. */
export const ablehnungen = new AblehnungsZaehler();

// ---------------------------------------------------------------------------------------------

export interface RatenlimitOptionen {
  otlp: Grenze;
  agent: Grenze;
  ip: Grenze;
  fehlversuche: Grenze;
  enroll: Grenze;
  enrollFehlversuche: Grenze;
  /** Wie lange die Grenzen eines Mandanten zwischengespeichert werden (Standard 60 s). */
  mandantCacheMs?: number;
  jetzt?: () => number;
  zaehler?: AblehnungsZaehler;
}

export function ratenlimitOptionen(k: Konfiguration): RatenlimitOptionen {
  return {
    otlp: k.SEATMETER_RATE_OTLP,
    agent: k.SEATMETER_RATE_AGENT,
    ip: k.SEATMETER_RATE_IP,
    fehlversuche: k.SEATMETER_RATE_FEHLVERSUCHE,
    enroll: k.SEATMETER_RATE_ENROLL,
    enrollFehlversuche: k.SEATMETER_RATE_ENROLL_FEHLVERSUCHE,
  };
}

/** Überschreibung je Mandant (Anfragen pro Minute); der Stoß wächst im Verhältnis des Standards. */
export function mandantGrenze(standard: Grenze, proMinute: number | null | undefined): Grenze {
  if (!proMinute) return standard;
  return {
    proMinute,
    stoss: Math.max(1, Math.round((proMinute * standard.stoss) / standard.proMinute)),
  };
}

interface Bekannt {
  bis: number;
  gruppe: TokenGruppe;
  schluessel: string;
  mandantId: string;
}

/** Alle Ingest-Ratenlimits eines Servers (eine Instanz je App, geteilt von OTLP, Agent und Enrollment). */
export class IngestRatenlimit {
  readonly optionen: RatenlimitOptionen;
  private readonly eimer: TokenEimer;
  private readonly jetzt: () => number;
  private readonly zaehler: AblehnungsZaehler;
  private readonly mandanten = new Map<string, { bis: number; otlp: Grenze; agent: Grenze }>();
  /** Zuletzt gültige Tokens (SHA-256 hex), 10 min: Vorprüfung ohne DB, Ausnahme von der Fehlversuchs-Sperre. */
  private readonly bekannt = new Map<string, Bekannt>();
  private readonly gemeldet = new Map<string, number>();

  constructor(optionen: RatenlimitOptionen) {
    this.optionen = optionen;
    this.jetzt = optionen.jetzt ?? Date.now;
    this.eimer = new TokenEimer(this.jetzt);
    this.zaehler = optionen.zaehler ?? ablehnungen;
  }

  private ergebnis(art: SchluesselArt, warten: number): Ablehnung | null {
    return warten > 0 ? { art, retryAfter: warten } : null;
  }

  /** Je Client-IP, alle Ingest-Pfade (verbraucht einen Platz). */
  ip(ip: string): Ablehnung | null {
    return this.ergebnis('ip', this.eimer.pruefen(`ip:${ip}`, this.optionen.ip));
  }

  /**
   * Vor der Token-Prüfung: Für bekannte gültige Tokens greift der Token-Eimer ohne DB-Abfrage; für alle
   * anderen die Fehlversuchs-Sperre der IP.
   */
  vorPruefung(ip: string, tokenHash: string): Ablehnung | null {
    const b = this.bekannt.get(tokenHash);
    if (b && b.bis > this.jetzt()) {
      const g = this.grenzeAusCache(b.mandantId, b.gruppe);
      return this.ergebnis(
        b.gruppe === 'otlp' ? 'token' : 'rechner',
        this.eimer.frei(b.schluessel, g),
      );
    }
    return this.ergebnis('fehlversuch', this.eimer.frei(`fv:${ip}`, this.optionen.fehlversuche));
  }

  /** Fehlversuch (401) einer IP zählen; ein bekanntes Token gilt danach nicht mehr als gültig. */
  fehlversuch(ip: string, tokenHash?: string): void {
    this.eimer.verbrauchen(`fv:${ip}`, this.optionen.fehlversuche);
    if (tokenHash) this.bekannt.delete(tokenHash);
  }

  /** Nach erfolgreicher Token-Prüfung: Eimer je Token (OTLP) bzw. je Rechner (Agent) mit Mandanten-Grenze. */
  async nachToken(
    db: Db,
    gruppe: TokenGruppe,
    zugang: { tokenId: string; mandantId: string; rechnerId: string | null },
    tokenHash: string,
  ): Promise<Ablehnung | null> {
    const g = await this.grenze(db, zugang.mandantId, gruppe);
    const schluessel =
      gruppe === 'otlp' ? `t:${zugang.tokenId}` : `r:${zugang.rechnerId ?? zugang.tokenId}`;
    this.bekannt.set(tokenHash, {
      bis: this.jetzt() + 10 * 60_000,
      gruppe,
      schluessel,
      mandantId: zugang.mandantId,
    });
    if (this.bekannt.size > 20_000) {
      const t = this.jetzt();
      for (const [k, v] of this.bekannt) if (v.bis <= t) this.bekannt.delete(k);
    }
    return this.ergebnis(
      gruppe === 'otlp' ? 'token' : 'rechner',
      this.eimer.pruefen(schluessel, g),
    );
  }

  /** Enrollment: jeder Versuch je IP, dazu die (engere) Sperre nach falschen Einmalcodes. */
  enroll(ip: string): Ablehnung | null {
    const gesperrt = this.eimer.frei(`efv:${ip}`, this.optionen.enrollFehlversuche);
    if (gesperrt > 0) return { art: 'enroll_fehlversuch', retryAfter: gesperrt };
    return this.ergebnis('enroll', this.eimer.pruefen(`e:${ip}`, this.optionen.enroll));
  }

  enrollFehlversuch(ip: string): void {
    this.eimer.verbrauchen(`efv:${ip}`, this.optionen.enrollFehlversuche);
  }

  private grenzeAusCache(mandantId: string, gruppe: TokenGruppe): Grenze {
    const m = this.mandanten.get(mandantId);
    return m ? m[gruppe] : this.optionen[gruppe];
  }

  /** Grenze eines Mandanten (Spalten `mandant.ratenlimit_otlp|agent`), 60 s zwischengespeichert. */
  async grenze(db: Db, mandantId: string, gruppe: TokenGruppe): Promise<Grenze> {
    const t = this.jetzt();
    const m = this.mandanten.get(mandantId);
    if (m && m.bis > t) return m[gruppe];
    const zeile = await withMandant(db, mandantId, (trx) =>
      trx
        .selectFrom('mandant')
        .select(['ratenlimit_otlp', 'ratenlimit_agent'])
        .where('id', '=', mandantId)
        .executeTakeFirst(),
    );
    const neu = {
      bis: t + (this.optionen.mandantCacheMs ?? 60_000),
      otlp: mandantGrenze(this.optionen.otlp, zeile?.ratenlimit_otlp),
      agent: mandantGrenze(this.optionen.agent, zeile?.ratenlimit_agent),
    };
    this.mandanten.set(mandantId, neu);
    return neu[gruppe];
  }

  /**
   * 429 vorbereiten: `Retry-After` setzen, Ablehnung zählen und je Schlüsselart höchstens einmal je
   * Minute loggen (nur Art, Quelle und Wartezeit, nie Token, Hash oder IP).
   */
  ablehnen(
    anfrage: FastifyRequest,
    antwort: FastifyReply,
    quelle: RatenQuelle,
    a: Ablehnung,
  ): void {
    antwort.header('retry-after', String(a.retryAfter));
    this.zaehler.zaehlen(quelle, a.art);
    const k = `${quelle}:${a.art}`;
    const t = this.jetzt();
    if ((this.gemeldet.get(k) ?? 0) <= t) {
      this.gemeldet.set(k, t + 60_000);
      anfrage.log.warn(
        { ratenlimit: a.art, quelle, retry_after_s: a.retryAfter },
        'Ratenlimit greift, Anfrage mit 429 abgelehnt',
      );
    }
  }
}

/** Deutscher Fehlertext für 429 im vorhandenen Fehlerformat `{ fehler }`. */
export function ratenlimitMeldung(a: Ablehnung): string {
  return a.art === 'enroll' || a.art === 'enroll_fehlversuch'
    ? `Zu viele Registrierungsversuche, bitte in ${a.retryAfter} s erneut versuchen`
    : `Zu viele Anfragen, bitte in ${a.retryAfter} s erneut versuchen`;
}
