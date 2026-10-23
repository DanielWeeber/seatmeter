// Der Kern allein (ohne SEATMETER_PLUGINS, ohne Lizenzdatei) hat alle Funktionen außer der Mandantenfähigkeit
// (Entscheidung vom 2026-10-23): Budgets, Hinweise, Abgleich, Jira, OIDC/SSO, Konten, SCIM und die
// Selbstverwaltung des Mandanten antworten ohne 402, ihre Jobs laufen im Job-Planer des Kerns, die früheren
// ee-Pfade gibt es nicht mehr.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { kernApp, legeMandantAn, meldeAn } from './api-hilfen.js';

describe('Kern ohne Plugin', () => {
  let db: Db;
  let app: FastifyInstance;
  let admin: Awaited<ReturnType<typeof meldeAn>>;
  const url = inject('modulDatenbankUrl');

  beforeAll(async () => {
    db = erstelleDb(url, 2);
    app = await kernApp(db, url);
    admin = await meldeAn(db, await legeMandantAn(db), 'mandanten_admin');
  });
  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const get = (pfad: string) => app.inject({ method: 'GET', url: pfad, headers: admin.headers });

  it('lädt kein Plugin und meldet in /me weder ee noch Plattform-Admin', async () => {
    expect(app.seatmeter.plugins).toEqual([]);
    const me = (await get('/api/v1/auth/me')).json();
    expect(me.ee).toBeUndefined();
    expect(me.plattform_admin).toBeUndefined();
  });

  it.each([
    '/api/v1/budgets?monat=2026-10',
    '/api/v1/alarme?monat=2026-10',
    '/api/v1/alarmkanal',
    '/api/v1/hinweise?monat=2026-10',
    '/api/v1/abgleich',
    '/api/v1/abgleich/laeufe',
    '/api/v1/jira/verbindung',
    '/api/v1/jira/zuordnung',
    '/api/v1/jira/kosten?monat=2026-10',
    '/api/v1/mandant/oidc',
    '/api/v1/mandant/domains',
    '/api/v1/mandant/konten',
    '/api/v1/mandant/scim-tokens',
    '/api/v1/mandant/tokens',
    '/api/v1/mandant/anthropic-orgs',
    '/api/v1/mandant/rollen',
    '/api/v1/mandant/benutzer',
  ])('%s antwortet 200', async (pfad) => {
    const r = await get(pfad);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('SCIM und Einladung sind erreichbar (ohne Token 401, unbekannte Einladung 404)', async () => {
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Users' })).statusCode).toBe(401);
    const e = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/einladung/pruefen',
      payload: { token: 'x'.repeat(40) },
    });
    expect(e.statusCode).toBe(404);
  });

  it.each([
    '/api/v1/ee/budgets',
    '/api/v1/ee/hinweise',
    '/api/v1/ee/abgleich',
    '/api/v1/ee/jira/verbindung',
    '/api/v1/ee/mandanten',
    '/api/v1/ee/lizenz',
  ])('früherer ee-Pfad %s ist weg (404)', async (pfad) => {
    expect((await get(pfad)).statusCode).toBe(404);
  });

  it('Jobs der umgezogenen Module laufen im Job-Planer des Kerns', () => {
    expect(app.seatmeterKernJobs.map((j) => j.name)).toEqual(
      expect.arrayContaining(['budgets.pruefen', 'hinweise.erzeugen', 'abgleich.analytics']),
    );
  });
});
