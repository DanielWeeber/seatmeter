// Ratenlimits der Ingest-Pfade: je Token/Rechner, je IP (mit und ohne vertrauenswürdigen
// Proxy), Fehlversuchs-Sperre, Enrollment, Überschreibung je Mandant, 429-Zähler in /api/health/ingest.
// Die App-Tests nutzen langsame Nachfüllraten (höchstens 1 je 4 s), damit eine langsame CI keinen Platz
// zwischen zwei Anfragen nachfüllt.
import { afterAll, describe, expect, it } from 'vitest';
import { enrollmentAntwortSchema, ingestRatenlimitStandSchema } from '@seatmeter/shared';
import { grenzeLesen, ladeKonfiguration } from '../src/config.js';
import {
  AblehnungsZaehler,
  mandantGrenze,
  TokenEimer,
} from '../src/ingest-gemeinsam/ratenlimit.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

const offen: TestUmgebung[] = [];
async function umgebung(env: Record<string, string>): Promise<TestUmgebung> {
  const u = await testUmgebung(undefined, env);
  offen.push(u);
  return u;
}

async function einschreiben(u: TestUmgebung, mandantId: string, ip = '127.0.0.1') {
  const code = await u.app.inject({
    method: 'POST',
    url: '/api/v1/rechner/einmalcode',
    headers: await adminKopf(u, mandantId),
    payload: {},
  });
  const enroll = await u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/enroll',
    remoteAddress: ip,
    payload: { code: code.json().code, os: 'linux', agent_version: '0.1.2' },
  });
  expect(enroll.statusCode).toBe(201);
  return enrollmentAntwortSchema.parse(enroll.json());
}

function heartbeat(u: TestUmgebung, token: string | null, o: { ip?: string; xff?: string } = {}) {
  return u.app.inject({
    method: 'POST',
    url: '/api/agent/v1/heartbeat',
    remoteAddress: o.ip ?? '127.0.0.1',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(o.xff ? { 'x-forwarded-for': o.xff } : {}),
    },
    payload: { agent_version: '0.1.2' },
  });
}

async function health(u: TestUmgebung) {
  const r = await u.app.inject({ method: 'GET', url: '/api/health/ingest' });
  expect(r.statusCode).toBe(200);
  const j = r.json();
  return {
    a: j.quellen.a.abgelehnt_429_24h as number,
    b: j.quellen.b.abgelehnt_429_24h as number,
    ratenlimit: ingestRatenlimitStandSchema.parse(j.ratenlimit),
  };
}

afterAll(async () => {
  for (const u of offen) await u.schliessen();
});

