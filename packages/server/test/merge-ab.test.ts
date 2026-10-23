// Phase 2 „Agent B + Dedup“ (Architektur §3.4, §11): echter Agent (aus packages/agent) gegen den
// Server im Prozess, Quelle A über die OTLP-Fixture, danach der Job `merge.ab`.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main as agent } from '../../agent/src/cli.js';
import { ladeAnfragen } from '../../agent/src/warteschlange.js';
import {
  eingerichtet,
  ORG,
  S1,
  testUmgebung as agentUmgebung,
  type TestUmgebung as AgentUmgebung,
} from '../../agent/test/hilfen.js';
import { withMandant } from '../src/db/mandant.js';
import { fuehreJobAus } from '../src/jobs/index.js';
import { KERN_MODULE } from '../src/kern.js';
import { mergeJob, paareWaehlen } from '../src/merge/job.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  TEST_ORG,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

/** fetch des Agenten → app.inject (kein Netz). */
function bruecke(app: FastifyInstance) {
  const f = (async (eingabe: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(eingabe));
    const r = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(r.statusCode === 204 ? null : r.body, {
      status: r.statusCode,
      headers: { 'content-type': String(r.headers['content-type'] ?? 'application/json') },
    });
  }) as AgentUmgebung['fetch'];
  f.mitschnitt = [];
  return f;
}

interface AEreignis {
  sessionId: string;
  model: string;
  ts: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requestId: string | null;
  clientRequestId: string;
}

type Attribut = { key: string; value: Record<string, unknown> };

/** OTLP-Fixture `logs-api-request.json` mit den Werten eines Ereignisses. */
function aKoerper(e: AEreignis): Record<string, unknown> {
  const k = fixture('logs-api-request.json', { jetzt: new Date(e.ts) }) as {
    resourceLogs: { scopeLogs: { logRecords: { attributes: Attribut[] }[] }[] }[];
  };
  const rec = k.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
  if (!rec) throw new Error('Fixture ohne logRecord');
  const werte: Record<string, Record<string, unknown>> = {
    'session.id': { stringValue: e.sessionId },
    model: { stringValue: e.model },
    input_tokens: { stringValue: String(e.input) },
    output_tokens: { stringValue: String(e.output) },
    cache_read_tokens: { stringValue: String(e.cacheRead) },
    cache_creation_tokens: { stringValue: String(e.cacheCreation) },
    client_request_id: { stringValue: e.clientRequestId },
    'event.timestamp': { stringValue: e.ts },
  };
  if (e.requestId) werte.request_id = { stringValue: e.requestId };
  rec.attributes = rec.attributes
    .filter((a) => e.requestId !== null || a.key !== 'request_id')
    .map((a) => (werte[a.key] ? { key: a.key, value: werte[a.key] } : a));
  return k as unknown as Record<string, unknown>;
}

interface Zeile {
  anfrage_key: string;
  ts: Date;
  quellen: number;
  heuristisch: boolean;
  abweichung_ab: boolean;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_1h: number | null;
  projekt_id: string | null;
  ist_subagent: boolean | null;
}

async function zeilen(u: TestUmgebung, mandantId: string): Promise<Zeile[]> {
  return withMandant(
    u.db,
    mandantId,
    async (trx) =>
      (
        await sql<Zeile>`SELECT anfrage_key, ts, quellen, heuristisch, abweichung_ab, input, output,
        cache_read, cache_write, cache_write_1h, projekt_id, ist_subagent
        FROM anfrage ORDER BY anfrage_key`.execute(trx)
      ).rows,
  );
}

/** Rechner registrieren über den echten Agenten (`enroll`) und eine Agent-Umgebung liefern. */
async function agentEinrichten(u: TestUmgebung, mandantId: string): Promise<AgentUmgebung> {
  const code = await u.app.inject({
    method: 'POST',
    url: '/api/v1/rechner/einmalcode',
    headers: await adminKopf(u, mandantId),
    payload: { bezeichnung: 'Testrechner' },
  });
  expect(code.statusCode).toBe(201);
  const a = agentUmgebung();
  a.fetch = bruecke(u.app);
  let out = '';
  const ausgabe = { out: (t: string) => (out += t), err: (t: string) => (out += t) };
  expect(
    await agent(['enroll', code.json().code, '--server', 'https://ingest.example.org'], ausgabe, {
      umgebung: a,
    }),
  ).toBe(0);
  eingerichtet(a, {}, false);
  return a;
}

async function agentLauf(a: AgentUmgebung): Promise<string> {
  let out = '';
  const ausgabe = { out: (t: string) => (out += t), err: (t: string) => (out += t) };
  expect(await agent(['scan', '--push'], ausgabe, { umgebung: a })).toBe(0);
  return out;
}

