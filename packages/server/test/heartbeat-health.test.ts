// Heartbeat des Agenten (`POST /api/agent/v1/heartbeat`) und Agenten-Stand in `/api/health/ingest`.
// Eigene Datenbank: `agenten` ist mandantenübergreifend, Rechner anderer Testdateien würden die Werte
// verfälschen.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollmentAntwortSchema, ingestAgentenSchema, type AgentAnfrage } from '@seatmeter/shared';
import { erstelleDb } from '../src/db/db.js';
import { migriere } from '../src/db/migrator.js';
import { agentenStatusLesen, ganzeStunden } from '../src/ingest-gemeinsam/status.js';
import { frischeDatenbank } from './db-hilfen.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  TEST_ORG,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

const STUNDE = 3_600_000;
const vor = (stunden: number) => new Date(Date.now() - stunden * STUNDE);

async function einschreiben(u: TestUmgebung, mandantId: string) {
  const code = await u.app.inject({
    method: 'POST',
    url: '/api/v1/rechner/einmalcode',
    headers: await adminKopf(u, mandantId),
    payload: {},
  });
  const enroll = await u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/enroll',
    payload: { code: code.json().code, os: 'macos', agent_version: '0.1.1' },
  });
  expect(enroll.statusCode).toBe(201);
  return enrollmentAntwortSchema.parse(enroll.json());
}

