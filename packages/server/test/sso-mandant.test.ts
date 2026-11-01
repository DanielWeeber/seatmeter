// SSO je Mandant (Kern, bis 2026-10-24 ee): OIDC-Konfiguration je Mandant (Secret nie in Antworten), Anmeldung
// über zwei Mandanten mit getrennten Test-Issuern (gleiches `sub`, getrennte Konten), Gruppen → Rollen nur im
// eigenen Mandanten, E-Mail-Domains (DNS-TXT, eindeutig, öffentliche Anbieter), Anmeldeseite per Domain und
// Kürzel, Einladung (einmal, Ablauf), letzter Admin, RLS-Trennung, ohne Plugin und ohne Lizenz. Kontenkontingent
// und Plattform-Admin (Mandantenfähigkeit) prüft ee/server/test/plattform-verwaltung.test.ts.
import { randomUUID } from 'node:crypto';
import { erstelleDb, sha256, withMandant, type Db } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { setzeTxtAufloeser } from '../src/konten/domains.js';
import { VERWALTUNG_AUDIT } from '../src/mandant/verwaltung.js';
import { CLIENT_ID, CLIENT_SECRET, FakeIssuer } from './fake-issuer.js';
import { cookiesAus, kernApp, legeMandantAn, meldeAn } from './api-hilfen.js';

type Sitzung = Awaited<ReturnType<typeof meldeAn>>;

