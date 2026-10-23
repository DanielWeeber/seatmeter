import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { erstelleApp } from '../src/app.js';
import { ladeKonfiguration } from '../src/config.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { loesePfad } from '../src/static/index.js';

describe('Dashboard-Auslieferung (SEATMETER_WEB_DIST)', () => {
  let db: Db;
  let app: FastifyInstance;
  let verzeichnis: string;
  const stumm = new Writable({ write: (_c, _e, weiter) => weiter() });
  const basis = {
    DATABASE_URL: inject('testDatenbankUrl'),
    SEATMETER_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    LOG_LEVEL: 'silent',
  };

  beforeAll(async () => {
    verzeichnis = await mkdtemp(path.join(tmpdir(), 'seatmeter-web-'));
    await mkdir(path.join(verzeichnis, 'assets'));
    await writeFile(
      path.join(verzeichnis, 'index.html'),
      '<!doctype html><title>seatmeter</title>',
    );
    await writeFile(path.join(verzeichnis, 'assets', 'app-abc123.js'), 'console.log(1);');
    await writeFile(path.join(verzeichnis, 'favicon.svg'), '<svg/>');
    db = erstelleDb(basis.DATABASE_URL, 1);
    const konfiguration = ladeKonfiguration({ ...basis, SEATMETER_WEB_DIST: verzeichnis });
    app = await erstelleApp({ konfiguration, db, logStream: stumm });
  });
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    if (verzeichnis) await rm(verzeichnis, { recursive: true, force: true });
  });

  it('liefert index.html für / und für Client-Routen', async () => {
    for (const url of ['/', '/projekte/123', '/preise?monat=2026-10']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.headers['cache-control']).toBe('no-cache, must-revalidate');
      expect(r.headers['content-security-policy']).toContain("script-src 'self'");
      expect(r.body).toContain('<title>seatmeter</title>');
    }
  });

  it('liefert Assets mit langem Cache und Dateien aus der Wurzel', async () => {
    const js = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const svg = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(svg.statusCode).toBe(200);
    expect(svg.headers['content-type']).toBe('image/svg+xml');
  });

  it('antwortet 404 für fehlende Dateien statt der SPA', async () => {
    const r = await app.inject({ method: 'GET', url: '/assets/fehlt.js' });
    expect(r.statusCode).toBe(404);
  });

  it('gibt /api und /otlp nie als SPA aus, die Health-Route bleibt', async () => {
    for (const url of ['/api/v1/unbekannt', '/api', '/otlp/v1/logs', '/api/agent/v1/unbekannt']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.headers['content-type']).toContain('application/json');
    }
    // Vorhandene Agent-Route ohne Token: 401 als JSON, nie die SPA.
    const config = await app.inject({ method: 'GET', url: '/api/agent/v1/config' });
    expect(config.statusCode).toBe(401);
    expect(config.headers['content-type']).toContain('application/json');
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('verhindert Pfadausbrüche aus dem Verzeichnis', async () => {
    for (const url of [
      '/%2e%2e/%2e%2e/etc/passwd',
      '/..%2f..%2fetc%2fpasswd',
      '/assets/..%2f..%2f..%2fetc%2fhosts',
    ]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.body, url).not.toContain('root:');
      expect([200, 400, 404]).toContain(r.statusCode);
    }
    expect(loesePfad('/srv/web', '/../../etc/passwd')).toBe('/srv/web/etc/passwd');
    expect(loesePfad('/srv/web', '/a%00b')).toBeNull();
    expect(loesePfad('/srv/web', '/%E0%A4%A')).toBeNull();
  });

  it('bricht beim Start ab, wenn index.html fehlt', async () => {
    const leer = await mkdtemp(path.join(tmpdir(), 'seatmeter-leer-'));
    const konfiguration = ladeKonfiguration({ ...basis, SEATMETER_WEB_DIST: leer });
    await expect(erstelleApp({ konfiguration, db, logStream: stumm })).rejects.toThrow(
      'enthält keine index.html',
    );
    await rm(leer, { recursive: true, force: true });
  });

  it('liefert ohne SEATMETER_WEB_DIST keine SPA', async () => {
    const ohne = await erstelleApp({
      konfiguration: ladeKonfiguration(basis),
      db,
      logStream: stumm,
    });
    const r = await ohne.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(404);
    await ohne.close();
  });
});
