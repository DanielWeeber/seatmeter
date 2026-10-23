import { Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleApp } from '../src/app.js';
import { erstelleDb } from '../src/db/db.js';
import { withMandant } from '../src/db/mandant.js';
import { IngestRatenlimit, ratenlimitOptionen } from '../src/ingest-gemeinsam/ratenlimit.js';
import { otlpRouten } from '../src/ingest-otlp/routes.js';
import Fastify from 'fastify';
import {
  fixture,
  otlpSenden,
  TEST_EMAIL,
  TEST_ORG,
  TEST_PROMPT,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

async function statistik(u: TestUmgebung, mandantId: string) {
  return withMandant(u.db, mandantId, (trx) =>
    trx.selectFrom('ingest_statistik').selectAll().where('quelle', '=', 'a').executeTakeFirst(),
  );
}

async function anfragen(u: TestUmgebung, mandantId: string) {
  return withMandant(u.db, mandantId, (trx) =>
    trx.selectFrom('anfrage').selectAll().orderBy('anfrage_key').execute(),
  );
}

describe('OTLP-Empfänger (Quelle A, Architektur §2.1)', () => {
  let u: TestUmgebung;

  beforeAll(async () => {
    u = await testUmgebung();
  });
  afterAll(async () => {
    await u?.schliessen();
  });

  it('api_request wird als Abo-Anfrage mit Person, Projekt und Sitzung gespeichert', async () => {
    const m = await testMandant(u);
    const r = await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});

    const zeilen = await anfragen(u, m.mandantId);
    expect(zeilen).toHaveLength(1);
    const a = zeilen[0]!;
    expect(a).toMatchObject({
      anfrage_key: 'req_011FIXTURE0000000001',
      model: 'claude-opus-5-5',
      input: 1200,
      output: 350,
      cache_read: 48000,
      cache_write: 2100,
      cache_write_1h: null,
      quellen: 1,
      auth_klasse: 'abo',
      zaehlt_als_abo: true,
      cc_kosten_usd_micros: 31200,
      speed: 'normal',
      query_source: 'repl_main_thread',
      session_id: '5d7f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    });
    expect(a.person_id).not.toBeNull();
    expect(a.projekt_id).not.toBeNull();

    const sitzung = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('sitzung').selectAll().executeTakeFirstOrThrow(),
    );
    expect(sitzung).toMatchObject({
      session_id: a.session_id,
      person_id: a.person_id,
      projekt_id: a.projekt_id,
      org_uuid: TEST_ORG,
      auth_klasse: 'abo',
      quellen: 1,
      cc_version: '2.1.290',
    });

    const person = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('person').selectAll().executeTakeFirstOrThrow(),
    );
    expect(person.pseudonym).toMatch(/^P-[A-Z2-7]{6}$/);
    expect(person.key_konto).toHaveLength(32);
    expect(person.key_email).toHaveLength(32);
    // Zweite Zuordnung für den Abgleich (ee): HMAC(account_id), verschieden von HMAC(account_uuid).
    expect(person.key_konto_id).toHaveLength(32);
    expect(person.key_konto_id!.equals(person.key_konto!)).toBe(false);
    expect((await statistik(u, m.mandantId))?.angenommen).toBe(1);
  });

  it('(d) vcs.* ordnet ein Projekt mit normalisierter URL zu', async () => {
    const m = await testMandant(u);
    await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    const projekt = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('projekt').selectAll().executeTakeFirstOrThrow(),
    );
    expect(projekt).toMatchObject({
      url_norm: 'https://github.com/example-org/example-repo',
      repo_name: 'example-repo',
      owner: 'example-org',
      provider: 'github',
    });
    expect(projekt.projekt_key).toHaveLength(32);
  });

  it('(e) dieselbe request_id zweimal (auch JSON + Protobuf) ergibt eine Zeile', async () => {
    const m = await testMandant(u);
    const f = fixture('logs-api-request.json');
    expect((await otlpSenden(u, 'logs', m.token, f)).statusCode).toBe(200);
    expect((await otlpSenden(u, 'logs', m.token, f)).statusCode).toBe(200);
    expect((await otlpSenden(u, 'logs', m.token, f, 'protobuf')).statusCode).toBe(200);
    expect(await anfragen(u, m.mandantId)).toHaveLength(1);
    // Wiederholungen zählen nicht erneut als angenommen.
    expect((await statistik(u, m.mandantId))?.angenommen).toBe(1);
  });

  it('(b) user_prompt mit Text speichert nichts und zählt verworfen_inhalt', async () => {
    const m = await testMandant(u);
    const r = await otlpSenden(u, 'logs', m.token, fixture('logs-user-prompt.json'));
    expect(r.statusCode).toBe(200);
    for (const tabelle of ['anfrage', 'sitzung', 'person', 'projekt'] as const) {
      const n = await withMandant(u.db, m.mandantId, (trx) =>
        trx
          .selectFrom(tabelle)
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow(),
      );
      expect(Number(n.n), tabelle).toBe(0);
    }
    const s = await statistik(u, m.mandantId);
    expect(s?.verworfen_inhalt).toBe(1);
    expect(s?.angenommen).toBe(0);
    expect(u.logs()).not.toContain(TEST_PROMPT);
  });

  it('(c) api_request nur mit user.id (API-Key) zählt nicht und erhöht verworfen_api', async () => {
    const m = await testMandant(u);
    const r = await otlpSenden(u, 'logs', m.token, fixture('logs-api-key.json'));
    expect(r.statusCode).toBe(200);
    expect(await anfragen(u, m.mandantId)).toHaveLength(0);
    const projekte = await withMandant(u.db, m.mandantId, (trx) =>
      trx.selectFrom('projekt').select('id').execute(),
    );
    expect(projekte).toHaveLength(0);
    expect((await statistik(u, m.mandantId))?.verworfen_api).toBe(1);
  });

  it('fremde Org (nicht in der Positivliste) wird verworfen und gezählt', async () => {
    const m = await testMandant(u, ['11111111-2222-4333-8444-555555555555']);
    await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    expect(await anfragen(u, m.mandantId)).toHaveLength(0);
    expect((await statistik(u, m.mandantId))?.verworfen_fremd_org).toBe(1);
  });

  it('(i) Protobuf und JSON ergeben dieselben Zeilen', async () => {
    const mJson = await testMandant(u);
    const mProto = await testMandant(u);
    const jetzt = new Date();
    const f = fixture('logs-api-request.json', { jetzt });
    expect((await otlpSenden(u, 'logs', mJson.token, f, 'json')).statusCode).toBe(200);
    const r = await otlpSenden(u, 'logs', mProto.token, f, 'protobuf');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/x-protobuf');

    const projektion = async (mandantId: string) => {
      const a = await anfragen(u, mandantId);
      const s = await withMandant(u.db, mandantId, (trx) =>
        trx.selectFrom('sitzung').selectAll().execute(),
      );
      const p = await withMandant(u.db, mandantId, (trx) =>
        trx.selectFrom('projekt').select(['url_norm', 'repo_name', 'owner', 'provider']).execute(),
      );
      const ohneIds = <T extends Record<string, unknown>>(z: T) => {
        const kopie: Record<string, unknown> = { ...z };
        for (const k of ['mandant_id', 'person_id', 'projekt_id', 'rechner_id']) delete kopie[k];
        return kopie;
      };
      return { a: a.map(ohneIds), s: s.map(ohneIds), p };
    };
    expect(await projektion(mProto.mandantId)).toEqual(await projektion(mJson.mandantId));
  });

  it('Metriken: nur Tokentypen aus token.usage landen als Kontrollsummen (delta wird addiert)', async () => {
    const m = await testMandant(u);
    const f = fixture('metrics-token-usage.json');
    expect((await otlpSenden(u, 'metrics', m.token, f)).statusCode).toBe(200);
    expect((await otlpSenden(u, 'metrics', m.token, f, 'protobuf')).statusCode).toBe(200);
    const summen = await withMandant(u.db, m.mandantId, (trx) =>
      trx
        .selectFrom('otel_kontrollsumme')
        .select(['typ', 'model', 'wert'])
        .orderBy('typ')
        .execute(),
    );
    expect(summen).toEqual([
      { typ: 'input', model: 'claude-opus-5-5', wert: 2400 },
      { typ: 'output', model: 'claude-opus-5-5', wert: 700 },
    ]);
  });

  it('(h) RLS: Daten von Mandant A sind unter B nicht sichtbar', async () => {
    const a = await testMandant(u);
    const b = await testMandant(u);
    await otlpSenden(u, 'logs', a.token, fixture('logs-api-request.json'));
    for (const tabelle of [
      'anfrage',
      'sitzung',
      'person',
      'projekt',
      'ingest_statistik',
    ] as const) {
      const zaehle = (m: string) =>
        withMandant(u.db, m, (trx) =>
          trx
            .selectFrom(tabelle)
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow(),
        );
      expect(Number((await zaehle(b.mandantId)).n), tabelle).toBe(0);
      expect(Number((await zaehle(a.mandantId)).n), tabelle).toBeGreaterThan(0);
    }
  });

  it('401 ohne, mit falschem oder widerrufenem Token', async () => {
    const m = await testMandant(u);
    const f = JSON.stringify(fixture('logs-api-request.json'));
    const ohne = await u.app.inject({
      method: 'POST',
      url: '/otlp/v1/logs',
      headers: { 'content-type': 'application/json' },
      payload: f,
    });
    expect(ohne.statusCode).toBe(401);
    expect(ohne.json()).toMatchObject({ code: 16 });
    const falsch = await otlpSenden(u, 'logs', 'smi_gibtesnicht', fixture('logs-api-request.json'));
    expect(falsch.statusCode).toBe(401);
    await withMandant(u.db, m.mandantId, (trx) =>
      trx.updateTable('ingest_token').set({ widerrufen: new Date() }).execute(),
    );
    const widerrufen = await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    expect(widerrufen.statusCode).toBe(401);
  });

  it('400 bei nicht dekodierbarem Körper, 415 bei fremdem Content-Type, gzip wird entpackt', async () => {
    const m = await testMandant(u);
    const kaputt = await u.app.inject({
      method: 'POST',
      url: '/otlp/v1/logs',
      headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/x-protobuf' },
      payload: Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]),
    });
    expect(kaputt.statusCode).toBe(400);
    const keinJson = await u.app.inject({
      method: 'POST',
      url: '/otlp/v1/logs',
      headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' },
      payload: `{"resourceLogs": [ ${TEST_PROMPT}`,
    });
    expect(keinJson.statusCode).toBe(400);
    expect(keinJson.body).not.toContain(TEST_PROMPT);
    const fremd = await u.app.inject({
      method: 'POST',
      url: '/otlp/v1/logs',
      headers: { authorization: `Bearer ${m.token}`, 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(fremd.statusCode).toBe(415);
    const gz = await u.app.inject({
      method: 'POST',
      url: '/otlp/v1/logs',
      headers: {
        authorization: `Bearer ${m.token}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipSync(JSON.stringify(fixture('logs-api-request.json'))),
    });
    expect(gz.statusCode).toBe(200);
    expect(await anfragen(u, m.mandantId)).toHaveLength(1);
  });

  it('partialSuccess meldet abgelehnte Datensätze (ohne request_id/client_request_id)', async () => {
    const m = await testMandant(u);
    const f = fixture('logs-api-request.json') as {
      resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string }[] }[] }[] }[];
    };
    const rec = f.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    rec.attributes = rec.attributes.filter(
      (a) => a.key !== 'request_id' && a.key !== 'client_request_id',
    );
    const r = await otlpSenden(u, 'logs', m.token, f);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ partialSuccess: { rejectedLogRecords: '1' } });
  });

  it('503 mit Retry-After, wenn die Datenbank fehlt', async () => {
    const kaputt = erstelleDb('postgres://nutzer:falsch@127.0.0.1:1/keine', 1);
    const still = new Writable({ write: (_c, _e, weiter) => weiter() });
    const app = await erstelleApp({ konfiguration: u.konfiguration, db: kaputt, logStream: still });
    const r = await app.inject({
      method: 'POST',
      url: '/otlp/v1/logs',
      headers: { authorization: 'Bearer smi_irgendwas', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('30');
    await app.close();
    await kaputt.destroy();
  });

  it('429 mit Retry-After, wenn das Rate-Limit je Token greift', async () => {
    const m = await testMandant(u);
    const app = Fastify();
    await otlpRouten(app, {
      db: u.db,
      masterKey: u.konfiguration.SEATMETER_MASTER_KEY,
      ratenlimit: new IngestRatenlimit({
        ...ratenlimitOptionen(u.konfiguration),
        otlp: { proMinute: 1, stoss: 1 },
      }),
    });
    const senden = () =>
      app.inject({
        method: 'POST',
        url: '/otlp/v1/logs',
        headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' },
        payload: '{}',
      });
    expect((await senden()).statusCode).toBe(200);
    const zweite = await senden();
    expect(zweite.statusCode).toBe(429);
    expect(Number(zweite.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('/api/health/ingest liefert Werte für Quelle A', async () => {
    const m = await testMandant(u);
    await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    const r = await u.app.inject({ method: 'GET', url: '/api/health/ingest' });
    expect(r.statusCode).toBe(200);
    const a = r.json().quellen.a;
    expect(a.letzte_annahme).not.toBeNull();
    expect(a.anfragen_24h).toBeGreaterThan(0);
    expect(a.heute.angenommen).toBeGreaterThan(0);
  });

  it('(a) die Test-E-Mail steht nach dem Ingest nirgends in der Datenbank und nicht im Log', async () => {
    const m = await testMandant(u);
    await otlpSenden(u, 'logs', m.token, fixture('logs-api-request.json'));
    await otlpSenden(u, 'metrics', m.token, fixture('metrics-token-usage.json'));
    await otlpSenden(u, 'logs', m.token, fixture('logs-user-prompt.json'));
    // pg_dump-Ersatz: alle Text-, JSON- und Byte-Spalten aller Tabellen durchsuchen (als Eigentümer).
    const spalten = await sql<{ tabelle: string; spalte: string; typ: string }>`
      SELECT c.table_name AS tabelle, c.column_name AS spalte, c.data_type AS typ
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY')`.execute(
      u.db,
    );
    expect(spalten.rows.length).toBeGreaterThan(20);
    const treffer: string[] = [];
    for (const { tabelle, spalte, typ } of spalten.rows) {
      for (const suchwert of [TEST_EMAIL, TEST_PROMPT]) {
        const bedingung =
          typ === 'bytea'
            ? sql`position(convert_to(${suchwert}, 'UTF8') in ${sql.ref(spalte)}) > 0`
            : sql`${sql.ref(spalte)}::text ILIKE ${`%${suchwert}%`}`;
        const r = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM ${sql.table(tabelle)} WHERE ${bedingung}`.execute(u.db);
        if (Number(r.rows[0]?.n) > 0) treffer.push(`${tabelle}.${spalte}`);
      }
    }
    expect(treffer).toEqual([]);
    expect(u.logs()).not.toContain(TEST_EMAIL);
    expect(u.logs()).not.toContain(m.token);
  });
});
