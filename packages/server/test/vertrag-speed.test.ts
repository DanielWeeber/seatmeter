// Phase-1c-Nacharbeiten: Antwortschemas aus shared für /api/v1/rechner und /api/health/ingest,
// ein Wert für „kein Fast-Modus“ (`standard` aus Transkripten → `normal`) samt Datenmigration 0016.
import { randomUUID } from 'node:crypto';
import {
  enrollmentAntwortSchema,
  ingestHealthSchema,
  rechnerListeSchema,
  type AgentAnfrage,
  type IngestHealth,
} from '@seatmeter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { up as speedMigration } from '../src/db/migrations/2026_10_22_0016_speed_normal.js';
import type { IngestStatus } from '../src/health/routes.js';
import { legePersonAn } from './api-hilfen.js';
import {
  adminKopf,
  TEST_ORG,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

/** `true`, wenn A an B zuweisbar ist (Server-Typ passt zum Vertrag in shared). */
type Zuweisbar<A, B> = [A] extends [B] ? true : false;

function agentAnfrage(teil: Partial<AgentAnfrage> = {}): AgentAnfrage {
  return {
    request_id: `req_${randomUUID()}`,
    message_id: `msg_${randomUUID()}`,
    session_id: randomUUID(),
    ts: new Date().toISOString(),
    model: 'claude-opus-5-5',
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    web_search_requests: 0,
    speed: 'standard',
    service_tier: 'standard',
    inference_geo: 'eu',
    ist_subagent: false,
    cc_version: '2.1.308',
    projekt: null,
    auth_hinweis: {
      klasse: 'oauth',
      org_uuid: TEST_ORG,
      account_uuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    },
    ...teil,
  };
}

describe('Antwortschemas (rechner, health/ingest) und speed', () => {
  let u: TestUmgebung;
  let mandantId: string;
  let token: string;

  beforeAll(async () => {
    u = await testUmgebung();
    mandantId = (await testMandant(u)).mandantId;
    const code = await u.app.inject({
      method: 'POST',
      url: '/api/v1/rechner/einmalcode',
      headers: await adminKopf(u, mandantId),
      payload: { bezeichnung: 'Testrechner' },
    });
    expect(code.statusCode).toBe(201);
    const enroll = await u.app.inject({
      method: 'POST',
      url: '/api/agent/v1/enroll',
      payload: { code: code.json().code, os: 'linux', agent_version: '0.1.1' },
    });
    expect(enroll.statusCode).toBe(201);
    token = enrollmentAntwortSchema.parse(enroll.json()).token;
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('GET /api/v1/rechner entspricht rechnerListeSchema', async () => {
    const r = await u.app.inject({
      method: 'GET',
      url: '/api/v1/rechner',
      headers: await adminKopf(u, mandantId),
    });
    expect(r.statusCode).toBe(200);
    const liste = rechnerListeSchema.parse(r.json());
    expect(liste.rechner).toEqual([
      expect.objectContaining({ bezeichnung: 'Testrechner', os: 'linux', widerrufen: null }),
    ]);
    // Kein Feld außerhalb des Vertrags.
    expect(Object.keys(r.json().rechner[0] as object).sort()).toEqual(
      Object.keys(liste.rechner[0] ?? {}).sort(),
    );
  });

  it('GET /api/health/ingest entspricht ingestHealthSchema (auch der Server-Typ)', async () => {
    const passt: Zuweisbar<IngestStatus, IngestHealth> = true;
    expect(passt).toBe(true);
    const r = await u.app.inject({ method: 'GET', url: '/api/health/ingest' });
    expect(r.statusCode).toBe(200);
    const h = ingestHealthSchema.parse(r.json());
    expect(h.status).toBe('ok');
  });

  it('Agent-Push: speed „standard“ wird als „normal“ gespeichert, „fast“ bleibt', async () => {
    const normal = agentAnfrage();
    const schnell = agentAnfrage({ speed: 'fast' });
    const r = await u.app.inject({
      method: 'POST',
      url: '/api/ingest/v1/anfragen',
      headers: { authorization: `Bearer ${token}` },
      payload: { agent_version: '0.1.1', anfragen: [normal, schnell] },
    });
    expect(r.statusCode).toBe(200);
    const zeilen = await u.db
      .selectFrom('anfrage')
      .select(['anfrage_key', 'speed'])
      .where('mandant_id', '=', mandantId)
      .execute();
    const speed = new Map(zeilen.map((z) => [z.anfrage_key, z.speed]));
    expect(speed.get(normal.request_id ?? '')).toBe('normal');
    expect(speed.get(schnell.request_id ?? '')).toBe('fast');
  });

  it('Migration 0016 gleicht alte Zeilen an und rechnet tag_aggregat zusammen', async () => {
    const m = (await testMandant(u)).mandantId;
    const person = await legePersonAn(u.db, m);
    const tag = new Date().toISOString().slice(0, 10);
    const basis = {
      mandant_id: m,
      ts: new Date(),
      tag,
      model: 'claude-opus-5-5',
      input: 1,
      output: 1,
      cache_read: 0,
      cache_write: 0,
      auth_klasse: 'abo',
      zaehlt_als_abo: true,
      quellen: 2,
    } as const;
    await u.db
      .insertInto('anfrage')
      .values([
        { ...basis, anfrage_key: `msg:${randomUUID()}`, speed: 'standard' },
        { ...basis, anfrage_key: `msg:${randomUUID()}`, speed: 'normal' },
      ])
      .execute();
    const zeile = {
      mandant_id: m,
      tag,
      person_id: person,
      projekt_id: null,
      model: 'claude-opus-5-5',
      auth_klasse: 'abo',
      output: 0,
      cache_read: 0,
      cache_write: 0,
      cache_write_1h: 0,
      web_search: 0,
    };
    await u.db
      .insertInto('tag_aggregat')
      .values([
        { ...zeile, speed: 'standard', input: 10, anfragen: 1, schatten_usd_micros: 100 },
        { ...zeile, speed: 'normal', input: 5, anfragen: 2, schatten_usd_micros: 50 },
        { ...zeile, model: 'claude-haiku-5', speed: 'standard', input: 3, anfragen: 1 },
      ])
      .execute();
    await speedMigration(u.db);
    await speedMigration(u.db); // wiederholbar
    const anfragen = await u.db
      .selectFrom('anfrage')
      .select('speed')
      .where('mandant_id', '=', m)
      .execute();
    expect(anfragen.map((z) => z.speed)).toEqual(['normal', 'normal']);
    const aggregat = await u.db
      .selectFrom('tag_aggregat')
      .select(['model', 'speed', 'input', 'anfragen', 'schatten_usd_micros'])
      .where('mandant_id', '=', m)
      .orderBy('model')
      .execute();
    expect(
      aggregat.map((z) => ({
        ...z,
        input: Number(z.input),
        schatten_usd_micros: Number(z.schatten_usd_micros),
      })),
    ).toEqual([
      { model: 'claude-haiku-5', speed: 'normal', input: 3, anfragen: 1, schatten_usd_micros: 0 },
      {
        model: 'claude-opus-5-5',
        speed: 'normal',
        input: 15,
        anfragen: 3,
        schatten_usd_micros: 150,
      },
    ]);
  });
});
