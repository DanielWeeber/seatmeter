// OIDC (Kern, bis 2026-10-24 ee): Start mit PKCE, Rückruf gegen einen Test-Provider, Konto-Verknüpfung,
// Gruppen → Rollen, Fehler bei state, nonce, PKCE und fehlendem Zustand; Anmeldeknopf nur mit Konfiguration,
// ohne Plugin und ohne Lizenz. Plattform-Admin aus Gruppen prüft ee/server/test/plattform-verwaltung.test.ts.
import { randomUUID } from 'node:crypto';
import {
  erstelleDb,
  rollenDesBenutzers,
  verschluessele,
  withMandant,
  type Db,
} from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET, FakeIssuer } from './fake-issuer.js';
import { cookiesAus, kernApp, legeMandantAn, MASTER_KEY_B64 } from './api-hilfen.js';

describe('OIDC-Anmeldung', () => {
  let db: Db;
  let url: string;
  let app: FastifyInstance;
  const issuer = new FakeIssuer();
  let mandant: string;
  let slug: string;

  beforeAll(async () => {
    url = inject('modulDatenbankUrl');
    db = erstelleDb(url, 4);
    await issuer.starten();
    mandant = await legeMandantAn(db);
    slug = `oidc-${randomUUID().slice(0, 8)}`;
    await db.updateTable('mandant').set({ slug }).where('id', '=', mandant).execute();
    app = await kernApp(db, url, {
      SEATMETER_OIDC_ISSUER: issuer.issuer,
      SEATMETER_OIDC_CLIENT_ID: CLIENT_ID,
      SEATMETER_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      SEATMETER_OIDC_BEZEICHNUNG: 'weeberwrk SSO',
      SEATMETER_OIDC_GRUPPEN: JSON.stringify({
        admins: [{ mandant: slug, rolle: 'mandanten_admin' }, { plattform_admin: true }],
        leser: { mandant: slug, rolle: 'controller' },
        unbekannt: { mandant: 'gibt-es-nicht', rolle: 'controller' },
      }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await issuer.stoppen();
    await db?.destroy();
  });

  async function start(ziel?: string) {
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/start${ziel ? `?ziel=${encodeURIComponent(ziel)}` : ''}`,
    });
    expect(r.statusCode).toBe(302);
    return { autorisierung: new URL(String(r.headers.location)), cookie: cookiesAus(r) };
  }

  async function rueckruf(query: string, cookie: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?${query}`,
      headers: { cookie },
    });
  }

  it('Anmeldeseite bietet „Mit weeberwrk SSO anmelden“ an', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/v1/auth/anbieter' })).json();
    expect(r.anbieter).toEqual([
      { name: 'lokal', titel: 'Anmelden', start: null },
      { name: 'oidc', titel: 'Mit weeberwrk SSO anmelden', start: '/api/v1/auth/oidc/start' },
    ]);
  });

  it('Start leitet mit client_id, PKCE S256, state und nonce zum Provider', async () => {
    const { autorisierung, cookie } = await start();
    expect(autorisierung.origin + autorisierung.pathname).toBe(`${issuer.issuer}/authorize`);
    const p = autorisierung.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toBeTruthy();
    expect(p.get('nonce')).toBeTruthy();
    expect(p.get('redirect_uri')).toBe('http://seatmeter.test/api/v1/auth/oidc/callback');
    expect(p.get('scope')).toBe('openid profile email groups');
    expect(cookie).toMatch(/seatmeter_oidc=/);
  });

  it('Rückruf: legt Konto an, vergibt Rollen aus Gruppen, Sitzung, Weiterleitung (ohne ee kein Plattform-Admin)', async () => {
    const { autorisierung, cookie } = await start('/projekte');
    const sub = randomUUID();
    const email = `neu-${randomUUID().slice(0, 6)}@example.org`;
    const code = issuer.code(autorisierung, {
      sub,
      email,
      email_verified: true,
      groups: ['admins', 'unbekannt'],
    });
    const r = await rueckruf(
      `code=${code}&state=${autorisierung.searchParams.get('state')}`,
      cookie,
    );
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/projekte');
    const sitzung = cookiesAus(r);
    expect(sitzung).toMatch(/seatmeter_sitzung=/);

    const b = await db
      .selectFrom('benutzer')
      .select(['id', 'benutzername', 'login', 'oidc_sub'])
      .where('oidc_sub', '=', sub)
      .executeTakeFirstOrThrow();
    expect(b).toMatchObject({ benutzername: email, login: 'oidc' });
    const me = (
      await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sitzung } })
    ).json();
    expect(me).toMatchObject({ provider: 'oidc', mandant_id: mandant });
    expect(me.plattform_admin).toBeUndefined();
    expect(me.rollen).toContain('mandanten_admin');
    const audit = await withMandant(db, mandant, (trx) =>
      trx
        .selectFrom('audit')
        .select(['aktion', 'objekt'])
        .where('benutzer_id', '=', b.id)
        .execute(),
    );
    expect(audit).toEqual(expect.arrayContaining([{ aktion: 'Anmeldung', objekt: 'OIDC' }]));

    // Zweiter Login nur noch mit Gruppe „leser“: OIDC-Rollen werden angepasst, manuelle bleiben.
    await withMandant(db, mandant, (trx) =>
      trx
        .insertInto('rolle')
        .values({ mandant_id: mandant, benutzer_id: b.id, rolle: 'betriebsrat' })
        .execute(),
    );
    const zwei = await start();
    const code2 = issuer.code(zwei.autorisierung, {
      sub,
      email,
      email_verified: true,
      groups: ['leser'],
    });
    expect(
      (
        await rueckruf(
          `code=${code2}&state=${zwei.autorisierung.searchParams.get('state')}`,
          zwei.cookie,
        )
      ).statusCode,
    ).toBe(302);
    const rollen = (await rollenDesBenutzers(db, b.id)).map((x) => x.rolle).sort();
    expect(rollen).toEqual(['betriebsrat', 'controller']);
  });

  it('verknüpft ein vorhandenes Konto (Header-Modus, Benutzername = E-Mail) über die E-Mail', async () => {
    const email = `alt-${randomUUID().slice(0, 6)}@example.org`;
    const alt = await db
      .insertInto('benutzer')
      .values({ benutzername: email, login: 'lokal' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { autorisierung, cookie } = await start();
    const sub = randomUUID();
    // Gruppen fehlen im ID-Token: kommen aus Userinfo (hier leer) → keine OIDC-Rollen.
    const code = issuer.code(autorisierung, { sub, email, email_verified: true });
    expect(
      (await rueckruf(`code=${code}&state=${autorisierung.searchParams.get('state')}`, cookie))
        .statusCode,
    ).toBe(302);
    const b = await db
      .selectFrom('benutzer')
      .select(['id', 'oidc_sub', 'login'])
      .where('id', '=', alt.id)
      .executeTakeFirstOrThrow();
    expect(b).toMatchObject({ oidc_sub: sub, login: 'oidc' });
  });

  it('lehnt falschen state, fremde nonce, falschen PKCE-Verifier und fehlenden Zustand ab', async () => {
    const claims = { sub: randomUUID(), email: 'x@example.org', groups: [] };
    // falscher state
    const a = await start();
    const c1 = issuer.code(a.autorisierung, claims);
    const r1 = await rueckruf(`code=${c1}&state=falsch`, a.cookie);
    expect(r1.statusCode).toBe(401);
    expect(r1.json().code).toBe('oidc_abgelehnt');
    // nonce eines anderen Vorgangs im ID-Token
    const b = await start();
    const c2 = issuer.code(b.autorisierung, claims, 'andere-nonce');
    expect(
      (await rueckruf(`code=${c2}&state=${b.autorisierung.searchParams.get('state')}`, b.cookie))
        .statusCode,
    ).toBe(401);
    // PKCE: Zustand mit anderem Verifier (selbst verschlüsselt) → Provider lehnt ab
    const c = await start();
    const state = c.autorisierung.searchParams.get('state') ?? '';
    const zustand = {
      state,
      nonce: c.autorisierung.searchParams.get('nonce'),
      verifier: 'x'.repeat(43),
      ziel: '/',
      ablauf: Date.now() + 60_000,
    };
    const gefaelscht = verschluessele(
      Buffer.from(MASTER_KEY_B64, 'base64'),
      JSON.stringify(zustand),
      'oidc.zustand',
    ).toString('base64url');
    const c3 = issuer.code(c.autorisierung, claims);
    const r3 = await rueckruf(`code=${c3}&state=${state}`, `seatmeter_oidc=${gefaelscht}`);
    expect(r3.statusCode).toBe(401);
    // ohne Zustands-Cookie bzw. mit manipuliertem Cookie
    const d = await start();
    const c4 = issuer.code(d.autorisierung, claims);
    expect(
      (await rueckruf(`code=${c4}&state=${d.autorisierung.searchParams.get('state')}`, '')).json()
        .code,
    ).toBe('oidc_zustand');
    expect((await rueckruf(`code=${c4}&state=x`, 'seatmeter_oidc=AAAA')).statusCode).toBe(400);
    // Fehler vom Provider (Abbruch durch den Benutzer)
    const e = await start();
    expect(
      (
        await rueckruf(
          `error=access_denied&state=${e.autorisierung.searchParams.get('state')}`,
          e.cookie,
        )
      ).statusCode,
    ).toBe(401);
  });

  it('ohne Plugin und ohne Lizenz: Anmeldeknopf und Start (kein 402)', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/v1/auth/anbieter' })).json();
    expect(r.anbieter.map((x: { name: string }) => x.name)).toEqual(['lokal', 'oidc']);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' })).statusCode).toBe(
      302,
    );
    expect(app.seatmeter.plugins).toEqual([]);
  });
});
