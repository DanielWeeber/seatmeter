import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { erstelleApp } from '../src/app.js';
import { ladeKonfiguration } from '../src/config.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { stilleStunden } from '../src/ingest-gemeinsam/status.js';
import type { SeatmeterPlugin } from '../src/plugin.js';

describe('Health-Endpunkte und App-Fabrik', () => {
  let db: Db;
  let logs = '';
  const logStream = new Writable({
    write(chunk, _enc, weiter) {
      logs += String(chunk);
      weiter();
    },
  });
  const konfiguration = ladeKonfiguration({
    DATABASE_URL: inject('testDatenbankUrl'),
    SEATMETER_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    LOG_LEVEL: 'info',
  });
  const testPlugin: SeatmeterPlugin = {
    name: 'test',
    routen(app) {
      app.post('/api/test/echo', async () => ({ ok: true }));
    },
    navigation: [{ pfad: '/test', titel: 'Test', ee: true }],
  };

  beforeAll(() => {
    db = erstelleDb(konfiguration.DATABASE_URL, 2);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it('GET /api/health liefert 200 mit DB-Ping', async () => {
    const app = await erstelleApp({ konfiguration, db, logStream });
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', db: 'ok' });
    await app.close();
  });

  it('GET /api/health/ingest liefert Werte je Quelle', async () => {
    const app = await erstelleApp({ konfiguration, db, logStream });
    const r = await app.inject({ method: 'GET', url: '/api/health/ingest' });
    expect(r.statusCode).toBe(200);
    expect(r.json().quellen.a).toMatchObject({ anfragen_24h: expect.any(Number) });
    for (const q of ['a', 'b'] as const) {
      const w = r.json().quellen[q];
      expect(w.stille_stunden === null || typeof w.stille_stunden === 'number').toBe(true);
      expect(w.stille_stunden === null).toBe(w.letzte_annahme === null);
    }
    await app.close();
  });

  it('stille_stunden: Stunden seit der letzten Annahme, eine Nachkommastelle, nie negativ', () => {
    const jetzt = new Date('2026-10-22T12:00:00Z');
    expect(stilleStunden(new Date('2026-10-21T11:30:00Z'), jetzt)).toBe(24.5);
    expect(stilleStunden(new Date('2026-10-22T11:59:59Z'), jetzt)).toBe(0);
    expect(stilleStunden(new Date('2026-10-22T13:00:00Z'), jetzt)).toBe(0);
  });

  it('GET /api/health liefert 503, wenn die DB fehlt', async () => {
    const kaputt = erstelleDb('postgres://nutzer:falsch@127.0.0.1:1/keine', 1);
    const app = await erstelleApp({ konfiguration, db: kaputt, logStream });
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(503);
    await app.close();
    await kaputt.destroy();
  });

  it('registriert Plugins und loggt weder Körper noch Query noch Header', async () => {
    const app = await erstelleApp({ konfiguration, db, plugins: [testPlugin], logStream });
    expect(app.seatmeter.navigation).toEqual(testPlugin.navigation);
    const r = await app.inject({
      method: 'POST',
      url: '/api/test/echo?token=geheim-query',
      headers: { authorization: 'Bearer smr_geheim-header' },
      payload: { prompt: 'geheimer-inhalt' },
    });
    expect(r.statusCode).toBe(200);
    await app.close();
    expect(logs).toContain('/api/test/echo');
    for (const geheim of ['geheim-query', 'smr_geheim-header', 'geheimer-inhalt']) {
      expect(logs).not.toContain(geheim);
    }
  });
});
