// Hilfen der Modul-Tests (Budgets, Hinweise, Abgleich, Jira): lokaler HTTP-Empfänger (Webhook, Relay, Analytics-
// Fixtures), Tagesaggregat- und Kurszeilen direkt in der DB.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Db } from '../src/db/db.js';

export const M = 1_000_000;

export interface Empfangen {
  pfad: string;
  header: IncomingHttpHeaders;
  koerper: unknown;
}

export interface Empfaenger {
  url: string;
  anfragen: Empfangen[];
  /** Nächste Antworten (Status, Körper, Header); leer = 200 `{ ok: true }`. */
  antworten: { status: number; body?: unknown; header?: Record<string, string> }[];
  /** Feste Antworten je Pfad-Präfix (Analytics-Fixtures), Funktion bekommt die URL. */
  routen: ((
    url: URL,
  ) => { status: number; body: unknown; header?: Record<string, string> } | null)[];
  schliessen(): Promise<void>;
}

export async function starteEmpfaenger(): Promise<Empfaenger> {
  const e: Omit<Empfaenger, 'url' | 'schliessen'> = { anfragen: [], antworten: [], routen: [] };
  const server: Server = createServer((req, res) => {
    let roh = '';
    req.on('data', (c: Buffer) => (roh += c.toString('utf8')));
    req.on('end', () => {
      let koerper: unknown = roh;
      try {
        koerper = roh ? JSON.parse(roh) : null;
      } catch {
        /* Text */
      }
      e.anfragen.push({ pfad: req.url ?? '', header: req.headers, koerper });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      for (const r of e.routen) {
        const a = r(url);
        if (a) {
          res.writeHead(a.status, { 'content-type': 'application/json', ...(a.header ?? {}) });
          res.end(JSON.stringify(a.body));
          return;
        }
      }
      const a = e.antworten.shift() ?? { status: 200, body: { ok: true } };
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.header ?? {}) });
      res.end(JSON.stringify(a.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    ...e,
    url: `http://127.0.0.1:${port}`,
    schliessen: () => new Promise<void>((r) => server.close(() => r())),
  } as Empfaenger;
}

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/analytics/${name}`, import.meta.url), 'utf8'));
}

export async function tagAggregat(
  db: Db,
  mandantId: string,
  zeilen: {
    tag: string;
    person: string | null;
    projekt: string | null;
    usd: number;
    model?: string;
    speed?: string;
    tokens?: {
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
      cache_write_1h?: number;
    };
    preis?: string | null;
  }[],
): Promise<void> {
  await db
    .insertInto('tag_aggregat')
    .values(
      zeilen.map((z) => ({
        mandant_id: mandantId,
        tag: z.tag,
        person_id: z.person,
        projekt_id: z.projekt,
        model: z.model ?? 'claude-opus-5-5',
        speed: z.speed ?? 'normal',
        auth_klasse: 'abo' as const,
        input: z.tokens?.input ?? 0,
        output: z.tokens?.output ?? 0,
        cache_read: z.tokens?.cache_read ?? 0,
        cache_write: z.tokens?.cache_write ?? 0,
        cache_write_1h: z.tokens?.cache_write_1h ?? z.tokens?.cache_write ?? 0,
        anfragen: 1,
        schatten_usd_micros: Math.round(z.usd * M),
        preis_version: z.preis === undefined ? 'global:claude-opus-5@2026-01-01' : z.preis,
      })),
    )
    .execute();
}

export async function kurs(
  db: Db,
  mandantId: string,
  monat: string,
  usdEur: number,
): Promise<void> {
  await db
    .insertInto('kurs')
    .values({ mandant_id: mandantId, monat: `${monat}-01`, usd_eur: usdEur, quelle: 'manuell' })
    .execute();
}
