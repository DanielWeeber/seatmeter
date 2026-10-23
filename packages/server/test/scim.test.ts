// SCIM 2.0 je Mandant (Kern, bis 2026-10-24 ee): Anfragefolgen wie Entra ID und Okta (Fixtures unter
// test/fixtures/scim/), Gruppen → Rollen über die Zuordnung des Mandanten, Deaktivierung sperrt und beendet
// Sitzungen, Token-Widerruf, RLS zwischen zwei Mandanten, Filter-Parser; ohne Plugin und ohne Lizenz. Das
// Kontenkontingent (409 mit scimType) prüft ee/server/test/plattform-verwaltung.test.ts.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { erstelleDb, sha256, withMandant, zufallsToken, type Db } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { filterLesen, passt, pfadLesen, ScimFilterFehler } from '../src/scim/filter.js';
import { kernApp, legeMandantAn, meldeAn } from './api-hilfen.js';

type Sitzung = Awaited<ReturnType<typeof meldeAn>>;

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/scim/${name}.json`, import.meta.url), 'utf8'));
const ENTRA = fixture('entra-id');
const OKTA = fixture('okta');
const mit = (wert: unknown, ersatz: Record<string, string>) =>
  JSON.parse(
    Object.entries(ersatz).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), JSON.stringify(wert)),
  ) as Record<string, unknown>;

describe('SCIM 2.0 je Mandant', () => {
  let db: Db;
  let url: string;
  let app: FastifyInstance;
  let mandantA: string;
  let mandantB: string;
  let adminA: Sitzung;
  let adminB: Sitzung;
  let tokenA = '';
  let tokenB = '';

  beforeAll(async () => {
    url = inject('modulDatenbankUrl');
    db = erstelleDb(url, 4);
    mandantA = await legeMandantAn(db);
    mandantB = await legeMandantAn(db);
    adminA = await meldeAn(db, mandantA, 'mandanten_admin');
    adminB = await meldeAn(db, mandantB, 'mandanten_admin');
    app = await kernApp(db, url);
    const zuordnung = {
      'seatmeter-admins': 'mandanten_admin',
      'seatmeter-leser': ['controller'],
      'seatmeter-betriebsrat': ['betriebsrat'],
    };
    for (const [m, s] of [
      [mandantA, adminA],
      [mandantB, adminB],
    ] as const) {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/v1/mandant/oidc?mandant=${m}`,
        headers: s.headers,
        payload: {
          issuer: 'https://idp.example.org',
          client_id: 'seatmeter',
          client_secret: 'nur-test',
          bezeichnung: 'Firmen-SSO',
          gruppen_rollen: zuordnung,
        },
      });
      expect(r.statusCode).toBe(200);
    }
    const ta = await app.inject({
      method: 'POST',
      url: `/api/v1/mandant/scim-tokens?mandant=${mandantA}`,
      headers: adminA.headers,
      payload: { bezeichnung: 'Entra ID' },
    });
    expect(ta.statusCode).toBe(201);
    tokenA = ta.json().token;
    tokenB = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/mandant/scim-tokens?mandant=${mandantB}`,
        headers: adminB.headers,
        payload: {},
      })
    ).json().token;
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const scim = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    pfad: string,
    token: string,
    body?: unknown,
  ) =>
    app.inject({
      method,
      url: pfad,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  const rollen = (m: string, benutzerId: string) =>
    withMandant(db, m, (trx) =>
      trx
        .selectFrom('rolle')
        .select(['rolle', 'quelle'])
        .where('benutzer_id', '=', benutzerId)
        .orderBy('rolle')
        .execute(),
    );

  it('Discovery-Endpunkte im SCIM-Format; ohne oder mit falschem Token 401', async () => {
    const spc = await scim('GET', '/scim/v2/ServiceProviderConfig', tokenA);
    expect(spc.statusCode).toBe(200);
    expect(spc.headers['content-type']).toContain('application/scim+json');
    expect(spc.json()).toMatchObject({ patch: { supported: true }, filter: { supported: true } });
    expect((await scim('GET', '/scim/v2/ResourceTypes', tokenA)).json().totalResults).toBe(2);
    expect((await scim('GET', '/scim/v2/Schemas', tokenA)).json().Resources[0].id).toBe(
      'urn:ietf:params:scim:schemas:core:2.0:User',
    );
    const ohne = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
    expect(ohne.statusCode).toBe(401);
    expect(ohne.json()).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
    });
    expect((await scim('GET', '/scim/v2/Users', `sms_${zufallsToken(32)}`)).statusCode).toBe(401);
  });

  it('Entra ID: Suchen, Anlegen, Filter, Attribute, Gruppe, active "False"/"True", Mitglied weg, Löschen', async () => {
    expect((await scim('GET', String(ENTRA.user_suchen), tokenA)).json()).toMatchObject({
      totalResults: 0,
      Resources: [],
    });
    const angelegt = await scim('POST', '/scim/v2/Users', tokenA, ENTRA.user_anlegen);
    expect(angelegt.statusCode).toBe(201);
    const user = angelegt.json();
    expect(user).toMatchObject({
      userName: 'alex.muster@kunde.example.org',
      externalId: '0b3f5c1e-1f2a-4c8e-9d3b-7a1e2f4c5d6e',
      active: true,
      meta: { resourceType: 'User', location: `http://seatmeter.test/scim/v2/Users/${user.id}` },
    });
    expect(angelegt.headers.location).toBe(user.meta.location);
    // Namen und Abteilung speichert seatmeter nicht.
    expect(JSON.stringify(user)).not.toContain('Muster"');
    expect(JSON.stringify(user)).not.toContain('Entwicklung');
    const doppelt = await scim('POST', '/scim/v2/Users', tokenA, ENTRA.user_anlegen);
    expect(doppelt.statusCode).toBe(409);
    expect(doppelt.json().scimType).toBe('uniqueness');

    const perExtern = await scim(
      'GET',
      `/scim/v2/Users?filter=${encodeURIComponent('externalId eq "0b3f5c1e-1f2a-4c8e-9d3b-7a1e2f4c5d6e"')}`,
      tokenA,
    );
    expect(perExtern.json().totalResults).toBe(1);
    const perName = await scim('GET', String(ENTRA.user_suchen), tokenA);
    expect(perName.json().Resources[0].id).toBe(user.id);
    const attribute = await scim(
      'PATCH',
      `/scim/v2/Users/${user.id}`,
      tokenA,
      ENTRA.user_attribute,
    );
    expect(attribute.statusCode).toBe(200);

    const gruppe = await scim('POST', '/scim/v2/Groups', tokenA, ENTRA.gruppe_anlegen);
    expect(gruppe.statusCode).toBe(201);
    const gid = gruppe.json().id;
    const gesucht = await scim('GET', String(ENTRA.gruppe_suchen), tokenA);
    expect(gesucht.json().totalResults).toBe(1);
    expect(gesucht.json().Resources[0].members).toBeUndefined();
    const hinzu = await scim(
      'PATCH',
      `/scim/v2/Groups/${gid}`,
      tokenA,
      mit(ENTRA.gruppe_mitglied_hinzu, { userId: user.id }),
    );
    expect(hinzu.statusCode).toBe(204);
    expect(await rollen(mandantA, user.id)).toEqual([{ rolle: 'mandanten_admin', quelle: 'scim' }]);
    const mitGruppe = (await scim('GET', `/scim/v2/Users/${user.id}`, tokenA)).json();
    expect(mitGruppe.groups).toEqual([
      expect.objectContaining({ value: gid, display: 'seatmeter-admins' }),
    ]);
    const mitglieder = await scim(
      'GET',
      `/scim/v2/Groups?filter=${encodeURIComponent(`id eq "${gid}" and members[value eq "${user.id}"]`)}`,
      tokenA,
    );
    expect(mitglieder.json().totalResults).toBe(1);

    // Sitzung des Kontos, dann Deaktivierung per PATCH mit Zeichenkette "False".
    await db
      .insertInto('benutzer_sitzung')
      .values({
        token_sha256: sha256(zufallsToken()),
        benutzer_id: user.id,
        mandant_id: mandantA,
        csrf: zufallsToken(24),
        laeuft_ab: new Date(Date.now() + 3600_000),
      })
      .execute();
    const aus = await scim('PATCH', `/scim/v2/Users/${user.id}`, tokenA, ENTRA.user_deaktivieren);
    expect(aus.json().active).toBe(false);
    const konto = await db
      .selectFrom('benutzer')
      .select('deaktiviert')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(konto.deaktiviert).not.toBeNull();
    expect(
      await db
        .selectFrom('benutzer_sitzung')
        .select('id')
        .where('benutzer_id', '=', user.id)
        .execute(),
    ).toEqual([]);
    const an = await scim('PATCH', `/scim/v2/Users/${user.id}`, tokenA, ENTRA.user_aktivieren);
    expect(an.json().active).toBe(true);
    expect(await rollen(mandantA, user.id)).toEqual([{ rolle: 'mandanten_admin', quelle: 'scim' }]);

    const weg = await scim(
      'PATCH',
      `/scim/v2/Groups/${gid}`,
      tokenA,
      mit(ENTRA.gruppe_mitglied_weg, { userId: user.id }),
    );
    expect(weg.statusCode).toBe(204);
    expect(await rollen(mandantA, user.id)).toEqual([]);

    expect((await scim('DELETE', `/scim/v2/Users/${user.id}`, tokenA)).statusCode).toBe(204);
    expect((await scim('GET', `/scim/v2/Users/${user.id}`, tokenA)).statusCode).toBe(404);
    expect(
      (
        await db
          .selectFrom('benutzer')
          .select('deaktiviert')
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow()
      ).deaktiviert,
    ).not.toBeNull();
  });

  it('Okta: Anlegen, PUT, Gruppen-Push mit Mitgliedern, Umbenennen, PATCH replace active, Mitglied per Pfadfilter', async () => {
    const angelegt = await scim('POST', '/scim/v2/Users', tokenB, OKTA.user_anlegen);
    expect(angelegt.statusCode).toBe(201);
    const uid = angelegt.json().id;
    expect(JSON.stringify(angelegt.json())).not.toContain('nur-ein-test');
    const put = await scim(
      'PUT',
      `/scim/v2/Users/${uid}`,
      tokenB,
      mit(OKTA.user_ersetzen, { userId: uid }),
    );
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ userName: 'kim.beispiel@kunde.example.org', active: true });

    const gruppe = await scim(
      'POST',
      '/scim/v2/Groups',
      tokenB,
      mit(OKTA.gruppe_anlegen, { userId: uid }),
    );
    expect(gruppe.statusCode).toBe(201);
    const gid = gruppe.json().id;
    expect(gruppe.json().members).toEqual([expect.objectContaining({ value: uid })]);
    expect(await rollen(mandantB, uid)).toEqual([{ rolle: 'controller', quelle: 'scim' }]);
    const um = await scim(
      'PATCH',
      `/scim/v2/Groups/${gid}`,
      tokenB,
      mit(OKTA.gruppe_umbenennen, { gruppeId: gid }),
    );
    expect(um.statusCode).toBe(204);
    expect(await rollen(mandantB, uid)).toEqual([{ rolle: 'betriebsrat', quelle: 'scim' }]);

    const aus = await scim('PATCH', `/scim/v2/Users/${uid}`, tokenB, OKTA.user_deaktivieren);
    expect(aus.json().active).toBe(false);
    expect(await rollen(mandantB, uid)).toEqual([]);
    const weg = await scim(
      'PATCH',
      `/scim/v2/Groups/${gid}`,
      tokenB,
      mit(OKTA.gruppe_mitglied_weg, { userId: uid }),
    );
    expect(weg.statusCode).toBe(204);
    const g = (await scim('GET', `/scim/v2/Groups/${gid}`, tokenB)).json();
    expect(g.members).toEqual([]);
  });

  it('RLS: Token von B sieht und ändert keine Konten oder Gruppen von A', async () => {
    const a = await scim('POST', '/scim/v2/Users', tokenA, {
      userName: `nur-a-${randomUUID().slice(0, 6)}@kunde.example.org`,
    });
    const id = a.json().id;
    expect((await scim('GET', `/scim/v2/Users/${id}`, tokenB)).statusCode).toBe(404);
    expect(
      (await scim('PATCH', `/scim/v2/Users/${id}`, tokenB, ENTRA.user_deaktivieren)).statusCode,
    ).toBe(404);
    expect((await scim('DELETE', `/scim/v2/Users/${id}`, tokenB)).statusCode).toBe(404);
    const listeB = (await scim('GET', '/scim/v2/Users?count=200', tokenB)).json();
    expect(listeB.Resources.some((r: { id: string }) => r.id === id)).toBe(false);
    const sichtbar = await withMandant(db, mandantB, (trx) =>
      trx.selectFrom('scim_konto').select('mandant_id').execute(),
    );
    expect(sichtbar.every((z) => z.mandant_id === mandantB)).toBe(true);
  });

  it('Token-Verwaltung: Klartext einmal, Liste mit letzter Synchronisation, Widerruf → 401', async () => {
    const liste = await app.inject({
      method: 'GET',
      url: `/api/v1/mandant/scim-tokens?mandant=${mandantA}`,
      headers: adminA.headers,
    });
    const l = liste.json();
    expect(l.basis_url).toBe('http://seatmeter.test/scim/v2');
    expect(l.konten_synchronisiert).toBeGreaterThanOrEqual(1);
    expect(l.letzte_synchronisation).not.toBeNull();
    expect(JSON.stringify(l)).not.toContain(tokenA);
    expect(l.tokens[0]).toMatchObject({ praefix: tokenA.slice(0, 12), bezeichnung: 'Entra ID' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/mandant/scim-tokens?mandant=${mandantA}`,
          headers: adminB.headers,
        })
      ).statusCode,
    ).toBe(403);
    const w = await app.inject({
      method: 'DELETE',
      url: `/api/v1/mandant/scim-tokens/${l.tokens[0].id}?mandant=${mandantA}`,
      headers: adminA.headers,
    });
    expect(w.statusCode).toBe(204);
    expect((await scim('GET', '/scim/v2/Users', tokenA)).statusCode).toBe(401);
  });

  it('Filter-Parser: Vergleiche, and/or/not, Wertpfade, URN-Präfix, Fehler; PATCH-Pfade', () => {
    const r = {
      userName: 'Alex@Example.org',
      externalId: 'AbC',
      active: true,
      emails: [{ type: 'work', value: 'alex@example.org' }],
      members: [{ value: 'u1' }, { value: 'u2' }],
    };
    expect(passt(filterLesen('userName eq "alex@example.org"'), r)).toBe(true);
    expect(passt(filterLesen('externalId eq "abc"'), r)).toBe(false);
    expect(
      passt(filterLesen('urn:ietf:params:scim:schemas:core:2.0:User:userName sw "alex"'), r),
    ).toBe(true);
    expect(
      passt(filterLesen('active eq true and emails[type eq "work" and value co "example"]'), r),
    ).toBe(true);
    expect(passt(filterLesen('not (userName pr) or members[value eq "u2"]'), r)).toBe(true);
    expect(passt(filterLesen('emails.value ew ".org"'), r)).toBe(true);
    expect(() => filterLesen('userName eq')).toThrow(ScimFilterFehler);
    expect(() => filterLesen('userName gleich "x"')).toThrow(ScimFilterFehler);
    expect(() => filterLesen('(userName eq "x"')).toThrow(ScimFilterFehler);
    expect(pfadLesen('emails[type eq "work"].value')).toMatchObject({
      attr: 'emails',
      sub: 'value',
    });
    expect(pfadLesen('members[value eq "u1"]').filter).not.toBeNull();
    expect(pfadLesen('name.givenName')).toEqual({ attr: 'name', filter: null, sub: 'givenName' });
  });
});
