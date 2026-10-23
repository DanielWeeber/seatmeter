// Issue-Schlüssel: Ingest B (Agent-Feld `issue_schluessel`) und A (Ressourcen-Attribut
// `seatmeter.issue_schluessel`, Branch-Attribut nur als Schlüssel), Positivliste je Mandant,
// Monatsaggregat und die Routen `/api/v1/projekte/:id/issues` und `/api/v1/issues` samt Rechten.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enrollmentAntwortSchema,
  issuesAntwortSchema,
  projektIssuesAntwortSchema,
  type AgentAnfrage,
} from '@seatmeter/shared';
import { aggregiereTage } from '../src/aggregation/job.js';
import { heuteIn } from '../src/aggregation/tage.js';
import { withMandant } from '../src/db/mandant.js';
import { meldeAn } from './api-hilfen.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  TEST_ORG,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

const S1 = '11111111-1111-4111-8111-000000000001';
const S2 = '11111111-1111-4111-8111-000000000002';
const S3 = '11111111-1111-4111-8111-000000000003';

async function rechnerToken(u: TestUmgebung, mandantId: string): Promise<string> {
  const code = await u.app.inject({
    method: 'POST',
    url: '/api/v1/rechner/einmalcode',
    headers: await adminKopf(u, mandantId),
    payload: {},
  });
  expect(code.statusCode).toBe(201);
  const enroll = await u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/enroll',
    payload: { code: code.json().code, os: 'linux', agent_version: '0.1.3' },
  });
  expect(enroll.statusCode).toBe(201);
  return enrollmentAntwortSchema.parse(enroll.json()).token;
}

const ts = () => new Date(Date.now() - 60_000).toISOString();

function anfrageB(nr: number, teil: Partial<AgentAnfrage>): AgentAnfrage {
  return {
    request_id: `req_B${nr}`,
    message_id: `msg_B${nr}`,
    session_id: S1,
    ts: ts(),
    model: 'claude-opus-5-5',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    web_search_requests: 0,
    speed: 'normal',
    service_tier: 'standard',
    inference_geo: 'eu',
    ist_subagent: false,
    cc_version: '2.1.309',
    projekt: {
      url_norm: 'https://github.com/example-org/example-repo',
      provider: 'github',
      owner: 'example-org',
      repo_name: 'example-repo',
    },
    auth_hinweis: {
      klasse: 'oauth',
      org_uuid: TEST_ORG,
      account_uuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    },
    ...teil,
  };
}

function pushen(u: TestUmgebung, token: string, anfragen: AgentAnfrage[]) {
  return u.app.inject({
    method: 'POST',
    url: '/api/ingest/v1/anfragen',
    headers: { authorization: `Bearer ${token}` },
    payload: { agent_version: '0.1.3', anfragen },
  });
}

type Attribut = { key: string; value: Record<string, unknown> };
type LogKoerper = {
  resourceLogs: {
    resource: { attributes: Attribut[] };
    scopeLogs: { logRecords: { attributes: Attribut[] }[] }[];
  }[];
};

/** OTLP-Ereignis `api_request` (Fixture) mit zusätzlichen Ressourcen- und Ereignis-Attributen. */
function aKoerper(
  requestId: string,
  ressource: Record<string, string>,
  ereignis: Record<string, string> = {},
): Record<string, unknown> {
  const k = fixture('logs-api-request.json', { requestId }) as unknown as LogKoerper;
  const rl = k.resourceLogs[0];
  const rec = rl?.scopeLogs[0]?.logRecords[0];
  if (!rl || !rec) throw new Error('Fixture ohne logRecord');
  for (const [key, w] of Object.entries(ressource))
    rl.resource.attributes.push({ key, value: { stringValue: w } });
  for (const [key, w] of Object.entries(ereignis))
    rec.attributes.push({ key, value: { stringValue: w } });
  return k as unknown as Record<string, unknown>;
}

async function schluesselVon(u: TestUmgebung, mandantId: string) {
  return withMandant(u.db, mandantId, async (trx) => {
    const r = await trx
      .selectFrom('anfrage')
      .select(['anfrage_key', 'issue_schluessel'])
      .orderBy('anfrage_key')
      .execute();
    return Object.fromEntries(r.map((z) => [z.anfrage_key, z.issue_schluessel]));
  });
}