function heartbeatSenden(u: TestUmgebung, token: string | null, payload: Record<string, unknown>) {
  return u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/heartbeat',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}

function bAnfrage(requestId: string, ts: Date): AgentAnfrage {
  return {
    request_id: requestId,
    message_id: `msg_${requestId}`,
    session_id: '5d7f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    ts: ts.toISOString(),
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
    projekt: null,
    auth_hinweis: {
      klasse: 'oauth',
      org_uuid: TEST_ORG,
      // dieselbe Konto-UUID wie in der OTLP-Fixture: A und B landen bei derselben Person
      account_uuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    },
  };
}

async function healthAgenten(u: TestUmgebung) {
  const r = await u.app.inject({ method: 'GET', url: '/api/health/ingest' });
  expect(r.statusCode).toBe(200);
  return ingestAgentenSchema.parse(r.json().agenten);
}

async function zuletztGesehen(u: TestUmgebung, rechnerId: string, wann: Date) {
  await u.db
    .updateTable('rechner')
    .set({ zuletzt_gesehen: wann })
    .where('id', '=', rechnerId)
    .execute();
}

async function rechnerZeile(u: TestUmgebung, rechnerId: string) {
  return u.db
    .selectFrom('rechner')
    .select(['zuletzt_gesehen', 'agent_version'])
    .where('id', '=', rechnerId)
    .executeTakeFirstOrThrow();
}

const alterMs = (d: Date | null) => Date.now() - (d ? new Date(d).getTime() : 0);

describe('Heartbeat und Agenten-Stand (/api/health/ingest)', () => {
  let u: TestUmgebung;

  beforeAll(async () => {
    const url = await frischeDatenbank('seatmeter_test_heartbeat');
    const db = erstelleDb(url, 2);
    try {
      await migriere(db);
    } finally {
      await db.destroy();
    }
    u = await testUmgebung(url);
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('ohne Rechner: Zähler 0, Zeitpunkte null, keine Stille', async () => {
    expect(await healthAgenten(u)).toEqual({
      gesamt: 0,
      aktiv_48h: 0,
      aeltester_heartbeat_stunden: null,
      juengster_heartbeat_stunden: null,
      stille_trotz_heartbeat_stunden: 0,
      luecke_zu_a_stunden: 0,
    });
  });

  it('Heartbeat: Rechner-Token nötig, strikter Körper, setzt zuletzt_gesehen und Agent-Version', async () => {
    const m = await testMandant(u);
    const r = await einschreiben(u, m.mandantId);
    await zuletztGesehen(u, r.rechner_id, vor(72));

    expect((await heartbeatSenden(u, null, { agent_version: '0.1.2' })).statusCode).toBe(401);
    // Mandanten-Token gilt hier nicht
    expect((await heartbeatSenden(u, m.token, { agent_version: '0.1.2' })).statusCode).toBe(401);
    // nur die Agent-Version, keine weiteren Felder (z. B. Pfade oder Hostnamen)
    const zuViel = await heartbeatSenden(u, r.token, { agent_version: '0.1.2', cwd: '/home/x' });
    expect(zuViel.statusCode).toBe(400);
    expect(zuViel.body).not.toContain('/home/x');
    expect(alterMs((await rechnerZeile(u, r.rechner_id)).zuletzt_gesehen)).toBeGreaterThan(
      71 * STUNDE,
    );

    const ok = await heartbeatSenden(u, r.token, { agent_version: '0.1.2' });
    expect(ok.statusCode).toBe(204);
    expect(ok.body).toBe('');
    const zeile = await rechnerZeile(u, r.rechner_id);
    expect(alterMs(zeile.zuletzt_gesehen)).toBeLessThan(60_000);
    expect(zeile.agent_version).toBe('0.1.2');
    // Zwei Heartbeats kurz hintereinander: beide gelten (keine Minuten-Drosselung wie beim Config-Abruf).
    await zuletztGesehen(u, r.rechner_id, vor(5));
    expect((await heartbeatSenden(u, r.token, { agent_version: '0.1.2' })).statusCode).toBe(204);
    expect(alterMs((await rechnerZeile(u, r.rechner_id)).zuletzt_gesehen)).toBeLessThan(60_000);

    // Widerrufener Rechner: 401, und er zählt im Agenten-Stand nicht mehr mit.
    const widerruf = await u.app.inject({
      method: 'POST',
      url: `/api/v1/rechner/${r.rechner_id}/widerrufen`,
      headers: await adminKopf(u, m.mandantId),
    });
    expect(widerruf.statusCode).toBe(204);
    expect((await heartbeatSenden(u, r.token, { agent_version: '0.1.2' })).statusCode).toBe(401);
    expect((await healthAgenten(u)).gesamt).toBe(0);
  });

  it('agenten: gesamt, aktiv_48h, ältester/jüngster Heartbeat und Stille trotz Heartbeat', async () => {
    const m = await testMandant(u);
    const frisch = await einschreiben(u, m.mandantId);
    const alt = await einschreiben(u, m.mandantId);
    await zuletztGesehen(u, alt.rechner_id, vor(72));
    // B hat noch nie geliefert: Stille zählt ab der Registrierung des frischen Rechners.
    await u.db
      .updateTable('rechner')
      .set({ registriert: vor(5.5) })
      .where('id', '=', frisch.rechner_id)
      .execute();
    expect((await heartbeatSenden(u, frisch.token, { agent_version: '0.1.2' })).statusCode).toBe(
      204,
    );
    let a = await healthAgenten(u);
    expect(a).toMatchObject({
      gesamt: 2,
      aktiv_48h: 1,
      juengster_heartbeat_stunden: 0,
      stille_trotz_heartbeat_stunden: 5,
      luecke_zu_a_stunden: 0,
    });
    expect(a.aeltester_heartbeat_stunden).toBeGreaterThanOrEqual(72);
    expect(a.aeltester_heartbeat_stunden).toBeLessThan(72.2);

    // B liefert: Stille 0; liegt die letzte Lieferung 80 h zurück, sind es 80 h.
    const push = await u.app.inject({
      method: 'POST',
      url: '/api/ingest/v1/anfragen',
      headers: { authorization: `Bearer ${frisch.token}` },
      payload: { agent_version: '0.1.2', anfragen: [bAnfrage('req_HB_B0', vor(90))] },
    });
    expect(push.statusCode).toBe(200);
    expect((await healthAgenten(u)).stille_trotz_heartbeat_stunden).toBe(0);
    await sql`UPDATE ingest_statistik SET zuletzt = ${vor(80.5)} WHERE quelle = 'b'`.execute(u.db);
    expect((await healthAgenten(u)).stille_trotz_heartbeat_stunden).toBe(80);

    // Kein frischer Heartbeat (alle älter als 2 h): keine Stille, denn niemand arbeitet.
    await zuletztGesehen(u, frisch.rechner_id, vor(3));
    a = await healthAgenten(u);
    expect(a).toMatchObject({ aktiv_48h: 1, stille_trotz_heartbeat_stunden: 0 });
    expect(a.juengster_heartbeat_stunden).toBeGreaterThanOrEqual(3);
  });

  it('luecke_zu_a_stunden: A liefert für eine Person mit B-Daten, B zieht nicht nach', async () => {
    const m = await testMandant(u);
    const r = await einschreiben(u, m.mandantId);
    const bPush = (anfragen: AgentAnfrage[]) =>
      u.app.inject({
        method: 'POST',
        url: '/api/ingest/v1/anfragen',
        headers: { authorization: `Bearer ${r.token}` },
        payload: { agent_version: '0.1.2', anfragen },
      });
    expect((await bPush([bAnfrage('req_LU_B1', vor(10))])).statusCode).toBe(200);
    // A: zwei Anfragen nach der jüngsten B-Anfrage, ohne B-Gegenstück (6 h und 0,5 h alt)
    for (const [id, h] of [
      ['req_LU_A1', 6],
      ['req_LU_A2', 0.5],
    ] as const) {
      const a = await otlpSenden(
        u,
        'logs',
        m.token,
        fixture('logs-api-request.json', { jetzt: vor(h), requestId: id }),
      );
      expect(a.statusCode).toBe(200);
    }
    expect((await healthAgenten(u)).luecke_zu_a_stunden).toBe(5);
    // Nachts/am Wochenende (niemand arbeitet) wächst der Wert nicht: er hängt nur an den Anfragen.
    const spaeter = await agentenStatusLesen(u.db, null, new Date(Date.now() + 48 * STUNDE));
    expect(spaeter.luecke_zu_a_stunden).toBe(5);
    // B liefert die jüngste Anfrage nach: keine A-Anfrage ohne B mehr nach der jüngsten B-Anfrage.
    expect((await bPush([bAnfrage('req_LU_A2', vor(0.5))])).statusCode).toBe(200);
    expect((await healthAgenten(u)).luecke_zu_a_stunden).toBe(0);
  });

  it('ganzeStunden rundet ab und wird nie negativ', () => {
    const jetzt = new Date('2026-10-22T12:00:00Z');
    expect(ganzeStunden(new Date('2026-10-19T11:59:00Z'), jetzt)).toBe(72);
    expect(ganzeStunden(new Date('2026-10-22T11:01:00Z'), jetzt)).toBe(0);
    expect(ganzeStunden(new Date('2026-10-22T13:00:00Z'), jetzt)).toBe(0);
  });
});
