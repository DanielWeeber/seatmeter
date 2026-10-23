import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentKonfigurationSchema,
  enrollmentAntwortSchema,
  type AgentAnfrage,
} from '@seatmeter/shared';
import { withMandant } from '../src/db/mandant.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  TEST_ORG,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

async function einschreiben(u: TestUmgebung, mandantId: string, koerper: object = {}) {
  const code = await u.app.inject({
    method: 'POST',
    url: '/api/v1/rechner/einmalcode',
    headers: await adminKopf(u, mandantId),
    payload: koerper,
  });
  expect(code.statusCode).toBe(201);
  const enroll = await u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/enroll',
    payload: { code: code.json().code, os: 'macos', agent_version: '0.1.0' },
  });
  expect(enroll.statusCode).toBe(201);
  return {
    code: code.json().code as string,
    antwort: enrollmentAntwortSchema.parse(enroll.json()),
  };
}

function agentAnfrage(teil: Partial<AgentAnfrage> = {}): AgentAnfrage {
  return {
    request_id: 'req_011FIXTURE0000000001',
    message_id: 'msg_01FIXTURE',
    session_id: '5d7f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    ts: new Date().toISOString(),
    model: 'claude-opus-5-5',
    input_tokens: 1200,
    output_tokens: 350,
    cache_read_input_tokens: 48000,
    cache_creation_input_tokens: 2100,
    cache_write_5m: 0,
    cache_write_1h: 2100,
    web_search_requests: 0,
    speed: 'normal',
    service_tier: 'standard',
    inference_geo: 'eu',
    ist_subagent: false,
    cc_version: '2.1.290',
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

function pushen(u: TestUmgebung, token: string, anfragen: unknown[], pfad = 'anfragen') {
  return u.app.inject({
    method: 'POST',
    url: `/api/ingest/v1/${pfad}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { agent_version: '0.1.0', [pfad]: anfragen },
  });
}

describe('Enrollment (Einmalcode → Rechner-Token) und Agent-Ingest (Quelle B)', () => {
  let u: TestUmgebung;

  beforeAll(async () => {
    u = await testUmgebung();
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('(g) Code → Token → config 200; Code nur einmal; widerrufen → 401', async () => {
    const m = await testMandant(u);
    const { code, antwort } = await einschreiben(u, m.mandantId, { bezeichnung: 'MacBook Test' });
    expect(antwort.token).toMatch(/^smr_/);
    expect(antwort.konfiguration.include_paths).toEqual([]);

    const config = await u.app.inject({
      method: 'GET',
      url: '/api/agent/v1/config',
      headers: { authorization: `Bearer ${antwort.token}` },
    });
    expect(config.statusCode).toBe(200);
    const k = agentKonfigurationSchema.parse(config.json());
    expect(k.sweeper_intervall_min).toBe(10);

    const nochmal = await u.app.inject({
      method: 'POST',
      url: '/api/agent/v1/enroll',
      payload: { code, os: 'linux', agent_version: '0.1.0' },
    });
    expect(nochmal.statusCode).toBe(401);

    const liste = await u.app.inject({
      method: 'GET',
      url: '/api/v1/rechner',
      headers: await adminKopf(u, m.mandantId),
    });
    expect(liste.statusCode).toBe(200);
    expect(liste.json().rechner).toHaveLength(1);
    expect(liste.json().rechner[0]).toMatchObject({
      id: antwort.rechner_id,
      os: 'macos',
      agent_version: '0.1.0',
      bezeichnung: 'MacBook Test',
      person_id: null,
      person_pseudonym: null,
      widerrufen: null,
    });

    const widerruf = await u.app.inject({
      method: 'POST',
      url: `/api/v1/rechner/${antwort.rechner_id}/widerrufen`,
      headers: await adminKopf(u, m.mandantId),
    });
    expect(widerruf.statusCode).toBe(204);
    const danach = await u.app.inject({
      method: 'GET',
      url: '/api/agent/v1/config',
      headers: { authorization: `Bearer ${antwort.token}` },
    });
    expect(danach.statusCode).toBe(401);

    const audit = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('audit').select(['aktion', 'objekt']).orderBy('id').execute(),
    );
    expect(audit.map((a) => a.aktion)).toEqual(
      expect.arrayContaining(['Einmalcode erzeugt', 'Rechner widerrufen']),
    );
    expect(audit.find((a) => a.aktion === 'Rechner widerrufen')?.objekt).toBe(
      `rechner:${antwort.rechner_id}`,
    );
  });

  it('Dashboard-Routen verlangen Anmeldung (401) und Rolle Mandanten-Admin (403)', async () => {
    const m = await testMandant(u);
    const ohne = await u.app.inject({ method: 'GET', url: '/api/v1/rechner' });
    expect(ohne.statusCode).toBe(401);
    const leser = await u.app.inject({
      method: 'POST',
      url: '/api/v1/rechner/einmalcode',
      headers: await adminKopf(u, m.mandantId, 'controller'),
      payload: {},
    });
    expect(leser.statusCode).toBe(403);
  });

  it('abgelaufener oder unbekannter Code → 401', async () => {
    const unbekannt = await u.app.inject({
      method: 'POST',
      url: '/api/agent/v1/enroll',
      payload: { code: 'AAAA-BBBB-CCCC', os: 'macos', agent_version: '0.1.0' },
    });
    expect(unbekannt.statusCode).toBe(401);
  });

  it('Mandanten-Token gilt nicht für Agent-Routen', async () => {
    const m = await testMandant(u);
    const r = await pushen(u, m.token, [agentAnfrage()]);
    expect(r.statusCode).toBe(401);
  });

  it('(f) Push mit cwd (oder anderen unbekannten Feldern) wird mit 400 abgelehnt', async () => {
    const m = await testMandant(u);
    const { antwort } = await einschreiben(u, m.mandantId);
    for (const extra of [
      { cwd: '/home/nutzer/geheim' },
      { transcript_path: '/x.jsonl' },
      { hostname: 'laptop' },
      { content: 'Inhalt' },
    ]) {
      const r = await pushen(u, antwort.token, [{ ...agentAnfrage(), ...extra }]);
      expect(r.statusCode, Object.keys(extra)[0]).toBe(400);
      expect(r.body).not.toContain('/home/nutzer/geheim');
    }
    const pfadAlsUrl = await pushen(u, antwort.token, [
      agentAnfrage({
        projekt: {
          url_norm: '/home/nutzer/repo',
          provider: 'unknown',
          owner: null,
          repo_name: null,
        },
      }),
    ]);
    expect(pfadAlsUrl.statusCode).toBe(400);
    expect(
      await withMandant(u.db, m.mandantId, (trx) =>
        trx.selectFrom('anfrage').select('anfrage_key').execute(),
      ),
    ).toEqual([]);
  });

  it('B-Push ist idempotent und setzt Bit 2 auf einer vorhandenen A-Zeile (Tokens aus A, 1h aus B)', async () => {
    const m = await testMandant(u);
    const { antwort } = await einschreiben(u, m.mandantId);
    // A zuerst
    expect(
      (await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'))).statusCode,
    ).toBe(200);
    // B mit abweichendem input
    const b = agentAnfrage({ input_tokens: 1199 });
    const r1 = await pushen(u, antwort.token, [b]);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ angenommen: 1, wiederholt: 0 });
    const r2 = await pushen(u, antwort.token, [b]);
    expect(r2.json()).toMatchObject({ angenommen: 0, wiederholt: 1 });

    const zeilen = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('anfrage').selectAll().execute(),
    );
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]).toMatchObject({
      quellen: 3,
      input: 1200,
      cache_write: 2100,
      cache_write_1h: 2100,
      inference_geo: 'eu',
      service_tier: 'standard',
      abweichung_ab: true,
      zaehlt_als_abo: true,
    });
    const sitzung = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('sitzung').selectAll().executeTakeFirstOrThrow(),
    );
    expect(sitzung.quellen).toBe(3);
    expect(sitzung.rechner_id).toBe(antwort.rechner_id);
    const stat = await withMandant(u.db, m.mandantId, (trx) =>
      trx
        .selectFrom('ingest_statistik')
        .selectAll()
        .where('quelle', '=', 'b')
        .executeTakeFirstOrThrow(),
    );
    expect(stat.angenommen).toBe(1);
  });

  it('nur B: Person aus der Rechnerbindung, Projekt aus der URL, msg:-Schlüssel ohne request_id', async () => {
    const m = await testMandant(u);
    const person = await withMandant(u.db, m.mandantId, (trx) =>
      trx
        .insertInto('person')
        .values({ mandant_id: m.mandantId, pseudonym: 'P-TESTAB', key_konto: Buffer.alloc(32, 9) })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const { antwort } = await einschreiben(u, m.mandantId, { pseudonym: 'P-TESTAB' });
    const r = await pushen(u, antwort.token, [
      agentAnfrage({ request_id: null, message_id: 'msg_01NURB' }),
    ]);
    expect(r.statusCode).toBe(200);
    const zeile = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('anfrage').selectAll().executeTakeFirstOrThrow(),
    );
    expect(zeile).toMatchObject({
      anfrage_key: 'msg:msg_01NURB',
      quellen: 2,
      person_id: person.id,
      input: 1200,
    });
    expect(zeile.projekt_id).not.toBeNull();
  });

  it('B mit API-Hinweis oder fremder Org wird nur gezählt', async () => {
    const m = await testMandant(u);
    const { antwort } = await einschreiben(u, m.mandantId);
    const r = await pushen(u, antwort.token, [
      agentAnfrage({
        request_id: 'req_api',
        auth_hinweis: { klasse: 'api', org_uuid: null, account_uuid: null },
      }),
      agentAnfrage({
        request_id: 'req_fremd',
        auth_hinweis: {
          klasse: 'oauth',
          org_uuid: '11111111-2222-4333-8444-555555555555',
          account_uuid: null,
        },
      }),
    ]);
    expect(r.json()).toMatchObject({ angenommen: 0, verworfen_api: 1, verworfen_fremd_org: 1 });
    expect(
      await withMandant(u.db, m.mandantId, (trx) =>
        trx.selectFrom('anfrage').select('anfrage_key').execute(),
      ),
    ).toEqual([]);
  });

  it('Sitzungen-Push legt die Sitzung mit Bit B an', async () => {
    const m = await testMandant(u);
    const { antwort } = await einschreiben(u, m.mandantId);
    const r = await pushen(
      u,
      antwort.token,
      [
        {
          session_id: 'sitzung-b-1',
          start: new Date().toISOString(),
          ende: null,
          cc_version: '2.1.290',
          projekt: null,
          auth_hinweis: { klasse: 'oauth', org_uuid: TEST_ORG, account_uuid: null },
        },
      ],
      'sitzungen',
    );
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ angenommen: 1 });
    const s = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('sitzung').selectAll().executeTakeFirstOrThrow(),
    );
    expect(s).toMatchObject({
      session_id: 'sitzung-b-1',
      quellen: 2,
      rechner_id: antwort.rechner_id,
    });
  });

  it('mandantAnlegen ist idempotent und gibt das Token nur einmal aus', async () => {
    const slug = `t-idem-${Date.now()}`;
    const eingabe = { slug, name: 'Idempotent', orgs: [TEST_ORG] };
    const erst = await mandantAnlegen(u.db, u.konfiguration.SEATMETER_MASTER_KEY, eingabe);
    const zweit = await mandantAnlegen(u.db, u.konfiguration.SEATMETER_MASTER_KEY, eingabe);
    expect(erst.mandantNeu).toBe(true);
    expect(erst.token).toMatch(/^smi_/);
    expect(zweit).toMatchObject({
      mandantId: erst.mandantId,
      mandantNeu: false,
      orgsNeu: 0,
      token: null,
    });
    const geheimnis = await withMandant(u.db, erst.mandantId, (trx) =>
      trx.selectFrom('mandant_geheimnis').selectAll().executeTakeFirstOrThrow(),
    );
    // Verschlüsselt: Version + IV + Tag + 32 Byte Chiffrat.
    expect(geheimnis.person_salt).toHaveLength(1 + 12 + 16 + 32);

    // Vorhandener Mandant: ausdrücklicher Plan wird übernommen, Org kommt dazu, Token bleibt.
    const org2 = '0b6f5c2e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';
    const dritt = await mandantAnlegen(u.db, u.konfiguration.SEATMETER_MASTER_KEY, {
      slug,
      name: 'Idempotent',
      plan: 'max_pilot',
      orgs: [org2],
    });
    expect(dritt).toMatchObject({ mandantNeu: false, orgsNeu: 1, token: null });
    const m = await u.db
      .selectFrom('mandant')
      .select('plan')
      .where('id', '=', erst.mandantId)
      .executeTakeFirstOrThrow();
    expect(m.plan).toBe('max_pilot');
    const orgs = await withMandant(u.db, erst.mandantId, (trx) =>
      trx.selectFrom('anthropic_org').select(['org_uuid', 'plan']).orderBy('org_uuid').execute(),
    );
    expect(orgs).toContainEqual({ org_uuid: org2, plan: 'max_pilot' });
  });
});
