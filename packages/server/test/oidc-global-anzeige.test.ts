// Anzeige des globalen Anbieters (`SEATMETER_OIDC_*`) auf „SSO und Konten“ und was eine zweite Anbindung daneben tatsächlich
// ändert: Anmeldeweg, Konten und Rollen. Nur erfundene Daten.
import { randomUUID } from 'node:crypto';
import { mandantOidcGlobalSchema } from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { CLIENT_ID, CLIENT_SECRET, FakeIssuer } from './fake-issuer.js';
import { cookiesAus, kernApp, legeMandantAn, meldeAn } from './api-hilfen.js';

const PFAD = '/api/v1/mandant/oidc';
const GEHEIM = 'erfundenes-geheimnis-das-nie-erscheint';

let db: Db;
const offen: FastifyInstance[] = [];

async function mandantMitSlug() {
  const id = await legeMandantAn(db);
  const slug = `m-${randomUUID().slice(0, 8)}`;
  await db.updateTable('mandant').set({ slug }).where('id', '=', id).execute();
  return { id, slug, admin: await meldeAn(db, id, 'mandanten_admin') };
}

async function appMit(env: Record<string, string>) {
  const a = await kernApp(db, inject('testDatenbankUrl'), env);
  offen.push(a);
  return a;
}

const SERVER = {
  SEATMETER_OIDC_ISSUER: 'https://idp.example.org',
  SEATMETER_OIDC_CLIENT_ID: 'seatmeter-server',
  SEATMETER_OIDC_CLIENT_SECRET: GEHEIM,
  SEATMETER_OIDC_BEZEICHNUNG: 'Firmen-Login',
};

beforeAll(() => {
  db = erstelleDb(inject('testDatenbankUrl'), 4);
});

afterAll(async () => {
  await Promise.all(offen.map((a) => a.close()));
  await db.destroy();
});

