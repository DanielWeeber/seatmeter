// Typisierter Client für die Server-API (gleiche Herkunft; im Dev-Server per Proxy auf :8080).
// `fetch` ist injizierbar (React-Kontext), damit Tests eine Fixture-Funktion übergeben können.
//
// CSRF (Double-Submit, server auth/kontext.ts): POST/PUT/DELETE tragen `X-Seatmeter-CSRF` mit dem
// Wert des Cookies `seatmeter_csrf`. Ist das Cookie nicht lesbar, gilt der Wert `csrf` aus
// `GET /api/v1/auth/me` (merkeCsrf). Gilt für Anmeldung per Formular und für den Header-Modus
// hinter Authelia (`SEATMETER_TRUST_REMOTE_USER_HEADER`): dort legt schon der erste GET die Sitzung
// samt Cookie an. Läuft die Sitzung ab, legt der Server beim nächsten Aufruf eine neue an und
// antwortet auf den alten Token mit 403 `{ code: 'csrf' }`; dann holt der Client den neuen Token und
// versucht es einmal neu. Bleibt es beim 403, zeigen die Seiten `TEXT_CSRF` (istCsrfFehler).
import { QueryClient } from '@tanstack/react-query';
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import type { z } from 'zod';

export type FetchFunktion = (eingabe: string, init?: RequestInit) => Promise<Response>;

/** `http` = Server hat mit Fehlerstatus geantwortet, `netz` = nicht erreichbar, `format` = Antwort passt nicht zum Vertrag. */
export type FehlerArt = 'http' | 'netz' | 'format';

/** Einzelner Prüffehler aus einer 400-Antwort (`details` des Servers, zod-Issues). */
export interface FeldFehler {
  /** Feldname (erstes Pfadelement), `null` für Fehler ohne Feldbezug. */
  feld: string | null;
  meldung: string;
}

export class ApiFehler extends Error {
  constructor(
    public readonly status: number,
    public readonly art: FehlerArt,
    nachricht: string,
    public readonly pfad: string,
    /** Prüffehler je Feld aus `details` (nur bei 400 mit zod-Issues). */
    public readonly details: FeldFehler[] = [],
    /** Stabiler Fehlercode des Servers (`code`, siehe FehlerCode in shared), sonst `null`. */
    public readonly code: string | null = null,
  ) {
    super(nachricht);
    this.name = 'ApiFehler';
  }
}

export function istApiFehler(fehler: unknown, status?: number): fehler is ApiFehler {
  return fehler instanceof ApiFehler && (status === undefined || fehler.status === status);
}

/** Text, wenn der Server eine Änderung wegen des CSRF-Tokens abweist (auch nach dem Neuversuch). */
export const TEXT_CSRF =
  'Die Sitzung wurde erneuert oder ist abgelaufen. Bitte die Seite neu laden und es noch einmal versuchen.';

/** `true` bei 403 mit Code `csrf` (CSRF-Token fehlt oder passt nicht zur Sitzung). */
export function istCsrfFehler(fehler: unknown): boolean {
  return istApiFehler(fehler, 403) && fehler.code === 'csrf';
}

/** Liest `details` (zod-Issues `{ path, message }`) aus einem Antwortkörper. */
function feldFehlerAus(details: unknown): FeldFehler[] {
  if (!Array.isArray(details)) return [];
  const aus: FeldFehler[] = [];
  for (const d of details as unknown[]) {
    if (!d || typeof d !== 'object') continue;
    const { path, message } = d as { path?: unknown; message?: unknown };
    if (typeof message !== 'string' || !message) continue;
    const erstes = Array.isArray(path) ? (path as unknown[])[0] : undefined;
    aus.push({ feld: typeof erstes === 'string' ? erstes : null, meldung: message });
  }
  return aus;
}

interface FehlerAngaben {
  meldung: string | null;
  details: FeldFehler[];
  code: string | null;
}

/** Liest Meldung (`fehler`, `meldung` oder Fastifys `message`), `details` und `code` aus dem Körper. */
async function fehlerAus(antwort: Response): Promise<FehlerAngaben> {
  try {
    const koerper: unknown = await antwort.json();
    if (koerper && typeof koerper === 'object') {
      const k = koerper as Record<string, unknown>;
      let meldung: string | null = null;
      for (const feld of ['fehler', 'meldung', 'message']) {
        const wert = k[feld];
        if (typeof wert === 'string' && wert) {
          meldung = wert;
          break;
        }
      }
      const code = typeof k.code === 'string' && k.code ? k.code : null;
      return { meldung, details: feldFehlerAus(k.details), code };
    }
  } catch {
    // kein JSON
  }
  return { meldung: null, details: [], code: null };
}

const standardFetch: FetchFunktion = (eingabe, init) => globalThis.fetch(eingabe, init);

export const CSRF_COOKIE = 'seatmeter_csrf';
export const CSRF_HEADER = 'X-Seatmeter-CSRF';
export const ME_PFAD = '/api/v1/auth/me';

/** Liefert `document.cookie` (im Browser); injizierbar für Tests. */
export type CookieQuelle = () => string;
const standardCookies: CookieQuelle = () =>
  typeof document === 'undefined' ? '' : (document.cookie ?? '');

/** Wert eines Cookies aus einem `document.cookie`-String, sonst `null`. */
export function cookieWert(cookies: string, name: string): string | null {
  for (const teil of cookies.split(';')) {
    const gleich = teil.indexOf('=');
    if (gleich < 0 || teil.slice(0, gleich).trim() !== name) continue;
    const roh = teil.slice(gleich + 1).trim();
    try {
      return decodeURIComponent(roh) || null;
    } catch {
      return roh || null;
    }
  }
  return null;
}