describe('Agent B gegen den Server und Merge A/B (Phase 2)', () => {
  let u: TestUmgebung;

  beforeAll(async () => {
    u = await testUmgebung();
    expect(ORG).toBe(TEST_ORG);
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('(b, e, f) nur B: Summen exakt wie im Transkript, 5m/1h, Projekte je Anfrage, Port 2222 normalisiert', async () => {
    const { mandantId } = await testMandant(u);
    const a = await agentEinrichten(u, mandantId);
    const out = await agentLauf(a);
    expect(out).toContain('Push: ok, gesendet 5 (neu 5');
    expect(ladeAnfragen(a)).toHaveLength(0);
    const z = await zeilen(u, mandantId);
    expect(z).toHaveLength(5);
    expect(z.every((r) => r.quellen === 2)).toBe(true);
    const summe = (f: keyof Zeile) => z.reduce((s, r) => s + Number(r[f] ?? 0), 0);
    expect([
      summe('input'),
      summe('output'),
      summe('cache_read'),
      summe('cache_write'),
      summe('cache_write_1h'),
    ]).toEqual([41, 271, 2800, 950, 400]);
    const projekte = await withMandant(u.db, mandantId, (trx) =>
      trx.selectFrom('projekt').select(['id', 'url_norm']).orderBy('url_norm').execute(),
    );
    expect(projekte.map((p) => p.url_norm)).toEqual([
      'https://git.example.org/kunde/alpha',
      'https://github.com/kunde/beta',
    ]);
    const beta = projekte.find((p) => p.url_norm?.includes('beta'))?.id;
    expect(z.filter((r) => r.projekt_id === beta).map((r) => r.anfrage_key)).toEqual(['req_03FIX']);
    expect(z.find((r) => r.anfrage_key === 'req_S1FIX')?.ist_subagent).toBe(true);
    // Sitzung mit Bit B, Start/Ende aus dem Sitzungs-Push
    const s = await withMandant(u.db, mandantId, (trx) =>
      trx
        .selectFrom('sitzung')
        .select(['quellen', 'start', 'ende'])
        .where('session_id', '=', S1)
        .executeTakeFirstOrThrow(),
    );
    expect(s.quellen).toBe(2);
    // Zweiter Lauf: idempotent, nichts Neues
    expect(await agentLauf(a)).toContain('gesendet 0');
    expect(await zeilen(u, mandantId)).toHaveLength(5);
  });

  it('(a, g) A und B: Schlüsseltreffer → eine Zeile; msg:-Paar → Merge; ungleiches Tupel → nie Merge, nur Abweichung', async () => {
    const { mandantId, token } = await testMandant(u);
    const a = await agentEinrichten(u, mandantId);
    const basis = new Date(a.jetzt().getTime() - 3600_000);
    const t = (s: number) => new Date(basis.getTime() + s * 1000).toISOString();
    const ereignisse: AEreignis[] = [
      // req_02FIX: A mit request_id, gleiche Tokens wie B → Schlüsseltreffer beim Ingest.
      {
        sessionId: S1,
        model: 'claude-opus-5-5',
        ts: t(10),
        input: 3,
        output: 40,
        cacheRead: 1200,
        cacheCreation: 300,
        requestId: 'req_02FIX',
        clientRequestId: 'c1',
      },
      // msg_04FIX: A ohne request_id (älteres Claude Code), 1 s versetzt, gleiches Tupel → Heuristik.
      {
        sessionId: S1,
        model: 'claude-opus-5-5',
        ts: t(31),
        input: 1,
        output: 11,
        cacheRead: 100,
        cacheCreation: 50,
        requestId: null,
        clientRequestId: 'c4',
      },
      // Subagent: A ohne request_id, Tupel weicht ab (output 31 statt 30) → nie zusammenführen.
      {
        sessionId: S1,
        model: 'claude-haiku-5-5',
        ts: t(15),
        input: 20,
        output: 31,
        cacheRead: 0,
        cacheCreation: 400,
        requestId: null,
        clientRequestId: 'cS',
      },
    ];
    for (const e of ereignisse)
      expect((await otlpSenden(u, 'logs', token, aKoerper(e))).statusCode).toBe(200);
    await agentLauf(a);

    const vorher = await zeilen(u, mandantId);
    expect(vorher.find((r) => r.anfrage_key === 'req_02FIX')).toMatchObject({
      quellen: 3,
      abweichung_ab: false,
      cache_write_1h: 200,
    });
    expect(vorher.map((r) => r.anfrage_key)).toEqual(
      expect.arrayContaining(['msg:c4', 'msg:msg_04FIX', 'msg:cS', 'req_S1FIX']),
    );
    expect(vorher).toHaveLength(7);

    const lauf = await fuehreJobAus(
      KERN_MODULE.flatMap((m) => m.jobs ?? []),
      'merge.ab',
      { db: u.db, konfiguration: u.konfiguration },
    );
    expect(lauf.status).toBe('ok');
    const nachher = await zeilen(u, mandantId);
    expect(nachher).toHaveLength(6);
    expect(nachher.find((r) => r.anfrage_key === 'msg:msg_04FIX')).toBeUndefined();
    expect(nachher.find((r) => r.anfrage_key === 'msg:c4')).toMatchObject({
      quellen: 3,
      heuristisch: true,
      abweichung_ab: false,
      input: 1,
      output: 11,
      cache_write_1h: 0,
    });
    expect(nachher.find((r) => r.anfrage_key === 'msg:c4')?.projekt_id).not.toBeNull();
    // Ungleiches Tupel: beide Zeilen bleiben, beide als Abweichung markiert.
    expect(nachher.find((r) => r.anfrage_key === 'msg:cS')).toMatchObject({
      quellen: 1,
      heuristisch: false,
      abweichung_ab: true,
    });
    expect(nachher.find((r) => r.anfrage_key === 'req_S1FIX')).toMatchObject({
      quellen: 2,
      abweichung_ab: true,
    });
    // Jede Anfrage einmal: Σ output = B-Summe + nur die abweichende A-Zeile.
    expect(nachher.reduce((s, r) => s + Number(r.output), 0)).toBe(271 + 31);

    // Idempotent: zweiter Lauf ändert nichts.
    const zweiter = await mergeJob({ db: u.db, konfiguration: u.konfiguration });
    expect(zweiter.zusammengefuehrt).toBe(0);
    expect(await zeilen(u, mandantId)).toEqual(nachher);

    const job = await u.db
      .selectFrom('job_lauf')
      .select(['status', 'ergebnis'])
      .where('job', '=', 'merge.ab')
      .orderBy('gestartet', 'desc')
      .executeTakeFirstOrThrow();
    expect(job.status).toBe('ok');
    expect(job.ergebnis).toMatchObject({ zusammengefuehrt: 1, abweichung_markiert: 2 });

    // B schickt alles erneut (Zustand verloren): Schlüsseltreffer sind Wiederholungen, die
    // msg:-Zeile entsteht neu und wird beim nächsten Lauf wieder zusammengeführt.
    rmSync(join(a.agentDir, 'state.json'));
    await agentLauf(a);
    expect(await zeilen(u, mandantId)).toHaveLength(7);
    expect((await mergeJob({ db: u.db, konfiguration: u.konfiguration })).zusammengefuehrt).toBe(1);
    expect(await zeilen(u, mandantId)).toEqual(nachher);
  });

  it('Vollständigkeit je Sitzung gegen otel_kontrollsumme', async () => {
    const { mandantId } = await testMandant(u);
    const a = await agentEinrichten(u, mandantId);
    await agentLauf(a);
    const tag = new Date(a.jetzt().getTime() - 3600_000).toISOString().slice(0, 10);
    await withMandant(u.db, mandantId, (trx) =>
      trx
        .insertInto('otel_kontrollsumme')
        .values([
          {
            mandant_id: mandantId,
            tag,
            session_id: S1,
            model: 'claude-opus-5-5',
            typ: 'input',
            wert: 4062,
          },
          {
            mandant_id: mandantId,
            tag,
            session_id: 'nur-a-sitzung',
            model: 'claude-opus-5-5',
            typ: 'input',
            wert: 100,
          },
        ])
        .execute(),
    );
    const e = await mergeJob({ db: u.db, konfiguration: u.konfiguration });
    // S1: 41+271+2800+950 = 4062 → vollständig; die zweite Sitzung fehlt ganz → abweichend.
    expect(e.sitzungen_geprueft).toBeGreaterThanOrEqual(2);
    expect(e.sitzungen_abweichend).toBeGreaterThanOrEqual(1);
  });
});

describe('paareWaehlen', () => {
  const k = (a: string, b: string, gleich = true) => ({
    a_key: a,
    a_ts: new Date(0),
    b_key: b,
    b_ts: new Date(0),
    gleich,
  });

  it('führt nur eindeutige Paare zusammen', () => {
    expect(paareWaehlen([k('msg:a1', 'msg:b1')]).merge).toHaveLength(1);
    const zweiA = paareWaehlen([k('msg:a1', 'msg:b1'), k('msg:a2', 'msg:b1')]);
    expect(zweiA.merge).toHaveLength(0);
    expect(zweiA.mehrdeutig).toBe(1);
    const zweiB = paareWaehlen([k('msg:a1', 'msg:b1'), k('msg:a1', 'msg:b2')]);
    expect(zweiB.merge).toHaveLength(0);
  });

  it('ungleiches Tupel wird nie zusammengeführt, nur bei Eindeutigkeit als Abweichung markiert', () => {
    const r = paareWaehlen([k('msg:a1', 'msg:b1', false)]);
    expect(r.merge).toHaveLength(0);
    expect(r.abweichung).toHaveLength(1);
    const neben = paareWaehlen([k('msg:a1', 'msg:b1', true), k('msg:a2', 'msg:b1', false)]);
    expect(neben.merge).toHaveLength(1);
    expect(neben.abweichung).toHaveLength(0);
  });
});