describe('Ratenlimit: Bausteine', () => {
  it('Token-Eimer: Stoß, dann 429 mit Wartezeit; füllt sich mit der Minutenrate wieder auf', () => {
    let t = 0;
    const e = new TokenEimer(() => t);
    const g = { proMinute: 60, stoss: 2 };
    expect(e.pruefen('k', g)).toBe(0);
    expect(e.pruefen('k', g)).toBe(0);
    expect(e.pruefen('k', g)).toBe(1); // 60/min = 1 je Sekunde
    expect(e.pruefen('anderer', g)).toBe(0);
    t += 1000;
    expect(e.pruefen('k', g)).toBe(0);
    // frei() verbraucht nichts, verbrauchen() zählt ohne Prüfung (Fehlversuche)
    t += 5000;
    expect(e.frei('k', g)).toBe(0);
    e.verbrauchen('k', g);
    e.verbrauchen('k', g);
    expect(e.frei('k', g)).toBe(1);
    const langsam = { proMinute: 1, stoss: 1 };
    expect(e.pruefen('l', langsam)).toBe(0);
    expect(e.pruefen('l', langsam)).toBe(60);
  });

  it('Zähler: je Quelle und Schlüsselart, nur die letzten 24 h', () => {
    let t = Date.parse('2026-10-22T10:30:00Z');
    const z = new AblehnungsZaehler(() => t);
    z.zaehlen('a', 'token');
    z.zaehlen('b', 'enroll_fehlversuch');
    z.zaehlen('b', 'ip');
    expect(z.stand()).toMatchObject({
      quellen: { a: 1, b: 2 },
      je_art: { token: 1, enroll_fehlversuch: 1, ip: 1, rechner: 0 },
    });
    t += 25 * 3_600_000;
    z.zaehlen('b', 'rechner');
    expect(z.stand().quellen).toEqual({ a: 0, b: 1 });
  });

  it('Konfiguration: <pro_minute>/<stoss>, Standardwerte, SEATMETER_TRUST_PROXY', () => {
    expect(grenzeLesen('300/60')).toEqual({ proMinute: 300, stoss: 60 });
    expect(grenzeLesen('120')).toEqual({ proMinute: 120, stoss: 120 });
    for (const falsch of ['', 'viel', '0/5', '10/0', '-1/2'])
      expect(grenzeLesen(falsch)).toBeNull();
    const basis = {
      DATABASE_URL: 'postgres://x@localhost/x',
      SEATMETER_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    const k = ladeKonfiguration(basis);
    expect(k.SEATMETER_RATE_OTLP).toEqual({ proMinute: 3000, stoss: 300 });
    expect(k.SEATMETER_RATE_AGENT).toEqual({ proMinute: 300, stoss: 60 });
    expect(k.SEATMETER_RATE_ENROLL_FEHLVERSUCHE).toEqual({ proMinute: 1, stoss: 5 });
    expect(k.SEATMETER_TRUST_PROXY).toBe(false);
    expect(ladeKonfiguration({ ...basis, SEATMETER_TRUST_PROXY: '1' }).SEATMETER_TRUST_PROXY).toBe(
      1,
    );
    expect(
      ladeKonfiguration({ ...basis, SEATMETER_TRUST_PROXY: '172.28.0.0/16, 10.0.0.1' })
        .SEATMETER_TRUST_PROXY,
    ).toEqual(['172.28.0.0/16', '10.0.0.1']);
    expect(() => ladeKonfiguration({ ...basis, SEATMETER_TRUST_PROXY: 'jeder' })).toThrow(
      /SEATMETER_TRUST_PROXY/,
    );
    expect(() => ladeKonfiguration({ ...basis, SEATMETER_RATE_IP: 'viel' })).toThrow(
      /SEATMETER_RATE_IP/,
    );
  });

  it('Mandanten-Grenze: Stoß wächst im Verhältnis des Standards', () => {
    const standard = { proMinute: 300, stoss: 60 };
    expect(mandantGrenze(standard, null)).toBe(standard);
    expect(mandantGrenze(standard, 3000)).toEqual({ proMinute: 3000, stoss: 600 });
    expect(mandantGrenze(standard, 10)).toEqual({ proMinute: 10, stoss: 2 });
  });
});

describe('Ratenlimit der Ingest-Pfade (App)', () => {
  it('je Rechner: Stoß aufgebraucht → 429 mit Retry-After und deutschem Text; anderer Rechner frei', async () => {
    const u = await umgebung({ SEATMETER_RATE_AGENT: '1/2' });
    const m = await testMandant(u);
    const r1 = await einschreiben(u, m.mandantId);
    const r2 = await einschreiben(u, m.mandantId);
    const vorher = await health(u);
    expect((await heartbeat(u, r1.token)).statusCode).toBe(204);
    // Push und Heartbeat teilen sich den Eimer des Rechners.
    const push = await u.app.inject({
      method: 'POST',
      url: '/api/ingest/v1/sitzungen',
      headers: { authorization: `Bearer ${r1.token}` },
      payload: { agent_version: '0.1.2', sitzungen: [] },
    });
    expect(push.statusCode).toBe(400); // leere Liste ist ungültig, zählt aber als Anfrage
    const zuViel = await heartbeat(u, r1.token);
    expect(zuViel.statusCode).toBe(429);
    expect(Number(zuViel.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(zuViel.json()).toEqual({
      fehler: `Zu viele Anfragen, bitte in ${zuViel.headers['retry-after']} s erneut versuchen`,
    });
    expect((await heartbeat(u, r2.token)).statusCode).toBe(204);
    const nachher = await health(u);
    expect(nachher.b - vorher.b).toBe(1);
    expect(
      nachher.ratenlimit.abgelehnt_429_24h_je_art.rechner -
        vorher.ratenlimit.abgelehnt_429_24h_je_art.rechner,
    ).toBe(1);
    // Log nennt nur die Schlüsselart, nie Token oder Adresse.
    expect(u.logs()).toContain('Ratenlimit greift');
    expect(u.logs()).toContain('"ratenlimit":"rechner"');
    expect(u.logs()).not.toContain(r1.token);
    expect(u.logs()).not.toContain('127.0.0.1');
  });

  it('je Token auf /otlp/v1/*: 429 im OTLP-Format mit Retry-After, Zähler für Quelle A', async () => {
    const u = await umgebung({ SEATMETER_RATE_OTLP: '1/1' });
    const m = await testMandant(u);
    const vorher = await health(u);
    expect(
      (await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'))).statusCode,
    ).toBe(200);
    const r = await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(r.json()).toMatchObject({ code: expect.any(Number), message: expect.any(String) });
    const nachher = await health(u);
    expect(nachher.a - vorher.a).toBe(1);
    expect(
      nachher.ratenlimit.abgelehnt_429_24h_je_art.token -
        vorher.ratenlimit.abgelehnt_429_24h_je_art.token,
    ).toBe(1);
  });

  it('je IP: ohne vertrauenswürdigen Proxy zählt die Socket-Adresse, X-Forwarded-For wird ignoriert', async () => {
    const u = await umgebung({ SEATMETER_RATE_IP: '1/3' });
    const m = await testMandant(u);
    const r = await einschreiben(u, m.mandantId, '192.0.2.99');
    for (let i = 0; i < 3; i++) {
      const x = await heartbeat(u, r.token, { ip: '192.0.2.10', xff: `198.51.100.${i}` });
      expect(x.statusCode).toBe(204);
    }
    const gesperrt = await heartbeat(u, r.token, { ip: '192.0.2.10', xff: '198.51.100.77' });
    expect(gesperrt.statusCode).toBe(429);
    // Andere Socket-Adresse: eigener Eimer
    expect((await heartbeat(u, r.token, { ip: '192.0.2.11' })).statusCode).toBe(204);
  });

  it('je IP hinter Proxy (SEATMETER_TRUST_PROXY=1): Client-IP aus X-Forwarded-For', async () => {
    const u = await umgebung({ SEATMETER_RATE_IP: '1/2', SEATMETER_TRUST_PROXY: '1' });
    const m = await testMandant(u);
    const r = await einschreiben(u, m.mandantId, '192.0.2.99');
    const proxy = '172.28.0.5';
    expect((await heartbeat(u, r.token, { ip: proxy, xff: '198.51.100.1' })).statusCode).toBe(204);
    expect((await heartbeat(u, r.token, { ip: proxy, xff: '198.51.100.1' })).statusCode).toBe(204);
    expect((await heartbeat(u, r.token, { ip: proxy, xff: '198.51.100.1' })).statusCode).toBe(429);
    // Gleicher Proxy, anderer Client: frei. Eine vom Client vorangestellte Adresse zählt nicht.
    expect((await heartbeat(u, r.token, { ip: proxy, xff: '198.51.100.2' })).statusCode).toBe(204);
    expect(
      (await heartbeat(u, r.token, { ip: proxy, xff: '203.0.113.9, 198.51.100.1' })).statusCode,
    ).toBe(429);
  });

  it('Fehlversuche je IP: nach dem Vorrat 429 ohne Token-Prüfung; bekannte gültige Tokens bleiben frei', async () => {
    const u = await umgebung({ SEATMETER_RATE_FEHLVERSUCHE: '1/3' });
    const m = await testMandant(u);
    const r = await einschreiben(u, m.mandantId, '192.0.2.99');
    const ip = '192.0.2.20';
    expect((await heartbeat(u, r.token, { ip })).statusCode).toBe(204);
    const falsch = 'smr_unbekannt00000000000000000000000000000';
    expect((await heartbeat(u, falsch, { ip })).statusCode).toBe(401);
    expect((await heartbeat(u, null, { ip })).statusCode).toBe(401);
    expect((await heartbeat(u, falsch, { ip })).statusCode).toBe(401);
    const gesperrt = await heartbeat(u, falsch, { ip });
    expect(gesperrt.statusCode).toBe(429);
    expect(Number(gesperrt.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Das schon geprüfte Token dieser IP läuft weiter, eine andere IP ist nicht betroffen.
    expect((await heartbeat(u, r.token, { ip })).statusCode).toBe(204);
    expect((await heartbeat(u, falsch, { ip: '192.0.2.21' })).statusCode).toBe(401);
  });

  it('Enrollment: nach 5 falschen Einmalcodes je IP 429 (auch mit richtigem Code), andere IP frei', async () => {
    const u = await umgebung({});
    const m = await testMandant(u);
    const ip = '192.0.2.30';
    const enroll = (code: string, von = ip) =>
      u.app.inject({
        method: 'POST',
        url: '/api/agent/v1/enroll',
        remoteAddress: von,
        payload: { code, os: 'linux', agent_version: '0.1.2' },
      });
    for (let i = 0; i < 5; i++) expect((await enroll('AAAA-BBBB-CCCC')).statusCode).toBe(401);
    const vorher = await health(u);
    const gesperrt = await enroll('AAAA-BBBB-CCCC');
    expect(gesperrt.statusCode).toBe(429);
    expect(Number(gesperrt.headers['retry-after'])).toBeGreaterThanOrEqual(30);
    expect(gesperrt.json().fehler).toMatch(/^Zu viele Registrierungsversuche, bitte in \d+ s/);
    const code = await u.app.inject({
      method: 'POST',
      url: '/api/v1/rechner/einmalcode',
      headers: await adminKopf(u, m.mandantId),
      payload: {},
    });
    expect((await enroll(code.json().code)).statusCode).toBe(429);
    expect((await enroll(code.json().code, '192.0.2.31')).statusCode).toBe(201);
    const nachher = await health(u);
    expect(
      nachher.ratenlimit.abgelehnt_429_24h_je_art.enroll_fehlversuch -
        vorher.ratenlimit.abgelehnt_429_24h_je_art.enroll_fehlversuch,
    ).toBe(2);
  });

  it('Enrollment: jeder Versuch zählt je IP (SEATMETER_RATE_ENROLL)', async () => {
    const u = await umgebung({
      SEATMETER_RATE_ENROLL: '1/2',
      SEATMETER_RATE_ENROLL_FEHLVERSUCHE: '60/50',
    });
    const enroll = () =>
      u.app.inject({
        method: 'POST',
        url: '/api/agent/v1/enroll',
        remoteAddress: '192.0.2.40',
        payload: { code: 'AAAA-BBBB-CCCC', os: 'linux', agent_version: '0.1.2' },
      });
    expect((await enroll()).statusCode).toBe(401);
    expect((await enroll()).statusCode).toBe(401);
    const r = await enroll();
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(30);
  });

  it('Überschreibung je Mandant über die Einstellungen (ratenlimit_agent), mit Audit', async () => {
    const u = await umgebung({ SEATMETER_RATE_AGENT: '3/2' });
    const klein = await testMandant(u);
    const gross = await testMandant(u);
    const rk = await einschreiben(u, klein.mandantId);
    const rg = await einschreiben(u, gross.mandantId);
    const put = await u.app.inject({
      method: 'PUT',
      url: '/api/v1/mandant/einstellungen',
      headers: await adminKopf(u, gross.mandantId),
      payload: { ratenlimit_agent: 15 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ ratenlimit_agent: 15, ratenlimit_otlp: null });
    const ungueltig = await u.app.inject({
      method: 'PUT',
      url: '/api/v1/mandant/einstellungen',
      headers: await adminKopf(u, gross.mandantId),
      payload: { ratenlimit_otlp: 5 },
    });
    expect(ungueltig.statusCode).toBe(400);
    // 15/min → Stoß 10 (Verhältnis des Standards 3/2)
    for (let i = 0; i < 10; i++) expect((await heartbeat(u, rg.token)).statusCode).toBe(204);
    expect((await heartbeat(u, rg.token)).statusCode).toBe(429);
    expect((await heartbeat(u, rk.token)).statusCode).toBe(204);
    expect((await heartbeat(u, rk.token)).statusCode).toBe(204);
    expect((await heartbeat(u, rk.token)).statusCode).toBe(429);
    const audit = await u.db
      .selectFrom('audit')
      .select('objekt')
      .where('mandant_id', '=', gross.mandantId)
      .execute();
    expect(audit.map((a) => a.objekt)).toContain('mandant.ratenlimit_agent: null → 15');
    // Zurück auf den Standard
    const zurueck = await u.app.inject({
      method: 'PUT',
      url: '/api/v1/mandant/einstellungen',
      headers: await adminKopf(u, gross.mandantId),
      payload: { ratenlimit_agent: null },
    });
    expect(zurueck.json().ratenlimit_agent).toBeNull();
  });
});
