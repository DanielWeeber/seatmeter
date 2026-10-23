// Push an den Server (Architektur §2.2, CCAM-Regeln): Batches ≤ 1000, idempotent über den
// Anfrage-Schlüssel. 401/403 → anhalten und Token als ungültig markieren; 413 → Batch teilen;
// 400 → teilen bis zum einzelnen Datensatz, der dann verworfen wird; 429/503/5xx/Netz → Backoff.
// Vor dem Senden prüft der Agent jeden Datensatz gegen das strikte Schema aus @seatmeter/shared.
import {
  agentAnfrageSchema,
  agentKonfigurationSchema,
  agentPushAntwortSchema,
  agentSitzungSchema,
  PUSH_MAX_EINTRAEGE,
  type AgentAnfrage,
  type AgentSitzung,
} from '@seatmeter/shared';
import type { WirksameKonfig } from './konfig.js';
import { speichereServerKonfig } from './konfig.js';
import type { Logger } from './log.js';
import type { Umgebung } from './umgebung.js';
import { ersetzeAnfragen, ersetzeSitzungen, ladeAnfragen, ladeSitzungen } from './warteschlange.js';
import type { Zustand } from './zustand.js';

declare const __AGENT_VERSION__: string | undefined;
export const AGENT_VERSION: string =
  typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : '0.0.0-dev';

export type PushStatus = 'ok' | 'leer' | 'token_ungueltig' | 'backoff' | 'kein_server' | 'fehler';

export interface PushErgebnis {
  status: PushStatus;
  gesendet: number;
  angenommen: number;
  wiederholt: number;
  verworfen: number;
  abgelehnt: number;
  sitzungen: number;
  rest: number;
}

export interface PushOptionen {
  timeoutMs?: number;
  /** Backoff ignorieren (von Hand aufgerufen). */
  erzwingen?: boolean;
}

class Abbruch extends Error {
  constructor(
    readonly art: 'token' | 'backoff',
    readonly wartenSek: number | null,
  ) {
    super(art);
  }
}

function retryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 3600);
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.max(0, Math.min(3600, (d - Date.now()) / 1000));
}