const CSRF_FEHLER = /csrf/i;

type Methode = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class ApiClient {
  /** Fallback, wenn das CSRF-Cookie nicht lesbar ist: `csrf` aus `/api/v1/auth/me`. */
  private csrfGemerkt: string | null = null;

  constructor(
    private readonly fetchFn: FetchFunktion = standardFetch,
    private readonly cookies: CookieQuelle = standardCookies,
  ) {}

  /** Merkt sich den CSRF-Wert aus `/api/v1/auth/me` (oder Login-Antwort). */
  merkeCsrf(wert: string | null | undefined): void {
    this.csrfGemerkt = wert || null;
  }

  /** Aktueller CSRF-Wert: Cookie zuerst (folgt jeder neuen Sitzung), sonst der gemerkte Wert. */
  csrfToken(): string | null {
    return cookieWert(this.cookies(), CSRF_COOKIE) ?? this.csrfGemerkt;
  }

  private async senden(
    methode: Methode,
    pfad: string,
    koerper: unknown,
    csrf: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (koerper !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers[CSRF_HEADER] = csrf;
    try {
      return await this.fetchFn(pfad, {
        method: methode,
        headers,
        credentials: 'same-origin',
        body: koerper === undefined ? undefined : JSON.stringify(koerper),
      });
    } catch {
      throw new ApiFehler(0, 'netz', 'Server nicht erreichbar.', pfad);
    }
  }

  /** Holt nach einem CSRF-403 den aktuellen Token (der Server hat ggf. eine neue Sitzung angelegt). */
  private async csrfErneuern(): Promise<void> {
    try {
      const antwort = await this.fetchFn(ME_PFAD, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (antwort.ok) {
        const me: unknown = await antwort.json();
        const csrf = (me as { csrf?: unknown } | null)?.csrf;
        if (typeof csrf === 'string') this.merkeCsrf(csrf);
      }
    } catch {
      // ohne neuen Token bleibt es beim 403
    }
  }

  async anfrage<T>(
    methode: Methode,
    pfad: string,
    optionen: { schema?: z.ZodType<T>; koerper?: unknown } = {},
  ): Promise<T> {
    const csrf = methode === 'GET' ? null : this.csrfToken();
    let antwort = await this.senden(methode, pfad, optionen.koerper, csrf);
    if (antwort.status === 403 && methode !== 'GET') {
      const { meldung, code } = await fehlerAus(antwort.clone());
      // Code `csrf` seit Phase 1c; der Text dient als Rückfall für ältere Server.
      if (code === 'csrf' || (meldung && CSRF_FEHLER.test(meldung))) {
        await this.csrfErneuern();
        const neu = this.csrfToken();
        // Nur einmal und nur mit einem anderen Token erneut senden.
        if (neu && neu !== csrf) antwort = await this.senden(methode, pfad, optionen.koerper, neu);
      }
    }
    if (!antwort.ok) {
      const { meldung, details, code } = await fehlerAus(antwort);
      throw new ApiFehler(
        antwort.status,
        'http',
        meldung ?? `Anfrage fehlgeschlagen (Status ${antwort.status}).`,
        pfad,
        details,
        code ?? (meldung && CSRF_FEHLER.test(meldung) && antwort.status === 403 ? 'csrf' : null),
      );
    }
    if (antwort.status === 204 || !optionen.schema) return undefined as T;
    let daten: unknown;
    try {
      daten = await antwort.json();
    } catch {
      throw new ApiFehler(antwort.status, 'format', 'Antwort des Servers ist kein JSON.', pfad);
    }
    const ergebnis = optionen.schema.safeParse(daten);
    if (!ergebnis.success) {
      const felder = ergebnis.error.issues
        .slice(0, 3)
        .map((i) => i.path.join('.') || '(Wurzel)')
        .join(', ');
      throw new ApiFehler(
        antwort.status,
        'format',
        `Unerwartetes Antwortformat (Felder: ${felder}).`,
        pfad,
      );
    }
    return ergebnis.data;
  }

  get<T>(pfad: string, schema: z.ZodType<T>): Promise<T> {
    return this.anfrage('GET', pfad, { schema });
  }

  post<T = void>(pfad: string, koerper?: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.anfrage('POST', pfad, { koerper: koerper ?? {}, schema });
  }

  put<T = void>(pfad: string, koerper: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.anfrage('PUT', pfad, { koerper, schema });
  }

  delete(pfad: string): Promise<void> {
    return this.anfrage('DELETE', pfad);
  }
}

const ApiKontext = createContext<ApiClient>(new ApiClient());

export function ApiProvider({ fetch, children }: { fetch?: FetchFunktion; children: ReactNode }) {
  const client = useMemo(() => new ApiClient(fetch), [fetch]);
  return createElement(ApiKontext.Provider, { value: client }, children);
}

export function useApi(): ApiClient {
  return useContext(ApiKontext);
}

/** QueryClient für den Betrieb: 4xx und Formatfehler nicht wiederholen, sonst bis zu zweimal. */
export function erstelleQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (versuche, fehler) => {
          const endgueltig =
            fehler instanceof ApiFehler &&
            (fehler.art === 'format' || (fehler.art === 'http' && fehler.status < 500));
          return !endgueltig && versuche < 2;
        },
      },
    },
  });
}
