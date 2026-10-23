// Phase 5: Seite „Ausrollen“ (Modul ausrollen), Pfad-Projekte aus dem Agenten und eine
// Regressionsprüfung für 204-Routen (Kysely-Falle: `return reply.send()` in `withMandant` rollt zurück).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ausrollenKonfigurationSchema,
  enrollmentAntwortSchema,
  mandantenTokenAntwortSchema,
  type AgentAnfrage,
} from '@seatmeter/shared';
import { projektKey } from '@seatmeter/shared/hmac';
import { withMandant } from '../src/db/mandant.js';
import { sha256 } from '../src/krypto.js';
import { mandantSaltsLaden } from '../src/ingest-gemeinsam/geheimnis.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  TEST_ORG,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

async function rechnerToken(u: TestUmgebung, mandantId: string) {
  const code = await u.app.inject({
    method: 'POST',
    url: '/api/v1/rechner/einmalcode',
    headers: await adminKopf(u, mandantId),
    payload: { bezeichnung: 'Pilot-Mac' },
  });
  expect(code.statusCode).toBe(201);
  const enroll = await u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/enroll',
    payload: { code: code.json().code, os: 'macos', agent_version: '0.1.0' },
  });
  expect(enroll.statusCode).toBe(201);
  return enrollmentAntwortSchema.parse(enroll.json());
}

function anfrage(teil: Partial<AgentAnfrage> = {}): AgentAnfrage {
  return {
    request_id: `req_011PFAD${Math.random().toString(36).slice(2, 12)}`,
    message_id: `msg_01PFAD${Math.random().toString(36).slice(2, 12)}`,
    session_id: '6e8f2b3c-4d5e-4f60-9b1c-2d3e4f5a6b7c',
    ts: new Date().toISOString(),
    model: 'claude-haiku-5-5',
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    web_search_requests: 0,
    speed: null,
    service_tier: null,
    inference_geo: null,
    ist_subagent: false,
    cc_version: '2.1.308',
    projekt: { typ: 'pfad', name: 'beispiel/bereich' },
    auth_hinweis: {
      klasse: 'oauth',
      org_uuid: TEST_ORG,
      account_uuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    },
    ...teil,
  };
}

const pushen = (u: TestUmgebung, token: string, anfragen: unknown[]) =>
  u.app.inject({
    method: 'POST',
    url: '/api/ingest/v1/anfragen',
    headers: { authorization: `Bearer ${token}` },
    payload: { agent_version: '0.1.0', anfragen },
  });