/** Basis-URL prüfen: https, nur für localhost auch http. */
export function pruefeServerUrl(roh: string): string {
  const url = new URL(roh);
  const lokal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && lokal)) {
    throw new Error('Server-URL muss https verwenden');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

export async function sende(
  u: Umgebung,
  basis: string,
  pfad: string,
  token: string,
  koerper: unknown,
  timeoutMs: number,
): Promise<Response> {
  return u.fetch(`${basis}${pfad}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': `seatmeter-agent/${AGENT_VERSION}`,
    },
    body: JSON.stringify(koerper),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Holt die Konfiguration vom Server und legt sie ab (Fehler werden ignoriert). */
export async function konfigAktualisieren(
  u: Umgebung,
  basis: string,
  token: string,
  timeoutMs = 5000,
): Promise<boolean> {
  try {
    const r = await u.fetch(`${basis}/api/agent/v1/config`, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': `seatmeter-agent/${AGENT_VERSION}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return false;
    const k = agentKonfigurationSchema.safeParse(await r.json());
    if (!k.success) return false;
    speichereServerKonfig(u, k.data);
    return true;
  } catch {
    return false;
  }
}

export type HeartbeatStatus = 'ok' | 'fehler' | 'token_ungueltig' | 'uebersprungen';

/**
 * Lebenszeichen an den Server (`POST /api/agent/v1/heartbeat`, nur die Agent-Version): setzt
 * `rechner.zuletzt_gesehen` auch dann, wenn nichts zu senden war. Wirft nie; Netz- und Serverfehler
 * werden nur vermerkt (der Push hängt nicht davon ab). 401/403 markiert das Token als ungültig wie
 * beim Push.
 */
export async function heartbeat(
  u: Umgebung,
  k: WirksameKonfig,
  z: Zustand,
  token: string | null,
  log: Logger,
  timeoutMs = 10_000,
): Promise<HeartbeatStatus> {
  if (!k.server_url || !token || z.token_ungueltig) return 'uebersprungen';
  try {
    const r = await sende(
      u,
      pruefeServerUrl(k.server_url),
      '/api/agent/v1/heartbeat',
      token,
      { agent_version: AGENT_VERSION },
      timeoutMs,
    );
    if (r.status === 401 || r.status === 403) {
      z.token_ungueltig = true;
      z.heartbeat.letzter_fehler = 'Rechner-Token ungültig oder widerrufen (401)';
      log.fehler('Heartbeat abgelehnt: Rechner-Token ungültig');
      return 'token_ungueltig';
    }
    if (!r.ok) {
      z.heartbeat.letzter_fehler = `Server antwortet mit HTTP ${r.status}`;
      log.fehler('Heartbeat fehlgeschlagen (ignoriert)', { status: r.status });
      return 'fehler';
    }
    z.heartbeat.letzter_erfolg = u.jetzt().toISOString();
    z.heartbeat.letzter_fehler = null;
    return 'ok';
  } catch {
    z.heartbeat.letzter_fehler = 'Server nicht erreichbar';
    log.fehler('Heartbeat fehlgeschlagen (ignoriert)', { status: 'netz' });
    return 'fehler';
  }
}

export async function pushe(
  u: Umgebung,
  k: WirksameKonfig,
  z: Zustand,
  token: string | null,
  log: Logger,
  o: PushOptionen = {},
): Promise<PushErgebnis> {
  const e: PushErgebnis = {
    status: 'ok',
    gesendet: 0,
    angenommen: 0,
    wiederholt: 0,
    verworfen: 0,
    abgelehnt: 0,
    sitzungen: 0,
    rest: 0,
  };
  const anfragen = ladeAnfragen(u);
  const sitzungen = ladeSitzungen(u);
  e.rest = anfragen.length;
  if (anfragen.length === 0 && Object.keys(sitzungen).length === 0) return { ...e, status: 'leer' };
  if (!k.server_url) return { ...e, status: 'kein_server' };
  if (!token || z.token_ungueltig) return { ...e, status: 'token_ungueltig' };
  const jetzt = u.jetzt();
  if (!o.erzwingen && z.push.naechster_versuch && new Date(z.push.naechster_versuch) > jetzt) {
    return { ...e, status: 'backoff' };
  }
  const basis = pruefeServerUrl(k.server_url);
  const timeoutMs = o.timeoutMs ?? 30_000;
  z.push.letzter_versuch = jetzt.toISOString();

  // Strikte Prüfung vor dem Senden: was nicht ins Schema passt, verlässt den Rechner nicht.
  const gueltig = anfragen.filter((a) => agentAnfrageSchema.safeParse(a).success);
  e.verworfen += anfragen.length - gueltig.length;
  const offen = new Set(gueltig);

  async function batch(liste: AgentAnfrage[]): Promise<void> {
    let r: Response;
    try {
      r = await sende(
        u,
        basis,
        '/api/ingest/v1/anfragen',
        token as string,
        { agent_version: AGENT_VERSION, anfragen: liste },
        timeoutMs,
      );
    } catch {
      throw new Abbruch('backoff', null);
    }
    if (r.status === 200) {
      const a = agentPushAntwortSchema.safeParse(await r.json().catch(() => null));
      if (a.success) {
        e.angenommen += a.data.angenommen;
        e.wiederholt += a.data.wiederholt;
        e.verworfen += a.data.verworfen_api + a.data.verworfen_fremd_org;
        e.abgelehnt += a.data.abgelehnt;
      }
      e.gesendet += liste.length;
      for (const x of liste) offen.delete(x);
      return;
    }
    if (r.status === 401 || r.status === 403) throw new Abbruch('token', null);
    if (r.status === 413 || r.status === 400) {
      if (liste.length > 1) {
        const mitte = Math.ceil(liste.length / 2);
        await batch(liste.slice(0, mitte));
        await batch(liste.slice(mitte));
        return;
      }
      // Einzelner Datensatz passt nicht: verwerfen, sonst blockiert er die Warteschlange.
      log.fehler('Datensatz vom Server abgelehnt und verworfen', { status: r.status });
      e.abgelehnt += 1;
      for (const x of liste) offen.delete(x);
      return;
    }
    throw new Abbruch('backoff', retryAfter(r.headers.get('retry-after')));
  }

  const sitzOffen = new Map(Object.entries(sitzungen));
  try {
    for (let i = 0; i < gueltig.length; i += PUSH_MAX_EINTRAEGE) {
      await batch(gueltig.slice(i, i + PUSH_MAX_EINTRAEGE));
    }
    const liste: AgentSitzung[] = [...sitzOffen.values()].filter(
      (s) => agentSitzungSchema.safeParse(s).success,
    );
    for (const s of sitzOffen.values()) if (!liste.includes(s)) sitzOffen.delete(s.session_id);
    for (let i = 0; i < liste.length; i += PUSH_MAX_EINTRAEGE) {
      const teil = liste.slice(i, i + PUSH_MAX_EINTRAEGE);
      let r: Response;
      try {
        r = await sende(
          u,
          basis,
          '/api/ingest/v1/sitzungen',
          token,
          { agent_version: AGENT_VERSION, sitzungen: teil },
          timeoutMs,
        );
      } catch {
        throw new Abbruch('backoff', null);
      }
      if (r.status === 401 || r.status === 403) throw new Abbruch('token', null);
      if (r.status === 200 || r.status === 400 || r.status === 413) {
        // Sitzungsmeldungen sind Zusatz (Start/Ende); abgelehnte werden nicht wiederholt.
        if (r.status !== 200) log.fehler('Sitzungsmeldung abgelehnt', { status: r.status });
        else e.sitzungen += teil.length;
        for (const s of teil) sitzOffen.delete(s.session_id);
        continue;
      }
      throw new Abbruch('backoff', retryAfter(r.headers.get('retry-after')));
    }
    z.push.letzter_erfolg = u.jetzt().toISOString();
    z.push.fehlversuche = 0;
    z.push.naechster_versuch = null;
    z.push.letzter_fehler = null;
  } catch (f) {
    if (f instanceof Abbruch && f.art === 'token') {
      z.token_ungueltig = true;
      z.push.letzter_fehler = 'Rechner-Token ungültig oder widerrufen (401)';
      e.status = 'token_ungueltig';
      log.fehler('Push angehalten: Rechner-Token ungültig');
    } else {
      z.push.fehlversuche += 1;
      const warten =
        f instanceof Abbruch && f.wartenSek !== null
          ? f.wartenSek
          : Math.min(3600, 60 * 2 ** Math.min(6, z.push.fehlversuche - 1));
      z.push.naechster_versuch = new Date(u.jetzt().getTime() + warten * 1000).toISOString();
      z.push.letzter_fehler = 'Server nicht erreichbar oder überlastet';
      e.status = 'backoff';
      log.fehler('Push verschoben', {
        warten_s: Math.round(warten),
        fehlversuche: z.push.fehlversuche,
      });
    }
  }
  const rest = gueltig.filter((a) => offen.has(a));
  ersetzeAnfragen(u, rest);
  ersetzeSitzungen(u, Object.fromEntries(sitzOffen));
  z.push.gesendet_gesamt += e.gesendet;
  e.rest = rest.length;
  return e;
}