describe('GET /api/v1/mandant/oidc: global', () => {
  it('ohne Umgebung und bei unvollständiger Umgebung: null', async () => {
    const m = await mandantMitSlug();
    const ohne = await appMit({});
    const r = await ohne.inject({ url: PFAD, headers: m.admin.headers });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().global).toBeNull();
    const teil = await appMit({
      SEATMETER_OIDC_ISSUER: SERVER.SEATMETER_OIDC_ISSUER,
      SEATMETER_OIDC_CLIENT_ID: SERVER.SEATMETER_OIDC_CLIENT_ID,
    });
    expect((await teil.inject({ url: PFAD, headers: m.admin.headers })).json().global).toBeNull();
  });

  it('mit Umgebung: alle Werte, das Secret steht nirgends in der Antwort', async () => {
    const m = await mandantMitSlug();
    const a = await appMit(SERVER);
    const r = await a.inject({ url: PFAD, headers: m.admin.headers });
    expect(r.statusCode, r.body).toBe(200);
    expect(mandantOidcGlobalSchema.parse(r.json().global)).toEqual({
      issuer: 'https://idp.example.org',
      client_id: 'seatmeter-server',
      bezeichnung: 'Firmen-Login',
      scopes: 'openid profile email groups',
      redirect_uri: 'http://seatmeter.test/api/v1/auth/oidc/callback',
      gruppen: [],
    });
    expect(r.json().konfiguration).toBeNull();
    expect(r.body).not.toContain(GEHEIM);
    expect(Object.keys(r.json().global)).not.toContain('client_secret');
  });

  it('auch die Antwort auf das Speichern enthält global und nie ein Secret', async () => {
    const m = await mandantMitSlug();
    const a = await appMit(SERVER);
    const r = await a.inject({
      method: 'PUT',
      url: PFAD,
      headers: m.admin.headers,
      payload: {
        issuer: 'https://idp-eigen.example.org',
        client_id: 'eigen',
        client_secret: 'zweites-erfundenes-geheimnis',
        bezeichnung: 'Eigen',
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().global.issuer).toBe('https://idp.example.org');
    expect(r.json().konfiguration.issuer).toBe('https://idp-eigen.example.org');
    expect(r.body).not.toContain(GEHEIM);
    expect(r.body).not.toContain('zweites-erfundenes-geheimnis');
  });

  it('Gruppen: nur Zuordnungen auf diesen Mandanten, nie fremde und nie plattform_admin', async () => {
    const a1 = await mandantMitSlug();
    const b1 = await mandantMitSlug();
    const a = await appMit({
      ...SERVER,
      SEATMETER_OIDC_GRUPPEN: JSON.stringify({
        'beide-mandanten': [
          { mandant: a1.slug, rolle: 'mandanten_admin' },
          { mandant: a1.slug, rolle: 'controller' },
          { mandant: a1.slug, rolle: 'controller' },
          { mandant: b1.slug, rolle: 'betriebsrat' },
        ],
        'nur-fremder-mandant': { mandant: b1.slug, rolle: 'controller' },
        'nur-plattform': { plattform_admin: true },
        'plattform-und-mandant': [
          { plattform_admin: true },
          { mandant: a1.slug, rolle: 'entwickler' },
        ],
        'projekt-leitung': {
          mandant: a1.slug,
          rolle: 'projektleiter',
          projekt_ids: [randomUUID()],
        },
      }),
    });
    const r = await a.inject({ url: PFAD, headers: a1.admin.headers });
    expect(mandantOidcGlobalSchema.parse(r.json().global).gruppen).toEqual([
      { gruppe: 'beide-mandanten', rollen: ['mandanten_admin', 'controller'] },
      { gruppe: 'plattform-und-mandant', rollen: ['entwickler'] },
      { gruppe: 'projekt-leitung', rollen: ['projektleiter'] },
    ]);
    for (const fremd of ['nur-fremder-mandant', 'nur-plattform', 'plattform_admin', b1.slug]) {
      expect(r.body, fremd).not.toContain(fremd);
    }
    expect(r.body).not.toContain('betriebsrat');
    expect(r.body).not.toContain('projekt_ids');

    const r2 = await a.inject({ url: PFAD, headers: b1.admin.headers });
    expect(mandantOidcGlobalSchema.parse(r2.json().global).gruppen).toEqual([
      { gruppe: 'beide-mandanten', rollen: ['betriebsrat'] },
      { gruppe: 'nur-fremder-mandant', rollen: ['controller'] },
    ]);
    for (const fremd of ['plattform-und-mandant', 'nur-plattform', 'plattform_admin', a1.slug]) {
      expect(r2.body, fremd).not.toContain(fremd);
    }
  });

  it('Mandant ohne Zuordnung: leere Liste', async () => {
    const m = await mandantMitSlug();
    const a = await appMit({
      ...SERVER,
      SEATMETER_OIDC_GRUPPEN: JSON.stringify({
        andere: { mandant: 'anderer', rolle: 'controller' },
      }),
    });
    const r = await a.inject({ url: PFAD, headers: m.admin.headers });
    expect(r.json().global.gruppen).toEqual([]);
    expect(r.body).not.toContain('andere');
  });

  it('ohne Mandanten-Admin weiter 403, auch mit Umgebung', async () => {
    const m = await mandantMitSlug();
    const a = await appMit(SERVER);
    for (const rolle of ['controller', 'projektleiter', 'betriebsrat', 'entwickler'] as const) {
      const s = await meldeAn(db, m.id, rolle, rolle === 'projektleiter' ? [] : null);
      const r = await a.inject({ url: PFAD, headers: s.headers });
      expect(r.statusCode, rolle).toBe(403);
      expect(r.body, rolle).not.toContain('idp.example.org');
    }
    expect((await a.inject({ url: PFAD })).statusCode).toBe(401);
  });
});

describe('Was eine zweite Anbindung neben der Serverkonfiguration ändert', () => {
  const server = new FakeIssuer();
  const eigen = new FakeIssuer();
  let app: FastifyInstance;
  let m: Awaited<ReturnType<typeof mandantMitSlug>>;

  beforeAll(async () => {
    await server.starten();
    await eigen.starten();
    m = await mandantMitSlug();
    app = await appMit({
      SEATMETER_OIDC_ISSUER: server.issuer,
      SEATMETER_OIDC_CLIENT_ID: CLIENT_ID,
      SEATMETER_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      SEATMETER_OIDC_BEZEICHNUNG: 'Firmen-Login',
      SEATMETER_OIDC_PRIVATE_ZIELE: '1',
      SEATMETER_OIDC_GRUPPEN: JSON.stringify({
        leser: { mandant: m.slug, rolle: 'controller' },
        rat: { mandant: m.slug, rolle: 'betriebsrat' },
      }),
    });
  });

  afterAll(async () => {
    await server.stoppen();
    await eigen.stoppen();
  });

  /** Anmeldung durch den echten Ablauf; `mandant` = über die Anbindung des Mandanten. */
  async function anmelden(
    aussteller: FakeIssuer,
    claims: Record<string, unknown>,
    mandant?: string,
  ) {
    const start = await app.inject({
      url: `/api/v1/auth/oidc/start${mandant ? `?mandant=${mandant}` : ''}`,
    });
    expect(start.statusCode, start.body).toBe(302);
    const autorisierung = new URL(String(start.headers.location));
    expect(autorisierung.origin).toBe(aussteller.issuer);
    const code = aussteller.code(autorisierung, claims);
    const r = await app.inject({
      url: `/api/v1/auth/oidc/callback?code=${code}&state=${autorisierung.searchParams.get('state')}`,
      headers: { cookie: cookiesAus(start) },
    });
    expect(r.statusCode, r.body).toBe(302);
    return cookiesAus(r);
  }

  const konto = (benutzername: string) =>
    db
      .selectFrom('benutzer')
      .select(['id', 'oidc_issuer', 'benutzername'])
      .where('benutzername', '=', benutzername)
      .executeTakeFirst();
  const rollen = async (mandantId: string, benutzerId: string) =>
    (
      await withMandant(db, mandantId, (t) =>
        t.selectFrom('rolle').select('rolle').where('benutzer_id', '=', benutzerId).execute(),
      )
    )
      .map((r) => r.rolle)
      .sort();
  const anbindung = (aussteller: FakeIssuer, aktiv = true, gruppen = {}) =>
    app.inject({
      method: 'PUT',
      url: PFAD,
      headers: m.admin.headers,
      payload: {
        issuer: aussteller.issuer,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        bezeichnung: 'Eigene Anbindung',
        gruppen_rollen: gruppen,
        aktiv,
      },
    });
  const ohneAnbindung = () => app.inject({ method: 'DELETE', url: PFAD, headers: m.admin.headers });
  const email = () => `person-${randomUUID().slice(0, 8)}@firma.example.org`;

  it('Anmeldeseite: Der Knopf bleibt; Kürzel und verifizierte Domain führen zur eigenen Anbindung, sonst nichts', async () => {
    const domain = `firma-${randomUUID().slice(0, 8)}.example.org`;
    await db
      .insertInto('mandant_domain')
      .values({ domain, mandant_id: m.id, verifiziert: true, verifizierungs_token: 'erfunden' })
      .execute();
    const anbieter = async (abfrage = '') =>
      (await app.inject({ url: `/api/v1/auth/anbieter${abfrage}` })).json();
    const knopf = {
      name: 'oidc',
      titel: 'Mit Firmen-Login anmelden',
      start: '/api/v1/auth/oidc/start',
    };
    const ziel = {
      bezeichnung: 'Eigene Anbindung',
      start_url: `/api/v1/auth/oidc/start?mandant=${m.slug}`,
    };

    // Ohne eigene Anbindung: nur der Knopf, Kürzel und Domain führen nirgends hin.
    await ohneAnbindung();
    expect((await anbieter()).anbieter).toContainEqual(knopf);
    expect((await anbieter(`?mandant=${m.slug}`)).oidc).toBeNull();

    expect((await anbindung(eigen)).statusCode).toBe(200);
    expect((await anbieter()).anbieter).toContainEqual(knopf);
    expect((await anbieter(`?mandant=${m.slug}`)).oidc).toEqual(ziel);
    expect((await anbieter(`?email=a@${domain}`)).oidc).toEqual(ziel);
    expect((await anbieter(`?mandant=${m.slug}`)).anbieter).toContainEqual(knopf);
    // Eine fremde Domain führt nicht dorthin.
    expect((await anbieter(`?email=a@anders.example.org`)).oidc).toBeNull();
    // Inaktiv: kein Weg mehr dorthin, der Knopf bleibt.
    expect((await anbindung(eigen, false)).statusCode).toBe(200);
    expect((await anbieter(`?mandant=${m.slug}`)).oidc).toBeNull();
    expect((await anbieter()).anbieter).toContainEqual(knopf);
  });

  it('Anderer Issuer: eigenes Konto trotz gleicher E-Mail, ohne die bisherigen Rollen; das alte bleibt', async () => {
    await ohneAnbindung();
    const adresse = email();
    await anmelden(server, { sub: 's-1', email: adresse, groups: ['leser'] });
    const alt = await konto(adresse);
    expect(alt?.oidc_issuer).toBe(server.issuer);
    expect(await rollen(m.id, alt?.id ?? '')).toEqual(['controller']);

    expect((await anbindung(eigen)).statusCode).toBe(200);
    await anmelden(eigen, { sub: 's-2', email: adresse, email_verified: true }, m.slug);
    const neu = await db
      .selectFrom('benutzer')
      .select(['id', 'benutzername', 'oidc_issuer'])
      .where('oidc_issuer', '=', eigen.issuer)
      .where('oidc_sub', '=', 's-2')
      .executeTakeFirstOrThrow();
    expect(neu.id).not.toBe(alt?.id);
    expect(neu.benutzername).toBe(`oidc:${m.slug}:s-2`);
    expect(await rollen(m.id, neu.id)).toEqual([]);
    expect(await rollen(m.id, alt?.id ?? '')).toEqual(['controller']);
  });

  it('Gleicher Issuer: dasselbe Konto, es gelten dann auch die Gruppen der eigenen Anbindung', async () => {
    await ohneAnbindung();
    const adresse = email();
    await anmelden(server, { sub: 's-3', email: adresse, groups: ['leser'] });
    const alt = await konto(adresse);
    expect((await anbindung(server, true, { eigene: 'projektleiter' })).statusCode).toBe(200);
    await anmelden(server, { sub: 's-3', email: adresse, groups: ['eigene'] }, m.slug);
    expect((await konto(adresse))?.id).toBe(alt?.id);
    const zahl = await db
      .selectFrom('benutzer')
      .select('id')
      .where('oidc_sub', '=', 's-3')
      .execute();
    expect(zahl).toHaveLength(1);
    // Die Rolle aus der alten Gruppe fällt weg, denn beide tragen die Herkunft oidc.
    expect(await rollen(m.id, alt?.id ?? '')).toEqual(['projektleiter']);
  });

  it('Abmelden folgt dem Anmeldedienst des Kontos, nicht dem des Mandanten', async () => {
    const abmelden = async (cookie: string) => {
      const csrf = /seatmeter_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/oidc/logout',
        headers: { cookie, 'x-seatmeter-csrf': csrf },
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json<{ weiter: string | null }>().weiter ?? '';
    };
    expect((await anbindung(eigen, true, { eigene: 'controller' })).statusCode).toBe(200);
    const ueberEigene = await anmelden(
      eigen,
      { sub: 's-6', email: email(), email_verified: true, groups: ['eigene'] },
      m.slug,
    );
    expect(await abmelden(ueberEigene)).toContain(`${eigen.issuer}/abmelden`);
    // Konto der Serverkonfiguration im selben Mandanten, die eigene Anbindung ist aktiv.
    const ueberServer = await anmelden(server, { sub: 's-7', email: email(), groups: ['leser'] });
    expect(await abmelden(ueberServer)).toContain(`${server.issuer}/abmelden`);
  });

  it('Rollen: Mit aktiver eigener Anbindung entzieht die Serverkonfiguration nichts mehr, wenn keine Gruppe mehr passt', async () => {
    // Ohne eigene Anbindung: Gruppe weg, Rolle weg.
    await ohneAnbindung();
    const vorher = email();
    await anmelden(server, { sub: 's-4', email: vorher, groups: ['leser'] });
    const k1 = await konto(vorher);
    expect(await rollen(m.id, k1?.id ?? '')).toEqual(['controller']);
    await anmelden(server, { sub: 's-4', email: vorher, groups: [] });
    expect(await rollen(m.id, k1?.id ?? '')).toEqual([]);

    // Mit aktiver eigener Anbindung: Gruppe weg, Rolle bleibt.
    const adresse = email();
    await anmelden(server, { sub: 's-5', email: adresse, groups: ['leser'] });
    const k2 = await konto(adresse);
    expect((await anbindung(eigen)).statusCode).toBe(200);
    await anmelden(server, { sub: 's-5', email: adresse, groups: [] });
    expect(await rollen(m.id, k2?.id ?? '')).toEqual(['controller']);

    // Neue Rollen vergibt sie weiter. Solange noch eine Gruppe auf den Mandanten zeigt, wird auch entzogen.
    await anmelden(server, { sub: 's-5', email: adresse, groups: ['rat'] });
    expect(await rollen(m.id, k2?.id ?? '')).toEqual(['betriebsrat']);

    // Inaktive Anbindung wirkt nicht: Der Entzug läuft wieder.
    expect((await anbindung(eigen, false)).statusCode).toBe(200);
    await anmelden(server, { sub: 's-5', email: adresse, groups: [] });
    expect(await rollen(m.id, k2?.id ?? '')).toEqual([]);
  });
});
