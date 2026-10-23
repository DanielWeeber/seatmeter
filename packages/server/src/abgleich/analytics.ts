// Client der Claude Enterprise Analytics API (Beta), geprüft gegen die Doku am 2026-10-22
// (platform.claude.com/docs/en/api/beta/organization/analytics/user_usage_report bzw. user_cost_report;
// Fixtures unter packages/server/test/fixtures/analytics, kein Live-Enterprise vorhanden):
// - GET {basis}/user_usage_report und /user_cost_report mit starting_at/ending_at (RFC 3339, ending_at
//   exklusiv, höchstens 31 Tage), bucket_width=1d, products[]=claude_code, group_by[]=model, limit ≤ 1000.
// - Header x-api-key (eigener Analytics-Key, Scope read:analytics) und anthropic-version 2023-06-01.
// - Paging über has_more/next_page → page; 410 = Cursor abgelaufen (neu ab Seite 1); 429 mit retry-after.
// - amount/list_amount sind Dezimal-Strings in Cent (z. B. "1500.000000" = 15,00 USD).
// E-Mail und Name verlassen diese Datei nie: `actor.user_id` und `email_address` werden sofort über
// `pseudonymisiere` gehasht, `name` wird verworfen.
import { plusTage } from '../aggregation/tage.js';

export const ANALYTICS_BASIS = 'https://api.anthropic.com/v1/organizations/analytics';
export const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TAGE_JE_ABRUF = 31;
const LIMIT = 1000;

export type FetchFunktion = (url: string, init?: RequestInit) => Promise<Response>;

export type AnalyticsFehlerArt = 'auth' | 'rate' | 'anfrage' | 'server' | 'netz';

export class AnalyticsFehler extends Error {
  constructor(
    readonly art: AnalyticsFehlerArt,
    readonly status: number | null,
    meldung: string,
  ) {
    super(meldung);
  }
}

/** Gehashte Kennungen eines Akteurs (HMAC mit dem Personen-Salt des Mandanten). */
export interface AkteurSchluessel {
  konto: Buffer;
  email: Buffer | null;
}

export interface AnalyticsOptionen {
  key: string;
  pseudonymisiere: (userId: string, email: string | null) => AkteurSchluessel;
  fetch?: FetchFunktion;
  basis?: string;
  /** Wartefunktion für 429 (Tests: sofort). */
  warte?: (ms: number) => Promise<void>;
  maxWiederholungen?: number;
}

export interface NutzungZeile {
  akteur: AkteurSchluessel;
  tag: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number;
  requests: number;
}

export interface KostenZeile {
  akteur: AkteurSchluessel;
  tag: string;
  model: string;
  amountUsdMicros: number;
  listAmountUsdMicros: number | null;
}

const zahl = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Dezimal-String in Cent → Mikro-USD (1 Cent = 10 000 µUSD), exakt über BigInt. */
export function centZuMikro(wert: unknown): number | null {
  if (wert === null || wert === undefined) return null;
  const text = String(wert).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const [, vz, ganz, bruch = ''] = m;
  // µUSD = Cent · 10^4: vier Nachkommastellen übernehmen, die fünfte rundet.
  const vier = (bruch + '00000').slice(0, 5);
  let mikro = BigInt(ganz!) * 10_000n + BigInt(vier.slice(0, 4));
  if (Number(vier[4]) >= 5) mikro += 1n;
  return Number(vz === '-' ? -mikro : mikro);
}

/** Zerlegt [von, bisExklusiv) in Abschnitte von höchstens 31 Tagen. */
export function abschnitte(von: string, bisExklusiv: string): [string, string][] {
  const aus: [string, string][] = [];
  for (let start = von; start < bisExklusiv;) {
    const ende =
      plusTage(start, MAX_TAGE_JE_ABRUF) < bisExklusiv
        ? plusTage(start, MAX_TAGE_JE_ABRUF)
        : bisExklusiv;
    aus.push([start, ende]);
    start = ende;
  }
  return aus;
}

interface Seite {
  data?: unknown[];
  has_more?: boolean;
  next_page?: string | null;
}