describe('Issue-Schlüssel: Ingest, Aggregat, API', () => {
  let u: TestUmgebung;
  let mandantId: string;
  let projektId: string;
  const heute = heuteIn('Europe/Berlin');
  const monat = heute.slice(0, 7);

  beforeAll(async () => {
    u = await testUmgebung();
    const m = await testMandant(u);
    mandantId = m.mandantId;
    const token = await rechnerToken(u, mandantId);
    const b = await pushen(u, token, [
      anfrageB(1, { input_tokens: 1000, output_tokens: 100, issue_schluessel: ['ABC-1'] }),
      anfrageB(2, { input_tokens: 300, issue_schluessel: ['ABC-1', 'ABC-2'] }),
      anfrageB(3, { session_id: S2, input_tokens: 50, issue_schluessel: [] }),
      anfrageB(4, { session_id: S2, input_tokens: 70 }),
      anfrageB(5, { session_id: S3, input_tokens: 40, issue_schluessel: ['XYZ-9'] }),
    ]);
    expect(b.statusCode).toBe(200);
    // Quelle A: Schlüssel aus dem Ressourcen-Attribut (Start-Wrapper), aus einem Branch-Attribut und
    // für eine Anfrage, die B schon kennt (B hat Vorrang).
    for (const k of [
      aKoerper('req_A1', { 'seatmeter.issue_schluessel': 'ABC-3|abc-4' }),
      aKoerper('req_A2', {}, { 'vcs.ref.head.name': 'feature/QQ-5-geheimer-titel' }),
      aKoerper('req_A3', {}),
      aKoerper('req_B1', { 'seatmeter.issue_schluessel': 'ABC-99' }),
    ]) {
      const r = await otlpSenden(u, 'logs', m.token, k);
      expect(r.statusCode).toBe(200);
    }
    const p = await withMandant(u.db, mandantId, (trx) =>
      trx.selectFrom('projekt').select('id').executeTakeFirstOrThrow(),
    );
    projektId = p.id;
    await aggregiereTage(u.db, mandantId, heute, heute);
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('speichert nur Schlüssel (B je Anfrage, A aus Ressource/Branch), B vor A, nie den Branch', async () => {
    expect(await schluesselVon(u, mandantId)).toEqual({
      req_A1: ['ABC-3', 'ABC-4'],
      req_A2: ['QQ-5'],
      req_A3: null,
      req_B1: ['ABC-1'],
      req_B2: ['ABC-1', 'ABC-2'],
      req_B3: [],
      req_B4: null,
      req_B5: ['XYZ-9'],
    });
    const dump = await withMandant(u.db, mandantId, async (trx) =>
      (await sql<{ t: string }>`SELECT row_to_json(a)::text AS t FROM anfrage a`.execute(trx)).rows
        .map((z) => z.t)
        .join('\n'),
    );
    expect(dump).not.toContain('geheimer-titel');
    expect(dump).not.toContain('feature/');
    expect(u.logs()).not.toContain('geheimer-titel');
  });

  it('lehnt ungültige Schlüssel im Push ab (strenges Schema)', async () => {
    const token = await rechnerToken(u, mandantId);
    const r = await pushen(u, token, [anfrageB(9, { issue_schluessel: ['feature/ABC-1'] })]);
    expect(r.statusCode).toBe(400);
  });

  it('Monatsaggregat: anteilig je Schlüssel, Sitzungen je Monat, ohne Schlüssel als Rest', async () => {
    const r = await u.app.inject({
      method: 'GET',
      url: `/api/v1/projekte/${projektId}/issues?monat=${monat}`,
      headers: await adminKopf(u, mandantId, 'controller'),
    });
    expect(r.statusCode).toBe(200);
    const d = projektIssuesAntwortSchema.parse(r.json());
    const je = Object.fromEntries(d.issues.map((i) => [i.schluessel, i]));
    expect(Object.keys(je).sort()).toEqual(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'QQ-5', 'XYZ-9']);
    // B1 (A-Tokens haben Vorrang: 1200/350) + Hälfte von B2 (150). Zwei Sitzungen, weil A für B1
    // seine Sitzungs-ID (Fixture) mitbringt und A beim Feldvorrang die Sitzung setzt.
    expect(je['ABC-1']).toMatchObject({ anfragen: 2, sitzungen: 2, projekt_schluessel: 'ABC' });
    expect(je['ABC-1']?.tokens.input).toBe(1200 + 150);
    expect(je['ABC-2']?.tokens.input).toBe(150);
    expect(je['ABC-3']?.tokens.input).toBe(600);
    expect(je['ABC-4']?.tokens.input).toBe(600);
    expect(je['XYZ-9']?.sitzungen).toBe(1);
    expect(je['ABC-1']?.schatten_usd_micros).toBeGreaterThan(0);
    // ohne Schlüssel: B3, B4 und A3 (A-Fixture: 1200 Input).
    expect(d.ohne_schluessel.tokens.input).toBe(50 + 70 + 1200);
    const summe = d.issues.reduce((s, i) => s + i.schatten_usd_micros, 0);
    expect(summe + d.ohne_schluessel.schatten_usd_micros).toBe(d.gesamt.schatten_usd_micros);
  });

  it('GET /api/v1/issues über alle Projekte, CSV mit Audit', async () => {
    const kopf = await adminKopf(u, mandantId);
    const r = await u.app.inject({
      method: 'GET',
      url: `/api/v1/issues?monat=${monat}`,
      headers: kopf,
    });
    expect(r.statusCode).toBe(200);
    const d = issuesAntwortSchema.parse(r.json());
    expect(d.issues.find((i) => i.schluessel === 'ABC-1')?.projekt).toEqual({
      id: projektId,
      name: 'example-org/example-repo',
    });
    const c = await u.app.inject({
      method: 'GET',
      url: `/api/v1/projekte/${projektId}/issues?monat=${monat}&format=csv`,
      headers: kopf,
    });
    expect(c.statusCode).toBe(200);
    expect(c.headers['content-type']).toContain('text/csv');
    expect(c.body).toContain('ABC-1;ABC;');
    const audit = await withMandant(u.db, mandantId, (trx) =>
      trx
        .selectFrom('audit')
        .select(['aktion', 'objekt'])
        .where('aktion', '=', 'Export Issues')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.objekt).toBe(`issues projekt:${projektId} monat:${monat} format:csv`);
  });

  it('Rechte: Projektleiter nur eigene Projekte, anderer Mandant sieht nichts', async () => {
    const fremd = await meldeAn(u.db, mandantId, 'projektleiter', [
      '00000000-0000-4000-8000-000000000099',
    ]);
    const r = await u.app.inject({
      method: 'GET',
      url: `/api/v1/projekte/${projektId}/issues`,
      headers: fremd.headers,
    });
    expect(r.statusCode).toBe(404);
    const alle = await u.app.inject({
      method: 'GET',
      url: '/api/v1/issues',
      headers: fremd.headers,
    });
    expect(issuesAntwortSchema.parse(alle.json()).issues).toEqual([]);
    const eigen = await meldeAn(u.db, mandantId, 'projektleiter', [projektId]);
    const ok = await u.app.inject({
      method: 'GET',
      url: `/api/v1/projekte/${projektId}/issues`,
      headers: eigen.headers,
    });
    expect(ok.statusCode).toBe(200);

    const anderer = await testMandant(u);
    const kopf = await adminKopf(u, anderer.mandantId);
    const leer = await u.app.inject({ method: 'GET', url: '/api/v1/issues', headers: kopf });
    expect(issuesAntwortSchema.parse(leer.json()).issues).toEqual([]);
    const fremdesProjekt = await u.app.inject({
      method: 'GET',
      url: `/api/v1/projekte/${projektId}/issues`,
      headers: kopf,
    });
    expect(fremdesProjekt.statusCode).toBe(404);
  });

  it('Positivliste je Mandant: nur bekannte Projektschlüssel werden gespeichert', async () => {
    const m = await testMandant(u);
    await withMandant(u.db, m.mandantId, (trx) =>
      trx
        .updateTable('mandant')
        .set({ issue_praefixe: ['ABC'] })
        .execute(),
    );
    const token = await rechnerToken(u, m.mandantId);
    expect(
      (
        await pushen(u, token, [
          anfrageB(1, { input_tokens: 5, issue_schluessel: ['ABC-7', 'XYZ-8'] }),
        ])
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await otlpSenden(
          u,
          'logs',
          m.token,
          aKoerper('req_A1', { 'seatmeter.issue_schluessel': 'XYZ-1' }),
        )
      ).statusCode,
    ).toBe(200);
    expect(await schluesselVon(u, m.mandantId)).toEqual({ req_A1: [], req_B1: ['ABC-7'] });
  });
});