describe('Phase 5: Ausrollen, Pfad-Projekte, 204-Routen', () => {
  let u: TestUmgebung;
  const vorher = process.env.SEATMETER_INGEST_URL;
  const vorherRelease = process.env.SEATMETER_AGENT_RELEASE_URL;

  beforeAll(async () => {
    u = await testUmgebung();
  });
  afterEach(() => {
    if (vorher === undefined) delete process.env.SEATMETER_INGEST_URL;
    else process.env.SEATMETER_INGEST_URL = vorher;
    if (vorherRelease === undefined) delete process.env.SEATMETER_AGENT_RELEASE_URL;
    else process.env.SEATMETER_AGENT_RELEASE_URL = vorherRelease;
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('GET /api/v1/ausrollen: Werte des Mandanten, nie ein Token; nur Mandanten-Admin', async () => {
    const m = await testMandant(u);
    process.env.SEATMETER_INGEST_URL = 'https://ingest.example.org/';
    process.env.SEATMETER_AGENT_RELEASE_URL =
      'https://git.example.org/acme/seatmeter/releases/download/v0.1.0/';
    const r = await u.app.inject({
      method: 'GET',
      url: '/api/v1/ausrollen',
      headers: await adminKopf(u, m.mandantId),
    });
    expect(r.statusCode).toBe(200);
    const k = ausrollenKonfigurationSchema.parse(r.json());
    expect(k.ingest_url).toBe('https://ingest.example.org');
    expect(k.ingest_url_quelle).toBe('konfiguration');
    expect(k.otlp_endpoint).toBe('https://ingest.example.org/otlp');
    expect(k.orgs.map((o) => o.org_uuid)).toEqual([TEST_ORG]);
    expect(k.agent.release_url).toBe(
      'https://git.example.org/acme/seatmeter/releases/download/v0.1.0',
    );
    expect(r.body).not.toMatch(/sm[ir]_/);

    delete process.env.SEATMETER_INGEST_URL;
    const abgeleitet = await u.app.inject({
      method: 'GET',
      url: '/api/v1/ausrollen',
      headers: {
        ...(await adminKopf(u, m.mandantId)),
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'dashboard.example.org',
      },
    });
    expect(abgeleitet.json()).toMatchObject({
      ingest_url: 'https://dashboard.example.org',
      ingest_url_quelle: 'anfrage',
    });

    const controller = await u.app.inject({
      method: 'GET',
      url: '/api/v1/ausrollen',
      headers: await adminKopf(u, m.mandantId, 'controller'),
    });
    expect(controller.statusCode).toBe(403);
    expect((await u.app.inject({ method: 'GET', url: '/api/v1/ausrollen' })).statusCode).toBe(401);
  });

  it('POST /api/v1/ausrollen/mandanten-token: Token einmal, gilt für OTLP, steht im Audit', async () => {
    const m = await testMandant(u);
    const r = await u.app.inject({
      method: 'POST',
      url: '/api/v1/ausrollen/mandanten-token',
      headers: await adminKopf(u, m.mandantId),
    });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const t = mandantenTokenAntwortSchema.parse(r.json());
    // Nur der Hash liegt in der Datenbank (Transaktion committet, obwohl 201 außerhalb gesendet wird).
    const zeile = await withMandant(u.db, m.mandantId, (trx) =>
      trx
        .selectFrom('ingest_token')
        .select(['typ', 'praefix'])
        .where('token_sha256', '=', sha256(t.token))
        .executeTakeFirst(),
    );
    expect(zeile).toEqual({ typ: 'mandant', praefix: t.praefix });
    const otlp = await otlpSenden(u, 'logs', t.token, fixture('logs-api-request.json'));
    expect(otlp.statusCode).toBe(200);
    const audit = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('audit').select(['aktion', 'objekt']).execute(),
    );
    expect(audit).toContainEqual({
      aktion: 'Ingest-Token erzeugt',
      objekt: `ingest_token:${t.praefix}`,
    });
    expect(JSON.stringify(audit)).not.toContain(t.token);
  });

  it('Pfad-Projekt: eigenes Projekt (provider pfad, ohne url_norm), Schlüssel HMAC(„pfad:“ + Name)', async () => {
    const m = await testMandant(u);
    const { token } = await rechnerToken(u, m.mandantId);
    const erst = await pushen(u, token, [anfrage(), anfrage()]);
    expect(erst.statusCode).toBe(200);
    expect(erst.json()).toMatchObject({ angenommen: 2, abgelehnt: 0 });
    const zweit = await pushen(u, token, [
      anfrage({ projekt: { typ: 'pfad', name: 'beispiel/bereich' } }),
    ]);
    expect(zweit.statusCode).toBe(200);

    const { projekte, anfragen, geheimnis } = await withMandant(u.db, m.mandantId, async (trx) => ({
      projekte: await trx
        .selectFrom('projekt')
        .select(['id', 'projekt_key', 'url_norm', 'provider', 'anzeigename', 'repo_name'])
        .execute(),
      anfragen: await trx.selectFrom('anfrage').select(['projekt_id']).execute(),
      geheimnis: await mandantSaltsLaden(trx, u.konfiguration.SEATMETER_MASTER_KEY, m.mandantId),
    }));
    expect(projekte).toHaveLength(1);
    expect(projekte[0]).toMatchObject({
      url_norm: null,
      provider: 'pfad',
      anzeigename: 'beispiel/bereich',
      repo_name: null,
    });
    expect(
      Buffer.from(projekte[0]!.projekt_key).equals(
        projektKey(geheimnis.projektSalt, 'pfad:beispiel/bereich'),
      ),
    ).toBe(true);
    expect(anfragen).toHaveLength(3);
    expect(new Set(anfragen.map((a) => a.projekt_id))).toEqual(new Set([projekte[0]!.id]));
  });

  it('Pfad-Projekt ist strikt: Zusatzfelder, Pfade als Name und Mischformen → 400', async () => {
    const m = await testMandant(u);
    const { token } = await rechnerToken(u, m.mandantId);
    for (const projekt of [
      { typ: 'pfad', name: 'x', pfad: '/Users/jemand/kunden' },
      { typ: 'pfad', name: '/Users/jemand/kunden' },
      { typ: 'pfad', name: '~/kunden' },
      { typ: 'pfad', name: '' },
      { typ: 'pfad', name: 'x', url_norm: 'https://github.com/a/b' },
    ]) {
      const r = await pushen(u, token, [{ ...anfrage(), projekt }]);
      expect(r.statusCode, JSON.stringify(projekt)).toBe(400);
      expect(r.body).not.toContain('/Users/jemand');
    }
  });

  it('Regression 204: Widerruf antwortet 204 und ist danach in der Datenbank sichtbar (committet)', async () => {
    const m = await testMandant(u);
    const r = await rechnerToken(u, m.mandantId);
    const widerruf = await u.app.inject({
      method: 'POST',
      url: `/api/v1/rechner/${r.rechner_id}/widerrufen`,
      headers: await adminKopf(u, m.mandantId),
    });
    expect(widerruf.statusCode).toBe(204);
    expect(widerruf.body).toBe('');
    const stand = await withMandant(u.db, m.mandantId, async (trx) => ({
      rechner: await trx
        .selectFrom('rechner')
        .select('widerrufen')
        .where('id', '=', r.rechner_id)
        .executeTakeFirstOrThrow(),
      tokens: await trx
        .selectFrom('ingest_token')
        .select('widerrufen')
        .where('rechner_id', '=', r.rechner_id)
        .execute(),
      audit: await trx
        .selectFrom('audit')
        .select('aktion')
        .where('objekt', '=', `rechner:${r.rechner_id}`)
        .execute(),
    }));
    expect(stand.rechner.widerrufen).not.toBeNull();
    expect(stand.tokens.every((t) => t.widerrufen !== null)).toBe(true);
    expect(stand.audit.map((a) => a.aktion)).toEqual(['Rechner widerrufen']);
  });
});