async function* zeilen(
  o: AnalyticsOptionen,
  endpunkt: 'user_usage_report' | 'user_cost_report',
  von: string,
  bisExklusiv: string,
): AsyncGenerator<Record<string, unknown>> {
  const f = o.fetch ?? fetch;
  const warte = o.warte ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const basis = (o.basis ?? ANALYTICS_BASIS).replace(/\/+$/, '');
  for (const [start, ende] of abschnitte(von, bisExklusiv)) {
    let seite: string | null = null;
    let wiederholungen = 0;
    let neustart = false;
    for (;;) {
      const p = new URLSearchParams();
      p.set('starting_at', `${start}T00:00:00Z`);
      p.set('ending_at', `${ende}T00:00:00Z`);
      p.set('bucket_width', '1d');
      p.append('products[]', 'claude_code');
      p.append('group_by[]', 'model');
      p.set('limit', String(LIMIT));
      if (seite) p.set('page', seite);
      let antwort: Response;
      try {
        antwort = await f(`${basis}/${endpunkt}?${p.toString()}`, {
          headers: { 'x-api-key': o.key, 'anthropic-version': ANTHROPIC_VERSION },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new AnalyticsFehler('netz', null, 'Analytics API nicht erreichbar');
      }
      if (antwort.status === 429 && wiederholungen < (o.maxWiederholungen ?? 3)) {
        wiederholungen += 1;
        const sek = Number(antwort.headers.get('retry-after'));
        await warte(
          Math.min(Number.isFinite(sek) && sek > 0 ? sek : 2 ** wiederholungen * 5, 60) * 1000,
        );
        continue;
      }
      if (antwort.status === 410 && !neustart) {
        // Cursor abgelaufen (Daten aktualisiert): Abschnitt einmal von vorn.
        neustart = true;
        seite = null;
        continue;
      }
      if (!antwort.ok) {
        const art: AnalyticsFehlerArt =
          antwort.status === 401 || antwort.status === 403
            ? 'auth'
            : antwort.status === 429
              ? 'rate'
              : antwort.status >= 500
                ? 'server'
                : 'anfrage';
        const text =
          art === 'auth'
            ? 'Analytics-Key abgelehnt (Scope read:analytics, nur Claude Enterprise)'
            : art === 'rate'
              ? 'Rate-Limit der Analytics API (60 Anfragen je Minute) erreicht'
              : `Analytics API antwortet mit HTTP ${antwort.status}`;
        throw new AnalyticsFehler(art, antwort.status, text);
      }
      const json = (await antwort.json()) as Seite;
      for (const z of json.data ?? [])
        if (z && typeof z === 'object') yield z as Record<string, unknown>;
      if (!json.has_more || !json.next_page) break;
      seite = json.next_page;
    }
  }
}

function akteurUndTag(
  o: AnalyticsOptionen,
  z: Record<string, unknown>,
): { akteur: AkteurSchluessel; tag: string; model: string } | null {
  const actor = (z.actor ?? {}) as Record<string, unknown>;
  const userId = typeof actor.user_id === 'string' ? actor.user_id : null;
  const start = typeof z.starting_at === 'string' ? z.starting_at : null;
  if (!userId || !start) return null;
  const email = typeof actor.email_address === 'string' ? actor.email_address : null;
  return {
    akteur: o.pseudonymisiere(userId, email),
    tag: new Date(start).toISOString().slice(0, 10),
    model: typeof z.model === 'string' && z.model ? z.model : 'unbekannt',
  };
}

/** Tokens je Person, Tag (UTC) und Modell; nur Claude Code. */
export async function holeNutzung(
  o: AnalyticsOptionen,
  von: string,
  bisExklusiv: string,
): Promise<NutzungZeile[]> {
  const aus: NutzungZeile[] = [];
  for await (const z of zeilen(o, 'user_usage_report', von, bisExklusiv)) {
    const k = akteurUndTag(o, z);
    if (!k) continue;
    const cc = (z.cache_creation ?? {}) as Record<string, unknown>;
    const w5 = zahl(cc.ephemeral_5m_input_tokens);
    const w1 = zahl(cc.ephemeral_1h_input_tokens);
    aus.push({
      ...k,
      input: zahl(z.uncached_input_tokens),
      output: zahl(z.output_tokens),
      cache_read: zahl(z.cache_read_input_tokens),
      cache_write: w5 + w1,
      cache_write_1h: w1,
      requests: zahl(z.requests),
    });
  }
  return aus;
}

/** Kosten (Usage Credits) je Person, Tag (UTC) und Modell in Mikro-USD. */
export async function holeKosten(
  o: AnalyticsOptionen,
  von: string,
  bisExklusiv: string,
): Promise<KostenZeile[]> {
  const aus: KostenZeile[] = [];
  for await (const z of zeilen(o, 'user_cost_report', von, bisExklusiv)) {
    const k = akteurUndTag(o, z);
    if (!k) continue;
    if (typeof z.currency === 'string' && z.currency !== 'USD') continue;
    aus.push({
      ...k,
      amountUsdMicros: centZuMikro(z.amount) ?? 0,
      listAmountUsdMicros: centZuMikro(z.list_amount),
    });
  }
  return aus;
}