describe('SSO je Mandant', () => {
  let db: Db;
  let url: string;
  let app: FastifyInstance;
  const issuerA = new FakeIssuer();
  const issuerB = new FakeIssuer();
  let mandantA: string;
  let mandantB: string;
  const slugA = `sso-a-${randomUUID().slice(0, 6)}`;
  const slugB = `sso-b-${randomUUID().slice(0, 6)}`;
  const domainA = `firma-${randomUUID().slice(0, 6)}.example.org`;
  let adminA: Sitzung;
  let adminB: Sitzung;

  beforeAll(async () => {
    url = inject('modulDatenbankUrl');
    db = erstelleDb(url, 4);
    await issuerA.starten();
    await issuerB.starten();
    mandantA = await legeMandantAn(db);
    mandantB = await legeMandantAn(db);
    await db.updateTable('mandant').set({ slug: slugA }).where('id', '=', mandantA).execute();
    await db.updateTable('mandant').set({ slug: slugB }).where('id', '=', mandantB).execute();
    adminA = await meldeAn(db, mandantA, 'mandanten_admin');
    adminB = await meldeAn(db, mandantB, 'mandanten_admin');
    app = await kernApp(db, url);
  });

  afterAll(async () => {
    setzeTxtAufloeser(null);
    await app?.close();
    await issuerA.stoppen();
    await issuerB.stoppen();
    await db?.destroy();
  });

  const anfrage = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pfad: string,
    s: Sitzung,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: pfad,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  async function anmelden(
    slug: string,
    issuer: FakeIssuer,
    claims: Record<string, unknown>,
    accept?: string,
  ) {
    const s = await app.inject({ method: 'GET', url: `/api/v1/auth/oidc/start?mandant=${slug}` });
    expect(s.statusCode).toBe(302);
    const autorisierung = new URL(String(s.headers.location));
    expect(autorisierung.origin).toBe(issuer.issuer);
    const code = issuer.code(autorisierung, claims);
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=${code}&state=${autorisierung.searchParams.get('state')}`,
      headers: { cookie: cookiesAus(s), ...(accept ? { accept } : {}) },
    });
  }

  const konfig = (issuer: string, gruppen: Record<string, unknown>) => ({
    issuer,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    bezeichnung: 'Firmen-SSO',
    gruppen_rollen: gruppen,
  });

  it('OIDC-Konfiguration: Secret Pflicht, nie in Antworten, verschlüsselt, nur eigener Mandant', async () => {
    const ohne = await anfrage('PUT', `/api/v1/mandant/oidc?mandant=${mandantA}`, adminA, {
      ...konfig(issuerA.issuer, {}),
      client_secret: undefined,
    });
    expect(ohne.statusCode).toBe(400);
    expect(ohne.json().code).toBe('client_secret_fehlt');
    const unsicher = await anfrage('PUT', `/api/v1/mandant/oidc?mandant=${mandantA}`, adminA, {
      ...konfig('http://idp.example.org', {}),
    });
    expect(unsicher.statusCode).toBe(400);

    const r = await anfrage(
      'PUT',
      `/api/v1/mandant/oidc?mandant=${mandantA}`,
      adminA,
      konfig(issuerA.issuer, { 'sm-admins': 'controller', 'sm-br': ['betriebsrat', 'controller'] }),
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(CLIENT_SECRET);
    expect(r.json()).toMatchObject({
      konfiguration: {
        issuer: issuerA.issuer,
        client_id: CLIENT_ID,
        client_secret_gesetzt: true,
        bezeichnung: 'Firmen-SSO',
        gruppen_rollen: { 'sm-admins': ['controller'], 'sm-br': ['betriebsrat', 'controller'] },
        aktiv: true,
      },
      redirect_uri: 'http://seatmeter.test/api/v1/auth/oidc/callback',
      start_url: `/api/v1/auth/oidc/start?mandant=${slugA}`,
    });
    const roh = await db
      .selectFrom('mandant_oidc')
      .select('client_secret')
      .where('mandant_id', '=', mandantA)
      .executeTakeFirstOrThrow();
    expect(roh.client_secret.toString('utf8')).not.toContain(CLIENT_SECRET);

    // Ohne Secret bleibt es erhalten.
    const zwei = await anfrage('PUT', `/api/v1/mandant/oidc?mandant=${mandantA}`, adminA, {
      ...konfig(issuerA.issuer, { 'sm-admins': 'controller' }),
      client_secret: undefined,
    });
    expect(zwei.statusCode).toBe(200);
    expect(
      (await anfrage('GET', `/api/v1/mandant/oidc?mandant=${mandantA}`, adminB)).statusCode,
    ).toBe(403);
    const b = await anfrage(
      'PUT',
      `/api/v1/mandant/oidc?mandant=${mandantB}`,
      adminB,
      konfig(issuerB.issuer, { leser: ['controller'] }),
    );
    expect(b.statusCode).toBe(200);

    const pruefung = await anfrage(
      'POST',
      `/api/v1/mandant/oidc/pruefen?mandant=${mandantA}`,
      adminA,
      {},
    );
    expect(pruefung.json()).toMatchObject({
      ok: true,
      issuer: issuerA.issuer,
      endpunkte: { authorization: `${issuerA.issuer}/authorize` },
    });
    // RLS: im Kontext von A ist die Konfiguration von B unsichtbar.
    const sichtbar = await withMandant(db, mandantA, (trx) =>
      trx.selectFrom('mandant_oidc').select('mandant_id').execute(),
    );
    expect(sichtbar).toEqual([{ mandant_id: mandantA }]);
    const audit = await withMandant(db, mandantA, (trx) =>
      trx.selectFrom('audit').select('aktion').where('aktion', 'like', 'OIDC%').execute(),
    );
    expect(audit.map((a) => a.aktion)).toEqual(
      expect.arrayContaining(['OIDC-Konfiguration geändert', 'OIDC-Konfiguration geprüft']),
    );
  });

  it('Anmeldung je Mandant: gleiches sub bei zwei Issuern = zwei Konten, Rollen nur im eigenen Mandanten', async () => {
    const sub = randomUUID();
    const r = await anmelden(slugA, issuerA, {
      sub,
      email: `person-${sub.slice(0, 6)}@a.example.org`,
      email_verified: true,
      groups: ['sm-admins'],
    });
    expect(r.statusCode).toBe(302);
    const sitzung = cookiesAus(r);
    const me = (
      await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: sitzung } })
    ).json();
    expect(me).toMatchObject({ provider: 'oidc', mandant_id: mandantA, rollen: ['controller'] });

    const rb = await anmelden(slugB, issuerB, { sub, groups: ['leser'] });
    expect(rb.statusCode).toBe(302);
    const konten = await db
      .selectFrom('benutzer')
      .select(['id', 'benutzername', 'oidc_issuer'])
      .where('oidc_sub', '=', sub)
      .orderBy('oidc_issuer')
      .execute();
    expect(konten).toHaveLength(2);
    expect(new Set(konten.map((k) => k.oidc_issuer))).toEqual(
      new Set([issuerA.issuer, issuerB.issuer]),
    );
    const kontoB = konten.find((k) => k.oidc_issuer === issuerB.issuer)!;
    expect(kontoB.benutzername).toBe(`oidc:${slugB}:${sub}`);
    const rollenB = await withMandant(db, mandantB, (trx) =>
      trx
        .selectFrom('rolle')
        .select(['rolle', 'quelle'])
        .where('benutzer_id', '=', kontoB.id)
        .execute(),
    );
    expect(rollenB).toEqual([{ rolle: 'controller', quelle: 'oidc' }]);

    // Zweiter Login ohne Gruppe: OIDC-Rolle entzogen.
    const kontoA = konten.find((k) => k.oidc_issuer === issuerA.issuer)!;
    await anmelden(slugA, issuerA, { sub, email: kontoA.benutzername, groups: [] });
    const rest = await withMandant(db, mandantA, (trx) =>
      trx.selectFrom('rolle').select('rolle').where('benutzer_id', '=', kontoA.id).execute(),
    );
    expect(rest).toEqual([]);
  });

  it('E-Mail-Domains: eindeutig, öffentliche Anbieter abgelehnt, DNS-TXT, keine Direktfreigabe, RLS', async () => {
    const neu = await anfrage('POST', `/api/v1/mandant/domains?mandant=${mandantA}`, adminA, {
      domain: ` ${domainA.toUpperCase()}. `,
    });
    expect(neu.statusCode).toBe(201);
    const d = neu.json();
    expect(d).toMatchObject({
      domain: domainA,
      verifiziert: false,
      txt_name: `_seatmeter.${domainA}`,
    });
    expect(d.txt_wert).toBe(`seatmeter-verifizierung=${d.verifizierungs_token}`);
    const doppelt = await anfrage('POST', `/api/v1/mandant/domains?mandant=${mandantB}`, adminB, {
      domain: domainA,
    });
    expect(doppelt.statusCode).toBe(409);
    expect(doppelt.json().code).toBe('domain_vergeben');
    const gmail = await anfrage('POST', `/api/v1/mandant/domains?mandant=${mandantB}`, adminB, {
      domain: 'GMAIL.com',
    });
    expect(gmail.json().code).toBe('domain_oeffentlich');
    expect(
      (await anfrage('GET', `/api/v1/mandant/domains?mandant=${mandantA}`, adminB)).statusCode,
    ).toBe(403);

    // Vor der Verifizierung führt die Domain nirgendwohin.
    const vorher = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/anbieter?email=x@${domainA}`,
    });
    expect(vorher.json().oidc).toBeNull();

    setzeTxtAufloeser(async () => [['falsch']]);
    const falsch = await anfrage(
      'POST',
      `/api/v1/mandant/domains/${domainA}/pruefen?mandant=${mandantA}`,
      adminA,
      {},
    );
    expect(falsch.json()).toMatchObject({ verifiziert: false });
    expect(falsch.json().fehler).toContain(`_seatmeter.${domainA}`);
    const namen: string[] = [];
    setzeTxtAufloeser(async (name) => {
      namen.push(name);
      return [['v=spf1 -all'], ['seatmeter-verifizierung=', d.verifizierungs_token]];
    });
    const ok = await anfrage(
      'POST',
      `/api/v1/mandant/domains/${domainA}/pruefen?mandant=${mandantA}`,
      adminA,
      {},
    );
    expect(ok.json()).toMatchObject({ verifiziert: true, domain: { quelle: 'dns' } });
    expect(namen).toEqual([`_seatmeter.${domainA}`]);

    const treffer = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/anbieter?email=Jemand@${domainA.toUpperCase()}`,
    });
    expect(treffer.json()).toMatchObject({
      anbieter: [{ name: 'lokal' }],
      oidc: { bezeichnung: 'Firmen-SSO', start_url: `/api/v1/auth/oidc/start?mandant=${slugA}` },
    });
    const fremd = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/anbieter?email=jemand@unbekannt.example.org',
    });
    expect(fremd.json().oidc).toBeNull();
    const kuerzel = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/anbieter?mandant=${slugB}`,
    });
    expect(kuerzel.json().oidc).toMatchObject({ bezeichnung: 'Firmen-SSO' });

    // Direkt verifiziert nur ein Plattform-Admin (ee); der Mandanten-Admin darf das nicht.
    const domainB = `b-${randomUUID().slice(0, 6)}.example.org`;
    await anfrage('POST', `/api/v1/mandant/domains?mandant=${mandantB}`, adminB, {
      domain: domainB,
    });
    expect(
      (
        await anfrage('PUT', `/api/v1/mandant/domains/${domainB}?mandant=${mandantB}`, adminB, {
          verifiziert: true,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('Einladung annehmen: Konto nur mit `entwickler` steht nicht im Audit, andere Rollen weiter', async () => {
    const einladen = async (rollen: string[]) => {
      const r = await anfrage('POST', `/api/v1/mandant/konten?mandant=${mandantA}`, adminA, {
        benutzername: `audit-${randomUUID().slice(0, 6)}@${domainA}`,
        rollen,
      });
      expect(r.statusCode, r.body).toBe(201);
      const { konto, einladung } = r.json();
      const an = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/einladung',
        payload: { token: einladung.url.split('/').pop(), passwort: 'ein-langes-passwort-123' },
      });
      expect(an.statusCode, an.body).toBe(200);
      const zeile = await withMandant(db, mandantA, (t) =>
        t
          .selectFrom('audit')
          .select(['benutzer_id', 'objekt'])
          .where('aktion', '=', VERWALTUNG_AUDIT.einladungAngenommen)
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow(),
      );
      return { kontoId: konto.id as string, zeile };
    };
    const nurWahl = await einladen(['entwickler']);
    expect(nurWahl.zeile.benutzer_id).toBeNull();
    expect(nurWahl.zeile.objekt).toBe('Rolle entwickler');
    expect(nurWahl.zeile.objekt).not.toContain(nurWahl.kontoId);
    // Die Einladung selbst nimmt ein Admin offen vor: Sie bleibt mit Konto im Audit (Grenze in der Doku).
    const offen = await withMandant(db, mandantA, (t) =>
      t
        .selectFrom('audit')
        .select(['benutzer_id', 'objekt'])
        .where('aktion', '=', VERWALTUNG_AUDIT.kontoEingeladen)
        .where('objekt', '=', `benutzer:${nurWahl.kontoId}`)
        .execute(),
    );
    expect(offen.map((z) => z.benutzer_id)).toEqual([adminA.benutzerId]);
    const mitRolle = await einladen(['entwickler', 'controller']);
    expect(mitRolle.zeile.benutzer_id).toBe(mitRolle.kontoId);
    expect(mitRolle.zeile.objekt).toBe(`benutzer:${mitRolle.kontoId}`);
    const nurLeser = await einladen(['controller']);
    expect(nurLeser.zeile.benutzer_id).toBe(nurLeser.kontoId);
  });

  it('Mandant wechseln: in einen Mandanten nur mit `entwickler` kein Eintrag, andere Rollen wie bisher', async () => {
    const u = await meldeAn(db, mandantA, 'controller');
    await db
      .insertInto('rolle')
      .values({ mandant_id: mandantB, benutzer_id: u.benutzerId, rolle: 'entwickler' })
      .execute();
    const wechseln = async (mandant_id: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/mandant',
        headers: u.headers,
        payload: { mandant_id },
      });
      expect(r.statusCode, r.body).toBe(200);
    };
    const wechsel = (mandantId: string) =>
      withMandant(db, mandantId, (t) =>
        t
          .selectFrom('audit')
          .select(['id', 'benutzer_id'])
          .where('aktion', '=', 'Mandant gewechselt')
          .execute(),
      );
    const vorherB = (await wechsel(mandantB)).length;
    await wechseln(mandantB);
    expect(await wechsel(mandantB)).toHaveLength(vorherB);
    // Zurück in den Mandanten mit Dashboard-Rolle: steht wie bisher mit Konto drin.
    await wechseln(mandantA);
    expect((await wechsel(mandantA)).map((z) => z.benutzer_id)).toContain(u.benutzerId);
    // Mit weiterer Rolle zählt es nicht mehr als „nur entwickler“.
    await db
      .insertInto('rolle')
      .values({ mandant_id: mandantB, benutzer_id: u.benutzerId, rolle: 'controller' })
      .execute();
    await wechseln(mandantB);
    expect((await wechsel(mandantB)).map((z) => z.benutzer_id)).toContain(u.benutzerId);
  });

  it('Einladung: Link einmal nutzbar, vorher keine Anmeldung, Ablauf, danach Passwort-Login', async () => {
    const email = `neu-${randomUUID().slice(0, 6)}@${domainA}`;
    const r = await anfrage('POST', `/api/v1/mandant/konten?mandant=${mandantA}`, adminA, {
      benutzername: email.toUpperCase(),
      rollen: ['controller'],
    });
    expect(r.statusCode).toBe(201);
    const { konto, einladung } = r.json();
    expect(konto).toMatchObject({ benutzername: email, einladung_offen: true });
    expect(einladung.url).toMatch(/^\/einladung\/[A-Za-z0-9_-]{40,}$/);
    const token = einladung.url.split('/').pop();
    const passwort = 'ein-langes-passwort-123';

    // Vor der Annahme: keine Anmeldung möglich.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: email, passwort },
        })
      ).statusCode,
    ).toBe(401);
    const pruefen = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/einladung/pruefen',
      payload: { token },
    });
    expect(pruefen.json()).toMatchObject({ benutzername: email });
    const zuKurz = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/einladung',
      payload: { token, passwort: 'kurz' },
    });
    expect(zuKurz.statusCode).toBe(400);
    const an = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/einladung',
      payload: { token, passwort },
    });
    expect(an.statusCode).toBe(200);
    expect(an.json()).toMatchObject({ mandant_id: mandantA, rollen: ['controller'] });
    expect(cookiesAus(an)).toMatch(/seatmeter_sitzung=/);
    const nochmal = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/einladung',
      payload: { token, passwort },
    });
    expect(nochmal.statusCode).toBe(404);
    expect(nochmal.json().code).toBe('einladung_ungueltig');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { login: email, passwort },
        })
      ).statusCode,
    ).toBe(200);

    // Ablauf: abgelaufene Einladung ist wertlos; neuer Link ersetzt den alten.
    const zweite = (
      await anfrage('POST', `/api/v1/mandant/konten?mandant=${mandantA}`, adminA, {
        benutzername: `spaet-${randomUUID().slice(0, 6)}@${domainA}`,
        rollen: ['betriebsrat'],
      })
    ).json();
    const t2 = zweite.einladung.url.split('/').pop();
    await db
      .updateTable('konto_einladung')
      .set({ laeuft_ab: new Date(Date.now() - 1000) })
      .where('token_sha256', '=', sha256(t2))
      .execute();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/einladung/pruefen',
          payload: { token: t2 },
        })
      ).statusCode,
    ).toBe(404);
    const erneut = await anfrage(
      'POST',
      `/api/v1/mandant/konten/${zweite.konto.id}/einladung?mandant=${mandantA}`,
      adminA,
      {},
    );
    expect(erneut.statusCode).toBe(201);
    const t3 = erneut.json().einladung.url.split('/').pop();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/einladung/pruefen',
          payload: { token: t3 },
        })
      ).statusCode,
    ).toBe(200);
    // Vorhandenes Konto: nur Rolle, kein Link.
    const vorhanden = await anfrage('POST', `/api/v1/mandant/konten?mandant=${mandantB}`, adminB, {
      benutzername: email,
      rollen: ['controller'],
    });
    expect(vorhanden.json().einladung).toBeNull();
  });

  it('ohne Plugin kein Kontenkontingent; aktiver Mandant ohne ?mandant=; alte ee-Pfade weg', async () => {
    const liste = (await anfrage('GET', '/api/v1/mandant/konten', adminA)).json();
    expect(liste.kontingent).toMatchObject({ max: null });
    expect(liste.kontingent.belegt).toBeGreaterThan(0);
    // Ohne ee greift kein Kontingent, auch wenn konten_max gesetzt ist.
    await db.updateTable('mandant').set({ konten_max: 0 }).where('id', '=', mandantA).execute();
    try {
      const neu = await anfrage('POST', '/api/v1/mandant/konten', adminA, {
        benutzername: `frei-${randomUUID().slice(0, 6)}@${domainA}`,
        rollen: ['controller'],
      });
      expect(neu.statusCode).toBe(201);
    } finally {
      await db
        .updateTable('mandant')
        .set({ konten_max: null })
        .where('id', '=', mandantA)
        .execute();
    }
    expect((await anfrage('GET', '/api/v1/mandant/oidc', adminA)).json()).toMatchObject({
      start_url: `/api/v1/auth/oidc/start?mandant=${slugA}`,
    });
    expect(
      (await anfrage('GET', `/api/v1/mandant/oidc?mandant=${mandantA}`, adminB)).statusCode,
    ).toBe(403);
    expect((await anfrage('GET', `/api/v1/ee/mandanten/${mandantA}/oidc`, adminA)).statusCode).toBe(
      404,
    );
  });

  it('Kontenverwaltung: letzter Admin, Selbstdeaktivierung, Deaktivieren beendet Sitzungen', async () => {
    const selbst = await anfrage(
      'PUT',
      `/api/v1/mandant/konten/${adminB.benutzerId}?mandant=${mandantB}`,
      adminB,
      { deaktiviert: true },
    );
    expect(selbst.statusCode).toBe(409);
    expect(selbst.json().code).toBe('letzter_admin');
    const entziehen = await anfrage(
      'DELETE',
      `/api/v1/mandant/konten/${adminB.benutzerId}/rollen?mandant=${mandantB}`,
      adminB,
    );
    expect(entziehen.json().code).toBe('letzter_admin');
    const ohneAdmin = await anfrage(
      'PUT',
      `/api/v1/mandant/konten/${adminB.benutzerId}?mandant=${mandantB}`,
      adminB,
      { rollen: ['controller'] },
    );
    expect(ohneAdmin.json().code).toBe('letzter_admin');

    const leser = await meldeAn(db, mandantB, 'controller');
    const aus = await anfrage(
      'PUT',
      `/api/v1/mandant/konten/${leser.benutzerId}?mandant=${mandantB}`,
      adminB,
      { deaktiviert: true },
    );
    expect(aus.statusCode).toBe(200);
    expect(aus.json().deaktiviert).not.toBeNull();
    const sitzungen = await db
      .selectFrom('benutzer_sitzung')
      .select('id')
      .where('benutzer_id', '=', leser.benutzerId)
      .execute();
    expect(sitzungen).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: leser.headers }))
        .statusCode,
    ).toBe(401);
    const wieder = await anfrage(
      'PUT',
      `/api/v1/mandant/konten/${leser.benutzerId}?mandant=${mandantB}`,
      adminB,
      { deaktiviert: false, rollen: ['controller', 'betriebsrat'] },
    );
    expect(wieder.json()).toMatchObject({ deaktiviert: null });
    expect(
      wieder
        .json()
        .rollen.map((r: { rolle: string }) => r.rolle)
        .sort(),
    ).toEqual(['betriebsrat', 'controller']);
    const liste = (
      await anfrage('GET', `/api/v1/mandant/konten?mandant=${mandantB}`, adminB)
    ).json();
    expect(liste.konten.some((k: { id: string }) => k.id === adminA.benutzerId)).toBe(false);
    const audit = await withMandant(db, mandantB, (trx) =>
      trx.selectFrom('audit').select('aktion').where('aktion', 'like', 'Konto%').execute(),
    );
    expect(audit.map((a) => a.aktion)).toEqual(
      expect.arrayContaining(['Konto deaktiviert', 'Konto aktiviert']),
    );
  });

  it('Anmeldeseite: Abfragen je Adresse begrenzt (429)', async () => {
    const eigene = await kernApp(db, url);
    try {
      let letzte = 0;
      for (let i = 0; i < 25; i++) {
        letzte = (
          await eigene.inject({ method: 'GET', url: '/api/v1/auth/anbieter?email=a@b.example.org' })
        ).statusCode;
      }
      expect(letzte).toBe(429);
      // Die einfache Liste ohne Abfrage bleibt frei.
      expect(
        (await eigene.inject({ method: 'GET', url: '/api/v1/auth/anbieter' })).statusCode,
      ).toBe(200);
    } finally {
      await eigene.close();
    }
  });
});
