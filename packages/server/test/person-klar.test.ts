// Klarnamen (`person_klar`): Befüllung aus der Telemetrie (E-Mail), aus Anmeldung und SCIM (E-Mail und Name),
// Nachfüllen beim Einschalten, Löschen beim Ausschalten, Leser im Personenbericht. Erfundene Daten.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregiereTage } from '../src/aggregation/index.js';
import { withMandant } from '../src/db/mandant.js';
import { entschluessele } from '../src/krypto.js';
import { CLIENT_ID, CLIENT_SECRET, FakeIssuer } from './fake-issuer.js';
import { cookiesAus } from './api-hilfen.js';
import {
  adminKopf,
  fixture,
  otlpSenden,
  TEST_EMAIL,
  testMandant,
  testUmgebung,
  type TestUmgebung,
} from './ingest-hilfen.js';

describe('Klarnamen befüllen (person_klar)', () => {
  let u: TestUmgebung;
  const issuer = new FakeIssuer();

  beforeAll(async () => {
    u = await testUmgebung(undefined, { SEATMETER_PUBLIC_URL: 'http://seatmeter.test' });
    await issuer.starten();
  });
  afterAll(async () => {
    await issuer.stoppen();
    await u?.schliessen();
  });

  const key = () => u.konfiguration.SEATMETER_MASTER_KEY;
  const neueEmail = () => `person-${randomUUID().slice(0, 8)}@example.org`;
  /** Sendet das Log-Fixture mit der gewünschten E-Mail (neue Anfrage-ID je Aufruf). */
  const senden = (token: string, email: string) =>
    otlpSenden(
      u,
      'logs',
      token,
      JSON.parse(
        JSON.stringify(
          fixture('logs-api-request.json', { requestId: `req_${randomUUID()}` }),
        ).replaceAll(TEST_EMAIL, email),
      ) as Record<string, unknown>,
    );
  const einstellung = (mandantId: string, kopf: Record<string, string>, an: boolean) =>
    u.app.inject({
      method: 'PUT',
      url: '/api/v1/mandant/einstellungen',
      headers: kopf,
      payload: { klarnamen_aktiv: an, mindestgruppe: 1 },
    });
  const klarZeilen = (mandantId: string) =>
    withMandant(u.db, mandantId, (trx) =>
      trx
        .selectFrom('person_klar')
        .select(['person_id', 'email_enc', 'name_enc', sql<string>`xmin::text`.as('xmin')])
        .execute(),
    );
  const klartext = (wert: Buffer | null, aad: string) =>
    wert ? entschluessele(key(), wert, aad).toString('utf8') : null;
  const personen = (mandantId: string) =>
    withMandant(u.db, mandantId, (trx) => trx.selectFrom('person').select('id').execute());
  const audit = (mandantId: string) =>
    withMandant(u.db, mandantId, async (trx) =>
      (await trx.selectFrom('audit').select('objekt').execute()).map((z) => z.objekt),
    );

  it('aus: nichts geschrieben; Einschalten: nächste Anfrage füllt, weitere schreiben nicht mehr', async () => {
    const m = await testMandant(u);
    const kopf = await adminKopf(u, m.mandantId);
    const email = neueEmail();
    const sende = () => senden(m.token, email);
    expect((await sende()).statusCode).toBe(200);
    expect(await personen(m.mandantId)).toHaveLength(1);
    expect(await klarZeilen(m.mandantId)).toHaveLength(0);

    const an = await einstellung(m.mandantId, kopf, true);
    expect(an.statusCode).toBe(200);
    // Person war schon vor dem Einschalten bekannt, keine Konten zum Nachfüllen.
    expect(await klarZeilen(m.mandantId)).toHaveLength(0);

    expect((await sende()).statusCode).toBe(200);
    const zeilen = await klarZeilen(m.mandantId);
    expect(zeilen).toHaveLength(1);
    expect(klartext(zeilen[0]!.email_enc, 'person_klar.email_enc')).toBe(email);
    expect(zeilen[0]!.name_enc).toBeNull();

    // Weitere Anfragen: gleiche Zeile, kein Schreibzugriff (xmin unverändert).
    expect((await sende()).statusCode).toBe(200);
    expect((await sende()).statusCode).toBe(200);
    const spaeter = await klarZeilen(m.mandantId);
    expect(spaeter).toHaveLength(1);
    expect(spaeter[0]!.xmin).toBe(zeilen[0]!.xmin);
    expect(spaeter[0]!.email_enc!.equals(zeilen[0]!.email_enc!)).toBe(true);

    // Der Personenbericht zeigt die Klar-E-Mail (Ingest → Aggregation → API).
    const heute = new Date();
    const von = new Date(heute.getTime() - 86_400_000).toISOString().slice(0, 10);
    const bis = new Date(heute.getTime() + 86_400_000).toISOString().slice(0, 10);
    await aggregiereTage(u.db, m.mandantId, von, bis);
    const bericht = await u.app.inject({
      method: 'GET',
      url: `/api/v1/personen?monat=${heute.toISOString().slice(0, 7)}`,
      headers: kopf,
    });
    expect(bericht.statusCode).toBe(200);
    expect(bericht.json().personen[0].klarname).toEqual({ email: email, name: null });

    // Ausschalten löscht alle Klarnamen des Mandanten, beides im Audit ohne Namen.
    const aus = await einstellung(m.mandantId, kopf, false);
    expect(aus.statusCode).toBe(200);
    expect(await klarZeilen(m.mandantId)).toHaveLength(0);
    expect((await sende()).statusCode).toBe(200);
    expect(await klarZeilen(m.mandantId)).toHaveLength(0);
    const eintraege = (await audit(m.mandantId)).join('\n');
    expect(eintraege).toContain('mandant.klarnamen_aktiv: 0 Personen befüllt');
    expect(eintraege).toContain('mandant.klarnamen_aktiv: 1 Personen gelöscht');
    expect(eintraege).not.toContain(email);
  });

  it('Einschalten füllt sofort aus vorhandenen Konten (E-Mail), fremde Mandanten bleiben leer', async () => {
    const m = await testMandant(u);
    const fremd = await testMandant(u);
    const kopf = await adminKopf(u, m.mandantId);
    const email = neueEmail();
    expect((await senden(m.token, email)).statusCode).toBe(200);
    expect((await senden(fremd.token, email)).statusCode).toBe(200);
    // Konto mit Rolle im Mandanten, Anmeldename = E-Mail der Person .
    const konto = await u.db
      .insertInto('benutzer')
      .values({ benutzername: email, login: 'oidc' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await u.db
      .insertInto('rolle')
      .values({ mandant_id: m.mandantId, benutzer_id: konto.id, rolle: 'controller' })
      .execute();

    expect((await einstellung(m.mandantId, kopf, true)).statusCode).toBe(200);
    const zeilen = await klarZeilen(m.mandantId);
    expect(zeilen).toHaveLength(1);
    expect(klartext(zeilen[0]!.email_enc, 'person_klar.email_enc')).toBe(email);
    expect(await klarZeilen(fremd.mandantId)).toHaveLength(0);
    expect((await audit(m.mandantId)).join('\n')).toContain(
      'mandant.klarnamen_aktiv: 1 Personen befüllt',
    );
  });

  it('OIDC-Anmeldung eines passenden Kontos füllt den Namen; ein Unbekannter legt keine Person an', async () => {
    const m = await testMandant(u);
    const kopf = await adminKopf(u, m.mandantId);
    const email = neueEmail();
    const slug = `klar-${randomUUID().slice(0, 6)}`;
    await u.db.updateTable('mandant').set({ slug }).where('id', '=', m.mandantId).execute();
    const cfg = await u.app.inject({
      method: 'PUT',
      url: `/api/v1/mandant/oidc?mandant=${m.mandantId}`,
      headers: kopf,
      payload: {
        issuer: issuer.issuer,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        bezeichnung: 'Firmen-SSO',
        gruppen_rollen: { leser: 'controller' },
      },
    });
    expect(cfg.statusCode).toBe(200);
    expect((await senden(m.token, email)).statusCode).toBe(200);
    expect((await einstellung(m.mandantId, kopf, true)).statusCode).toBe(200);
    expect((await senden(m.token, email)).statusCode).toBe(200);
    const vorher = await klarZeilen(m.mandantId);
    expect(vorher).toHaveLength(1);
    expect(vorher[0]!.name_enc).toBeNull();

    const anmelden = async (claims: Record<string, unknown>) => {
      const s = await u.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/start?mandant=${slug}`,
      });
      const ziel = new URL(String(s.headers.location));
      const code = issuer.code(ziel, claims);
      return u.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/callback?code=${code}&state=${ziel.searchParams.get('state')}`,
        headers: { cookie: cookiesAus(s) },
      });
    };
    const r = await anmelden({
      sub: randomUUID(),
      email: email.toUpperCase(),
      email_verified: true,
      name: 'Test Person',
      groups: ['leser'],
    });
    expect(r.statusCode).toBe(302);
    const nachher = await klarZeilen(m.mandantId);
    expect(nachher).toHaveLength(1);
    expect(klartext(nachher[0]!.name_enc, 'person_klar.name_enc')).toBe('Test Person');
    expect(klartext(nachher[0]!.email_enc, 'person_klar.email_enc')).toBe(email);

    const personenVorher = (await personen(m.mandantId)).length;
    const fremd = await anmelden({
      sub: randomUUID(),
      email: `unbekannt-${randomUUID().slice(0, 6)}@example.org`,
      email_verified: true,
      given_name: 'Ida',
      family_name: 'Muster',
      groups: ['leser'],
    });
    expect(fremd.statusCode).toBe(302);
    expect(await personen(m.mandantId)).toHaveLength(personenVorher);
    expect(await klarZeilen(m.mandantId)).toHaveLength(1);
    // Keine Rohwerte im Log.
    expect(u.logs()).not.toContain('Test Person');
    expect(u.logs()).not.toContain(email);
  });

  it('SCIM: Anlegen und Ändern eines passenden Benutzers füllt Name und E-Mail', async () => {
    const m = await testMandant(u);
    const kopf = await adminKopf(u, m.mandantId);
    const email = neueEmail();
    const t = await u.app.inject({
      method: 'POST',
      url: `/api/v1/mandant/scim-tokens?mandant=${m.mandantId}`,
      headers: kopf,
      payload: { bezeichnung: 'Test' },
    });
    expect(t.statusCode).toBe(201);
    const scim = (method: 'POST' | 'PATCH', pfad: string, body: unknown) =>
      u.app.inject({
        method,
        url: `/scim/v2${pfad}`,
        headers: {
          authorization: `Bearer ${t.json().token}`,
          'content-type': 'application/scim+json',
        },
        payload: JSON.stringify(body),
      });
    expect((await senden(m.token, email)).statusCode).toBe(200);
    expect((await einstellung(m.mandantId, kopf, true)).statusCode).toBe(200);
    expect((await senden(m.token, email)).statusCode).toBe(200);
    expect(await klarZeilen(m.mandantId)).toHaveLength(1);

    const r = await scim('POST', '/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: email,
      displayName: 'Test Scim',
      active: true,
    });
    expect(r.statusCode).toBe(201);
    const z = await klarZeilen(m.mandantId);
    expect(klartext(z[0]!.name_enc, 'person_klar.name_enc')).toBe('Test Scim');
    expect(klartext(z[0]!.email_enc, 'person_klar.email_enc')).toBe(email);
    const p = await scim('PATCH', `/Users/${r.json().id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'name.formatted', value: 'Test Scim Neu' }],
    });
    expect(p.statusCode).toBe(200);
    const z2 = await klarZeilen(m.mandantId);
    expect(z2).toHaveLength(1);
    expect(klartext(z2[0]!.name_enc, 'person_klar.name_enc')).toBe('Test Scim Neu');
  });
});
