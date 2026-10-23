// Auth-Tests auf eigener Datenbank: die Einrichtung setzt eine leere Tabelle `benutzer` voraus.
import { Writable } from 'node:stream';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { erstelleApp, logSerializer } from '../src/app.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { migriere } from '../src/db/migrator.js';
import { legeMandantAn, testKonfiguration } from './api-hilfen.js';
import { frischeDatenbank } from './db-hilfen.js';

/** Cookies aus Set-Cookie als Cookie-Header. */
function cookiesAus(r: LightMyRequestResponse): string {
  return r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function csrfAus(r: LightMyRequestResponse): string {
  return r.cookies.find((c) => c.name === 'seatmeter_csrf')?.value ?? '';
}

describe('Modul auth: Einrichtung, Anmeldung, CSRF, Ratenbegrenzung, Header-Modus', () => {
  let db: Db;
  let url: string;
  let app: FastifyInstance;
  let setupToken = '';
  const PASSWORT = 'ein-langes-passwort-123';

  beforeAll(async () => {
    url = await frischeDatenbank('seatmeter_test_auth');
    db = erstelleDb(url, 4);
    await migriere(db);
    // Einrichtungs-Token erzeugt der Server und schreibt es einmal ins Log.
    let logs = '';
    const logStream = new Writable({
      write(chunk, _enc, weiter) {
        logs += String(chunk);
        weiter();
      },
    });
    app = await erstelleApp({
      konfiguration: testKonfiguration(url, { LOG_LEVEL: 'info' }),
      db,
      logStream,
    });
    const zeile = logs.split('\n').find((z) => z.includes('einrichtungs_token'));
    setupToken =
      (JSON.parse(zeile ?? '{}') as { einrichtungs_token?: string }).einrichtungs_token ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it('schreibt das Einrichtungs-Token ins Log, solange kein Benutzer existiert', () => {
    expect(setupToken.length).toBeGreaterThanOrEqual(16);
  });

  it('Anmeldeseite: ?email= bzw. ?mandant= liefert ohne Plugin `oidc: null`, ungültige Abfrage 400', async () => {
    const einfach = await app.inject({ method: 'GET', url: '/api/v1/auth/anbieter' });
    expect(einfach.json()).toEqual({
      anbieter: [{ name: 'lokal', titel: 'Anmelden', start: null }],
    });
    const email = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/anbieter?email=Jemand@Example.org',
    });
    expect(email.json()).toMatchObject({ oidc: null });
    const kuerzel = await app.inject({ method: 'GET', url: '/api/v1/auth/anbieter?mandant=firma' });
    expect(kuerzel.json()).toMatchObject({ oidc: null });
    for (const q of ['email=ohne-at', 'mandant=X_Y', 'email=a@b.org&mandant=firma']) {
      expect(
        (await app.inject({ method: 'GET', url: `/api/v1/auth/anbieter?${q}` })).statusCode,
      ).toBe(400);
    }
  });

  it('Log: Einladungslinks erscheinen ohne Token', () => {
    const req = logSerializer.serializers?.req as (r: { url: string }) => { path: string };
    expect(req({ url: '/einladung/geheimes-token?x=1' }).path).toBe('/einladung/…');
    expect(req({ url: '/api/v1/projekte?monat=2026-10' }).path).toBe('/api/v1/projekte');
  });

  it('Einrichtung: falsches Token 403, richtiges legt Mandant, Admin und Sitzung an, danach 409', async () => {
    const falsch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { setup_token: 'x'.repeat(32), benutzername: 'admin', passwort: PASSWORT },
    });
    expect(falsch.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/setup' })).json()).toEqual({
      noetig: true,
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        token: setupToken,
        login: 'admin',
        passwort: PASSWORT,
        mandant: { name: 'weeberwrk', slug: 'weeberwrk' },
      },
    });
    expect(ok.statusCode).toBe(201);
    const me = ok.json();
    expect(me.benutzer).toMatchObject({ benutzername: 'admin', login: 'admin' });
    expect(me).toMatchObject({
      provider: 'lokal',
      mandant: { name: 'weeberwrk', slug: 'weeberwrk' },
    });
    expect(me.rollen).toEqual(['mandanten_admin']);
    expect(me.mandanten).toHaveLength(1);
    const sitzung = ok.cookies.find((c) => c.name === 'seatmeter_sitzung');
    expect(sitzung).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(ok.cookies.find((c) => c.name === 'seatmeter_csrf')?.httpOnly).toBeFalsy();
    // Salts liegen verschlüsselt vor, Passwort nur als argon2id-Hash.
    const g = await db.selectFrom('mandant_geheimnis').selectAll().executeTakeFirstOrThrow();
    expect(g.person_salt.length).toBe(1 + 12 + 16 + 32);
    const b = await db.selectFrom('benutzer').select('passwort_hash').executeTakeFirstOrThrow();
    expect(b.passwort_hash).toMatch(/^\$argon2id\$/);

    const nochmal = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { setup_token: setupToken, benutzername: 'zweiter', passwort: PASSWORT },
    });
    expect(nochmal.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/setup' })).json()).toEqual({
      noetig: false,
    });
  });

  it('Anmeldung, me, Abmeldung nur mit CSRF-Header', async () => {
    const falsch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { benutzername: 'admin', passwort: 'falsch-falsch' },
    });
    expect(falsch.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { benutzername: 'admin', passwort: PASSWORT },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookiesAus(login);
    const csrf = csrfAus(login);
    expect(login.json().csrf).toBe(csrf);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().mandant_id).toBeTruthy();
    const mandant = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/mandant',
      headers: { cookie },
    });
    expect(mandant.json()).toMatchObject({
      slug: 'weeberwrk',
      auswertungsstufe: 1,
      aufbewahrung_anfrage_tage: 90,
    });

    const ohne = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(ohne.statusCode).toBe(403);
    // Fehlerformat mit stabilem Code (Client erkennt die CSRF-Abweisung daran).
    expect(ohne.json()).toEqual({ code: 'csrf', fehler: 'CSRF-Token fehlt oder passt nicht' });
    const falscherCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-seatmeter-csrf': 'falsch' },
    });
    expect(falscherCsrf.statusCode).toBe(403);
    const aus = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-seatmeter-csrf': csrf },
    });
    expect(aus.statusCode).toBe(204);
    const danach = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(danach.statusCode).toBe(401);

    const audit = await db.selectFrom('audit').select('aktion').execute();
    expect(audit.map((z) => z.aktion)).toEqual(
      expect.arrayContaining(['Einrichtung', 'Anmeldung']),
    );
  });

  it('Mandantenwechsel nur in Mandanten mit Rolle, protokolliert', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { benutzername: 'admin', passwort: PASSWORT },
    });
    const headers = { cookie: cookiesAus(login), 'x-seatmeter-csrf': csrfAus(login) };
    const zweiter = await legeMandantAn(db);
    const fremd = await legeMandantAn(db);
    const admin = await db
      .selectFrom('benutzer')
      .select('id')
      .where('benutzername', '=', 'admin')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('rolle')
      .values({ mandant_id: zweiter, benutzer_id: admin.id, rolle: 'betriebsrat' })
      .execute();

    const verboten = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mandant',
      headers,
      payload: { mandant_id: fremd },
    });
    expect(verboten.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mandant',
      headers,
      payload: { mandant_id: zweiter },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ mandant_id: zweiter, rollen: ['betriebsrat'] });
    expect(ok.json().mandanten).toHaveLength(2);
    const audit = await db
      .selectFrom('audit')
      .select('aktion')
      .where('mandant_id', '=', zweiter)
      .execute();
    expect(audit.map((z) => z.aktion)).toContain('Mandant gewechselt');
    // Betriebsrat darf das Zugriffsprotokoll lesen, aber keine Preise ändern.
    expect((await app.inject({ method: 'GET', url: '/api/v1/audit', headers })).statusCode).toBe(
      200,
    );
    const preis = await app.inject({ method: 'POST', url: '/api/v1/preise', headers, payload: {} });
    expect(preis.statusCode).toBe(403);
  });

  it('Ratenbegrenzung: nach 5 Fehlversuchen 429, auch mit richtigem Passwort', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { benutzername: 'admin', passwort: `falsch-${i}` },
      });
      expect(r.statusCode).toBe(401);
    }
    const gesperrt = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { benutzername: 'admin', passwort: PASSWORT },
    });
    expect(gesperrt.statusCode).toBe(429);
    expect(gesperrt.headers['retry-after']).toBe('900');
  });

  it('Header-Modus: ohne Konfiguration wirkungslos', async () => {
    const vorher = await db.selectFrom('benutzer').select('id').execute();
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { 'remote-email': 'person@example.org' },
    });
    expect(r.statusCode).toBe(401);
    expect(await db.selectFrom('benutzer').select('id').execute()).toHaveLength(vorher.length);
  });

  it('Header-Modus: legt Benutzer beim ersten Mal mit Rolle an und meldet an', async () => {
    const mitHeader = await erstelleApp({
      konfiguration: testKonfiguration(url, {
        SEATMETER_TRUST_REMOTE_USER_HEADER: 'Remote-Email',
        SEATMETER_AUTO_MANDANT: 'weeberwrk',
      }),
      db,
    });
    try {
      const r = await mitHeader.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'remote-email': 'person@example.org' },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        benutzer: { benutzername: 'person@example.org' },
        rollen: ['mandanten_admin'],
      });
      const cookie = cookiesAus(r);
      // Zweiter Aufruf mit Sitzung: kein neuer Benutzer.
      const zwei = await mitHeader.inject({
        method: 'GET',
        url: '/api/v1/uebersicht',
        headers: { cookie, 'remote-email': 'person@example.org' },
      });
      expect(zwei.statusCode).toBe(200);
      const benutzer = await db
        .selectFrom('benutzer')
        .select(['benutzername', 'passwort_hash'])
        .where('benutzername', '=', 'person@example.org')
        .execute();
      expect(benutzer).toEqual([{ benutzername: 'person@example.org', passwort_hash: null }]);
      // Anderer Benutzer am Proxy: Sitzung gilt nicht weiter.
      const anderer = await mitHeader.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie, 'remote-email': 'zweite@example.org' },
      });
      expect(anderer.json().benutzer.benutzername).toBe('zweite@example.org');
    } finally {
      await mitHeader.close();
    }
  });

  it('Header-Modus: cookielose Anfragen nutzen die offene Sitzung (1 Sitzung, 1 Audit-Eintrag)', async () => {
    const mitHeader = await erstelleApp({
      konfiguration: testKonfiguration(url, {
        SEATMETER_TRUST_REMOTE_USER_HEADER: 'Remote-Email',
        SEATMETER_AUTO_MANDANT: 'weeberwrk',
      }),
      db,
    });
    const name = 'monitor@example.org';
    const kopf = { 'remote-email': name };
    try {
      const antworten: LightMyRequestResponse[] = [];
      for (let i = 0; i < 10; i++) {
        antworten.push(
          await mitHeader.inject({ method: 'GET', url: '/api/v1/uebersicht', headers: kopf }),
        );
      }
      expect(antworten.map((r) => r.statusCode)).toEqual(Array(10).fill(200));
      // Gleichzeitige Anfragen legen ebenfalls keine weitere Sitzung an.
      const parallel = await Promise.all(
        Array.from({ length: 5 }, () =>
          mitHeader.inject({ method: 'GET', url: '/api/v1/auth/me', headers: kopf }),
        ),
      );
      expect(parallel.map((r) => r.statusCode)).toEqual(Array(5).fill(200));
      const benutzer = await db
        .selectFrom('benutzer')
        .select('id')
        .where('benutzername', '=', name)
        .executeTakeFirstOrThrow();
      const sitzungen = await db
        .selectFrom('benutzer_sitzung')
        .select(['id', 'csrf', 'quelle'])
        .where('benutzer_id', '=', benutzer.id)
        .execute();
      expect(sitzungen).toHaveLength(1);
      expect(sitzungen[0]?.quelle).toBe('remote_user');
      const anmeldungen = await db
        .selectFrom('audit')
        .select('aktion')
        .where('benutzer_id', '=', benutzer.id)
        .where('aktion', '=', 'Anmeldung')
        .execute();
      expect(anmeldungen).toHaveLength(1);
      // Sitzungs-Cookie nur mit der neuen Sitzung, CSRF-Cookie und `csrf` immer passend zur Sitzung.
      expect(antworten[0]?.cookies.map((c) => c.name).sort()).toEqual([
        'seatmeter_csrf',
        'seatmeter_sitzung',
      ]);
      expect(antworten[1]?.cookies.map((c) => c.name)).toEqual(['seatmeter_csrf']);
      expect(parallel.every((r) => r.json().csrf === sitzungen[0]?.csrf)).toBe(true);
      // Zustandsänderung ohne Cookie mit dem CSRF-Wert aus /me.
      const mandantId = parallel[0]?.json().mandant_id as string;
      const wechsel = await mitHeader.inject({
        method: 'POST',
        url: '/api/v1/auth/mandant',
        headers: { ...kopf, 'x-seatmeter-csrf': sitzungen[0]?.csrf ?? '' },
        payload: { mandant_id: mandantId },
      });
      expect(wechsel.statusCode).toBe(200);
      // Abgelaufene Sitzung: nächste Anfrage legt genau eine neue an (mit Audit).
      await db
        .updateTable('benutzer_sitzung')
        .set({ laeuft_ab: new Date(Date.now() - 1000) })
        .where('benutzer_id', '=', benutzer.id)
        .execute();
      const neu = await mitHeader.inject({ method: 'GET', url: '/api/v1/auth/me', headers: kopf });
      expect(neu.statusCode).toBe(200);
      expect(neu.cookies.some((c) => c.name === 'seatmeter_sitzung')).toBe(true);
      await mitHeader.inject({ method: 'GET', url: '/api/v1/auth/me', headers: kopf });
      const offen = await db
        .selectFrom('benutzer_sitzung')
        .select('id')
        .where('benutzer_id', '=', benutzer.id)
        .where('laeuft_ab', '>', new Date())
        .execute();
      expect(offen).toHaveLength(1);
      const danach = await db
        .selectFrom('audit')
        .select('aktion')
        .where('benutzer_id', '=', benutzer.id)
        .where('aktion', '=', 'Anmeldung')
        .execute();
      expect(danach).toHaveLength(2);
    } finally {
      await mitHeader.close();
    }
  });
});
