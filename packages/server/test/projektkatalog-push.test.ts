// Push aus dem Quellsystem: Das Quellsystem bricht bei allem außer 200 ab. Status, Toleranz, Feldregeln, Tokens, Signal,
// Job, Zähler, verschachtelte Projekte. Nur erfundene Daten.
import { randomUUID } from 'node:crypto';
import {
  katalogEinstellungSchema,
  katalogKostenAntwortSchema,
  katalogListeSchema,
  katalogPushAntwortSchema,
  katalogSyncStatusAntwortSchema,
  katalogTokenNeuSchema,
  katalogZuordnungAntwortSchema,
  projektwahlAntwortSchema,
  PROJEKTWAHL_PFAD_PRAEFIX,
  PROJEKTWAHL_PRUEF_PFAD,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { imJobLauf } from '../src/jobs/index.js';
import { katalogSperren, syncBewerten, syncJob, syncPuffer } from '../src/projektkatalog/index.js';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import {
  kernApp,
  legePersonAn,
  legeProjektAn,
  MASTER_KEY_B64,
  meldeAn,
  testKonfiguration,
} from './api-hilfen.js';
import { tagAggregat } from './modul-hilfen.js';

const MASTER = Buffer.from(MASTER_KEY_B64, 'base64');
const PFAD = '/api/v1/projektkatalog/projekte';
const STATUS = '/api/v1/projektkatalog/sync-status';
const MONAT = new Date().toISOString().slice(0, 7);
const TAG = `${MONAT}-15`;

let db: Db;
let app: FastifyInstance;

interface Umgebung {
  mandantId: string;
  slug: string;
  ingestToken: string;
  admin: Record<string, string>;
  token: string;
  tokenId: string;
}

async function tokenAnlegen(admin: Record<string, string>, scope = 'katalog_api') {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/projektkatalog/tokens',
    headers: admin,
    payload: { bezeichnung: 'Lauf', scope },
  });
  expect(r.statusCode).toBe(201);
  return katalogTokenNeuSchema.parse(r.json());
}

async function umgebung(): Promise<Umgebung> {
  const slug = `t-${randomUUID()}`;
  const e = await mandantAnlegen(db, MASTER, { slug, name: 'Testmandant', orgs: [] });
  if (!e.token) throw new Error('Token fehlt');
  const { headers: admin } = await meldeAn(db, e.mandantId, 'mandanten_admin');
  const t = await tokenAnlegen(admin);
  return {
    mandantId: e.mandantId,
    slug,
    ingestToken: e.token,
    admin,
    token: t.token,
    tokenId: t.id,
  };
}

function put(
  token: string | null,
  id: string,
  koerper: unknown,
  kopf: Record<string, string> = {},
  a = app,
) {
  return a.inject({
    method: 'PUT',
    url: `${PFAD}/${id}`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...kopf,
    },
    payload:
      typeof koerper === 'string' || Buffer.isBuffer(koerper) ? koerper : JSON.stringify(koerper),
  });
}

async function ok(u: Umgebung, id: string, koerper: unknown) {
  const r = await put(u.token, id, koerper);
  expect(r.statusCode, r.body).toBe(200);
  return katalogPushAntwortSchema.parse(r.json());
}

const zeile = (u: Umgebung, id: string) =>
  withMandant(db, u.mandantId, (t) =>
    t
      .selectFrom('katalog_projekt')
      .selectAll()
      .where('externe_id', '=', id)
      .executeTakeFirstOrThrow(),
  );

async function liste(u: Umgebung, aktiv: '0' | '1' = '0') {
  const r = await app.inject({ url: `${PFAD}?aktiv=${aktiv}`, headers: u.admin });
  expect(r.statusCode).toBe(200);
  return katalogListeSchema.parse(r.json()).projekte;
}

async function einstellung(u: Umgebung) {
  const r = await app.inject({ url: '/api/v1/projektkatalog/einstellung', headers: u.admin });
  return katalogEinstellungSchema.parse(r.json());
}

function setzen(u: Umgebung, payload: unknown) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/projektkatalog/einstellung',
    headers: u.admin,
    payload: payload as object,
  });
}

const audit = (u: Umgebung) =>
  withMandant(db, u.mandantId, (t) =>
    t.selectFrom('audit').select(['aktion', 'objekt', 'benutzer_id']).execute(),
  );

const jobKontext = () => ({
  db,
  konfiguration: testKonfiguration(inject('testDatenbankUrl'), {
    SEATMETER_PUBLIC_URL: 'http://seatmeter.test',
  }),
});

beforeAll(async () => {
  const url = inject('testDatenbankUrl');
  db = erstelleDb(url, 8);
  app = await kernApp(db, url);
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

describe('Antworten: immer genau 200, außer bei echten Fehlern', () => {
  it('anlegen, wiederholen, ändern: 200 mit Ergebnis, nie 201 oder 204', async () => {
    const u = await umgebung();
    expect(await ok(u, 'x-1', { name: 'Webshop' })).toEqual({
      externalId: 'x-1',
      ergebnis: 'neu',
      active: true,
    });
    expect((await ok(u, 'x-1', { name: 'Webshop' })).ergebnis).toBe('unveraendert');
    expect((await ok(u, 'x-1', { name: 'Webshop neu' })).ergebnis).toBe('aktualisiert');
    expect((await zeile(u, 'x-1')).quelle).toBe('api');
  });

  it('Schrägstrich am Ende und kodierte IDs: 200, keine Weiterleitung', async () => {
    const u = await umgebung();
    const schraeg = await put(u.token, 'x-2/', { name: 'Mit Strich' });
    expect(schraeg.statusCode).toBe(200);
    expect(schraeg.json<{ externalId: string }>().externalId).toBe('x-2');
    for (const [kodiert, id] of [
      ['P%2F100', 'P/100'],
      ['A%20B', 'A B'],
      ['Stra%C3%9Fe', 'Straße'],
      ['a%3Fb%23c', 'a?b#c'],
      ['1.2.3', '1.2.3'],
    ] as const) {
      const r = await put(u.token, kodiert, { name: 'Kodiert' });
      expect(r.statusCode, kodiert).toBe(200);
      expect(r.json<{ externalId: string }>().externalId, kodiert).toBe(id);
      expect((await put(u.token, `${kodiert}/`, { name: 'Kodiert' })).statusCode, kodiert).toBe(
        200,
      );
    }
    expect((await zeile(u, 'P/100')).name).toBe('Kodiert');
    const lang = 'x'.repeat(150);
    expect((await put(u.token, lang, { name: 'Lang' })).statusCode).toBe(200);
  });

  it('tolerant: unbekannte Felder, charset, Zahlen, Schreibweisen von active, leere Texte', async () => {
    const u = await umgebung();
    const r = await put(
      u.token,
      'x-3',
      {
        name: 'T',
        number: 4711,
        parentId: 12,
        customer: '',
        foo: { bar: [1] },
        externalId: 'anders',
      },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    expect(r.statusCode).toBe(200);
    const z = await zeile(u, 'x-3');
    expect(z).toMatchObject({ nummer: '4711', parent_externe_id: '12', kunde: null });
    for (const [wert, erwartet] of [
      [true, true],
      [false, false],
      [1, true],
      [0, false],
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
      ['ja', true],
      ['NEIN', false],
      ['on', true],
      ['OFF', false],
      ['f', false],
      ['t', true],
      ['n', false],
      ['inaktiv', false],
      ['closed', false],
    ] as const) {
      const a = await ok(u, 'x-3', { name: 'T', active: wert });
      expect(a.active, String(wert)).toBe(erwartet);
    }
    // Unbrauchbares active zählt als weggelassen.
    expect((await ok(u, 'x-3', { name: 'T', active: 'vielleicht' })).active).toBe(true);
    expect((await ok(u, 'x-3', { name: 'T', active: { a: 1 } })).active).toBe(true);
    // Anderer Content-Type und anderer Zeichensatz brechen nichts ab.
    expect(
      (await put(u.token, 'x-4', { name: 'Plain' }, { 'content-type': 'text/plain' })).statusCode,
    ).toBe(200);
    const latin = await put(u.token, 'x-5', Buffer.from('{"name":"Straße"}', 'latin1'), {
      'content-type': 'application/json; charset=ISO-8859-1',
    });
    expect(latin.statusCode).toBe(200);
    expect((await zeile(u, 'x-5')).name).toBe('Straße');
    // Steuerzeichen und Überlänge kürzen statt abbrechen.
    const lang = await put(u.token, 'x-6', { name: `${'n'.repeat(400)}\nx`, customer: 'a\tb' });
    expect(lang.statusCode).toBe(200);
    expect((await zeile(u, 'x-6')).name).toHaveLength(300);
    expect((await zeile(u, 'x-6')).kunde).toBe('a b');
  });

  it('jeder Content-Type ergibt 200, auch unlesbare; ohne Token bleibt es 401', async () => {
    const u = await umgebung();
    for (const ct of [
      'json',
      'JSON',
      'application',
      'text',
      'application/json;',
      'application/json; charset',
      'application/json; charset=',
      ' application/json',
      'application/json ; charset=utf-8',
      'application/json,text/plain',
      'APPLICATION/JSON',
      'application/json; boundary',
      'application/json; charset=utf-8; foo',
      'application/*',
      '*/*',
      'undefined',
      'null',
      'text/xml',
      'application/json;charset:utf-8',
      'Application/Json; Charset=UTF-8',
      'charset=utf-8',
      ';',
      'application/json; charset=utf-8;',
      'garbage;;;',
      '',
      'application/octet-stream',
      'application/x-www-form-urlencoded',
      'application/vnd.api+json',
    ]) {
      const r = await put(u.token, 'ct', { name: 'Müller' }, { 'content-type': ct });
      expect(r.statusCode, `Content-Type „${ct}“`).toBe(200);
      expect((await zeile(u, 'ct')).name, ct).toBe('Müller');
    }
    // Ohne gültiges Token bleibt es 401, auch bei einem unlesbaren Content-Type.
    expect((await put('smk_falsch', 'ct', { name: 'x' }, { 'content-type': ';' })).statusCode).toBe(
      401,
    );
    // Ganz ohne Content-Type.
    const ohne = await app.inject({
      method: 'PUT',
      url: `${PFAD}/ct-ohne`,
      headers: { authorization: `Bearer ${u.token}` },
      payload: Buffer.from('{"name":"Ohne"}'),
    });
    expect(ohne.statusCode).toBe(200);
  });

  it('Zeichensatz: UTF-8 streng, ohne Angabe Rückfall auf Windows-1252, BOM und UTF-16', async () => {
    const u = await umgebung();
    const roh = (s: string, kodierung: BufferEncoding) => Buffer.from(s, kodierung);
    const j = '{"name":"Müller € Straße"}';
    const cp1252 = Buffer.from([...j].map((c) => (c === '€' ? 0x80 : c.charCodeAt(0))));
    for (const [fall, koerper, ct, erwartet] of [
      ['utf8', roh(j, 'utf8'), 'application/json', 'Müller € Straße'],
      ['1252-ohne-angabe', cp1252, 'application/json', 'Müller € Straße'],
      ['1252-angegeben', cp1252, 'application/json; charset=windows-1252', 'Müller € Straße'],
      ['falscher-name', cp1252, 'application/json; charset=bogus', 'Müller € Straße'],
      [
        'latin1',
        roh('{"name":"Müller"}', 'latin1'),
        'application/json; charset=iso-8859-1',
        'Müller',
      ],
      [
        'bom',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), roh(j, 'utf8')]),
        'application/json',
        'Müller € Straße',
      ],
      [
        'utf16',
        Buffer.concat([Buffer.from([0xff, 0xfe]), roh(j, 'utf16le')]),
        'application/json; charset=utf-16',
        'Müller € Straße',
      ],
    ] as const) {
      const r = await put(u.token, `z-${fall}`, koerper, { 'content-type': ct });
      expect(r.statusCode, fall).toBe(200);
      expect((await zeile(u, `z-${fall}`)).name, fall).toBe(erwartet);
    }
  });

  it('große Körper mit unbekannten Feldern gehen durch, erst über 4 MB 413', async () => {
    const u = await umgebung();
    for (const kb of [63, 65, 500, 3000]) {
      const k = JSON.stringify({ name: 'x', beschreibung: 'y'.repeat(kb * 1024) });
      expect((await put(u.token, `g-${kb}`, k)).statusCode, `${kb} KB`).toBe(200);
    }
    const zuGross = JSON.stringify({ name: 'x', beschreibung: 'y'.repeat(4 * 1024 * 1024 + 1) });
    expect((await put(u.token, 'g-gross', zuGross)).statusCode).toBe(413);
  });

  it('echte Fehler: fehlender Name oder unbrauchbare ID 400, Körper zu groß 413', async () => {
    const u = await umgebung();
    for (const k of [
      {},
      { name: '' },
      { name: '   ' },
      { name: null },
      { name: {} },
      [],
      'kein json',
      '',
    ]) {
      expect((await put(u.token, 'x-7', k)).statusCode, JSON.stringify(k)).toBe(400);
    }
    for (const id of ['%20', '%0A', 'a%0Ab', 'x'.repeat(201)]) {
      expect((await put(u.token, id, { name: 'T' })).statusCode, id).toBe(400);
    }
    const leer = await app.inject({
      method: 'PUT',
      url: `${PFAD}/`,
      headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
      payload: '{"name":"T"}',
    });
    expect(leer.statusCode).toBe(400);
    const ohne = await app.inject({
      method: 'PUT',
      url: PFAD,
      headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
      payload: '{"name":"T"}',
    });
    expect(ohne.statusCode).toBe(400);
    expect(await liste(u)).toEqual([]);
  });

  it('kein Ratenlimit für gültige Tokens; begrenzt nur Fehlversuche, und das trifft kein gültiges Token', async () => {
    const eigene = await kernApp(db, inject('testDatenbankUrl'));
    try {
      const u = await umgebung();
      for (let i = 0; i < 40; i += 1) {
        const r = await put(`smk_${'f'.repeat(43)}`, 'x', { name: 'T' }, {}, eigene);
        expect([401, 429]).toContain(r.statusCode);
      }
      const gesperrt = await put(`smk_${'f'.repeat(43)}`, 'x', { name: 'T' }, {}, eigene);
      expect(gesperrt.statusCode).toBe(429);
      // Dieselbe Adresse, gültiges Token: läuft weiter, auch weit über jedes Limit hinaus.
      for (let i = 0; i < 120; i += 1) {
        expect((await put(u.token, `v-${i % 3}`, { name: 'T' }, {}, eigene)).statusCode).toBe(200);
      }
    } finally {
      await eigene.close();
    }
  });

  it('gleichzeitige Anfragen derselben ID: alle 200, genau ein „neu“, eine Zeile', async () => {
    const u = await umgebung();
    const alle = await Promise.all(
      Array.from({ length: 30 }, () => put(u.token, 'parallel', { name: 'P' })),
    );
    expect(alle.every((r) => r.statusCode === 200)).toBe(true);
    const ergebnisse = alle.map((r) => katalogPushAntwortSchema.parse(r.json()).ergebnis);
    expect(ergebnisse.filter((e) => e === 'neu')).toHaveLength(1);
    expect(ergebnisse.filter((e) => e === 'unveraendert')).toHaveLength(29);
    expect(await liste(u)).toHaveLength(1);
  });
});

describe('Feldregeln', () => {
  it('weggelassen behält den Wert, null und "" leeren ihn', async () => {
    const u = await umgebung();
    await ok(u, 'f', {
      name: 'N',
      number: 'P-1',
      customer: 'Muster',
      parentId: 'w',
      status: 'offen',
    });
    expect((await ok(u, 'f', { name: 'N' })).ergebnis).toBe('unveraendert');
    expect(await zeile(u, 'f')).toMatchObject({
      nummer: 'P-1',
      kunde: 'Muster',
      parent_externe_id: 'w',
      status_roh: 'offen',
    });
    expect((await ok(u, 'f', { name: 'N', customer: null, number: '' })).ergebnis).toBe(
      'aktualisiert',
    );
    expect(await zeile(u, 'f')).toMatchObject({
      nummer: null,
      kunde: null,
      parent_externe_id: 'w',
    });
    await ok(u, 'f', { name: 'N', parentId: null, status: null });
    expect(await zeile(u, 'f')).toMatchObject({ parent_externe_id: null, status_roh: null });
  });

  it('Status: unbekannt heißt aktiv und bleibt roh stehen; geschlossen macht inaktiv; active gewinnt', async () => {
    const u = await umgebung();
    expect(await ok(u, 's', { name: 'N', status: 'In Klärung' })).toMatchObject({ active: true });
    expect((await zeile(u, 's')).status_roh).toBe('In Klärung');
    expect(await ok(u, 's', { name: 'N', status: 'CLOSED' })).toMatchObject({
      active: false,
      ergebnis: 'aktualisiert',
    });
    expect((await zeile(u, 's')).status_roh).toBe('CLOSED');
    expect((await ok(u, 's', { name: 'N', status: 'Abgeschlossen' })).active).toBe(false);
    expect((await ok(u, 's', { name: 'N', status: 'closed', active: true })).active).toBe(true);
    expect((await ok(u, 's', { name: 'N', status: 'offen', active: false })).active).toBe(false);
    expect((await liste(u)).find((p) => p.externe_id === 's')?.status).toBe('offen');
  });

  it('ohne Status und active: aktiv, auch bei einem deaktivierten Projekt', async () => {
    const u = await umgebung();
    await ok(u, 'r', { name: 'N', active: false });
    expect((await zeile(u, 'r')).aktiv).toBe(false);
    expect(await ok(u, 'r', { name: 'N' })).toMatchObject({
      active: true,
      ergebnis: 'aktualisiert',
    });
  });

  it('nur den Kontakt zu ändern steht im Audit, ohne den Wert', async () => {
    const u = await umgebung();
    expect((await setzen(u, { kontakt: 'IT-Hotline, Tel. 123' })).statusCode).toBe(200);
    const z = (await audit(u)).filter((a) => a.aktion === 'Projektwahl-Einstellung geändert');
    expect(z.map((a) => a.objekt)).toEqual(['kontakt']);
    expect(JSON.stringify(z)).not.toContain('Hotline');
  });

  it('Liste der inaktiven Status je Mandant, Groß-/Kleinschreibung egal', async () => {
    const u = await umgebung();
    expect((await einstellung(u)).inaktiv_status).toContain('storniert');
    expect((await setzen(u, { inaktiv_status: ['Erledigt'] })).statusCode).toBe(200);
    expect((await einstellung(u)).inaktiv_status).toEqual(['erledigt']);
    expect((await ok(u, 'l', { name: 'N', status: 'ERLEDIGT' })).active).toBe(false);
    expect((await ok(u, 'l', { name: 'N', status: 'closed' })).active).toBe(true);
    expect((await setzen(u, { inaktiv_status: null })).statusCode).toBe(200);
    expect((await ok(u, 'l', { name: 'N', status: 'closed' })).active).toBe(false);
  });

  it('parentId folgt der Regel der ID im Pfad, das Kind findet sein Elternprojekt', async () => {
    const u = await umgebung();
    expect((await put(u.token, 'A%20%20B', { name: 'Eltern' })).statusCode).toBe(200);
    await ok(u, 'kind', { name: 'Kind', parentId: ' A  B ' });
    expect((await zeile(u, 'kind')).parent_externe_id).toBe('A  B');
    expect((await liste(u)).find((p) => p.externe_id === 'kind')?.pfad).toBe('Eltern › Kind');
    // Zahl wird Text, unbrauchbar gilt als weggelassen, leer leert.
    await ok(u, 'kind', { name: 'Kind', parentId: 12 });
    expect((await zeile(u, 'kind')).parent_externe_id).toBe('12');
    await ok(u, 'kind', { name: 'Kind', parentId: 'mit\nUmbruch' });
    expect((await zeile(u, 'kind')).parent_externe_id).toBe('12');
    await ok(u, 'kind', { name: 'Kind', parentId: 'x'.repeat(201) });
    expect((await zeile(u, 'kind')).parent_externe_id).toBe('12');
    await ok(u, 'kind', { name: 'Kind', parentId: '  ' });
    expect((await zeile(u, 'kind')).parent_externe_id).toBeNull();
  });

  it('jede Anfrage aktualisiert zuletzt_gesehen, auch unverändert', async () => {
    const u = await umgebung();
    await ok(u, 'g', { name: 'N' });
    await withMandant(db, u.mandantId, (t) =>
      t
        .updateTable('katalog_projekt')
        .set({ zuletzt_gesehen: new Date('2020-01-01') })
        .execute(),
    );
    expect((await ok(u, 'g', { name: 'N' })).ergebnis).toBe('unveraendert');
    expect(new Date((await zeile(u, 'g')).zuletzt_gesehen).getFullYear()).toBeGreaterThan(2020);
  });

  it('Inaktiv lässt Zuordnungen stehen; legt nie einen Eintrag „Kein Projekt“ an', async () => {
    const u = await umgebung();
    await ok(u, 'm', { name: 'N' });
    const id = (await liste(u))[0]?.id ?? '';
    const repo = await legeProjektAn(db, u.mandantId, 'firma/shop');
    const z = await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: { zuordnung: [{ projekt_id: repo, katalog_projekt_id: id }] },
    });
    expect(z.statusCode).toBe(200);
    await ok(u, 'm', { name: 'N', status: 'closed' });
    const stand = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('projekt_katalog').select('katalog_projekt_id').execute(),
    );
    expect(stand).toEqual([{ katalog_projekt_id: id }]);
    expect((await liste(u)).map((p) => p.externe_id)).toEqual(['m']);
    expect((await liste(u)).some((p) => /kein projekt/i.test(p.name))).toBe(false);
  });

  it('CSV: id ist die externe ID, optionale Nummer; volle Liste deaktiviert auch Gesendetes', async () => {
    const u = await umgebung();
    await ok(u, 'gesendet', { name: 'Vom Quellsystem', number: 'Q-1' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: {
        csv: 'Schluessel;Nr;Titel;Ober\nc-1;C-1;Eins;\nc-2;;Zwei;c-1\n',
        spalten: { id: 'Schluessel', nummer: 'Nr', name: 'Titel', parent: 'Ober' },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const alle = await liste(u);
    expect(alle.find((p) => p.externe_id === 'gesendet')?.aktiv).toBe(false);
    // Ohne Nummer zeigt die Anzeige die externe ID.
    expect(alle.find((p) => p.externe_id === 'c-2')).toMatchObject({
      nummer: 'c-2',
      parent_externe_id: 'c-1',
      pfad: 'Eins › Zwei',
    });
    const teil = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import',
      headers: u.admin,
      payload: {
        vollstaendig: false,
        projekte: [{ externe_id: 'j-1', nummer: 'J-1', name: 'Json', parent: 'c-1' }],
      },
    });
    expect(teil.statusCode, teil.body).toBe(200);
    const nachher = await liste(u);
    expect(nachher.find((p) => p.externe_id === 'j-1')?.pfad).toBe('Eins › Json');
    expect(nachher.find((p) => p.externe_id === 'c-1')?.aktiv).toBe(true);
  });
});

describe('Token', () => {
  it('Zweck: katalog_api nur hier und am Status, csv_import nur am Upload; Cookie gilt hier nicht', async () => {
    const u = await umgebung();
    const csv = await tokenAnlegen(u.admin, 'csv_import');
    expect((await put(csv.token, 'z', { name: 'N' })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: STATUS, headers: { authorization: `Bearer ${csv.token}` } }))
        .statusCode,
    ).toBe(401);
    const upload = (t: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'text/csv' },
        payload: 'Nummer;Name\nP-1;Eins\n',
      });
    expect((await upload(u.token)).statusCode).toBe(401);
    expect((await upload(csv.token)).statusCode).toBe(200);
    // Admin-Cookie allein zählt nicht; Mandanten-Token und unbekannte Tokens auch nicht.
    const cookie = await app.inject({
      method: 'PUT',
      url: `${PFAD}/z`,
      headers: { ...u.admin, 'content-type': 'application/json' },
      payload: '{"name":"N"}',
    });
    expect(cookie.statusCode).toBe(401);
    expect((await put(u.ingestToken, 'z', { name: 'N' })).statusCode).toBe(401);
    expect((await put(null, 'z', { name: 'N' })).statusCode).toBe(401);
    // Widerrufen gilt sofort.
    const wider = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projektkatalog/tokens/${u.tokenId}`,
      headers: u.admin,
    });
    expect(wider.statusCode).toBe(204);
    expect((await put(u.token, 'z', { name: 'N' })).statusCode).toBe(401);
    expect((await liste(u)).map((p) => p.externe_id)).toEqual(['P-1']);
  });

  it('sync_status liest nur den Status; katalog_api bleibt dort gültig, csv_import nicht', async () => {
    const u = await umgebung();
    const nurLesen = await tokenAnlegen(u.admin, 'sync_status');
    const csv = await tokenAnlegen(u.admin, 'csv_import');
    const status = (t: string | null) =>
      app.inject({ url: STATUS, headers: t ? { authorization: `Bearer ${t}` } : {} });
    expect((await status(nurLesen.token)).statusCode).toBe(200);
    expect((await status(u.token)).statusCode).toBe(200);
    expect((await status(csv.token)).statusCode).toBe(401);
    expect((await status(u.ingestToken)).statusCode).toBe(401);
    expect((await status(null)).statusCode).toBe(401);
    expect((await put(nurLesen.token, 'z', { name: 'N' })).statusCode).toBe(401);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
      headers: { authorization: `Bearer ${nurLesen.token}`, 'content-type': 'text/csv' },
      payload: 'Nummer;Name\nP-1;Eins\n',
    });
    expect(upload.statusCode).toBe(401);
    expect(await liste(u)).toEqual([]);
  });

  it('wirkt nur im eigenen Mandanten', async () => {
    const a = await umgebung();
    const b = await umgebung();
    await ok(a, 'gleich', { name: 'A' });
    await ok(b, 'gleich', { name: 'B' });
    expect((await liste(a))[0]?.name).toBe('A');
    expect((await liste(b))[0]?.name).toBe('B');
    const sichtbar = await withMandant(db, a.mandantId, (t) =>
      t.selectFrom('katalog_sync_tag').select('mandant_id').execute(),
    );
    expect(sichtbar.every((z) => z.mandant_id === a.mandantId)).toBe(true);
  });

  it('das Token öffnet keine andere Route: gleiche Antwort wie ganz ohne Anmeldung', async () => {
    const u = await umgebung();
    const csv = await tokenAnlegen(u.admin, 'csv_import');
    const lesen = await tokenAnlegen(u.admin, 'sync_status');
    const eigene = await kernApp(db, inject('testDatenbankUrl'));
    try {
      const routen = routenAus(eigene.printRoutes({ commonPrefix: false }));
      expect(routen.length).toBeGreaterThan(50);
      const abweichend: string[] = [];
      for (const { method, url } of routen) {
        const anfrage = {
          method,
          url,
          headers: { 'content-type': 'application/json' },
          ...(method === 'GET' ? {} : { payload: '{}' }),
        } as const;
        const ohne = await eigene.inject(anfrage);
        for (const [token, eigeneRouten] of [
          [u.token, [`${PFAD}/`, STATUS]],
          [csv.token, ['/api/v1/projektkatalog/import/datei']],
          [lesen.token, [STATUS]],
        ] as const) {
          if (eigeneRouten.some((r) => url.startsWith(r) || url === PFAD)) continue;
          const mit = await eigene.inject({
            ...anfrage,
            headers: { ...anfrage.headers, authorization: `Bearer ${token}` },
          });
          // 429 ist die Sperre für Fehlversuche anderer Routen, also ebenfalls keine Berechtigung.
          const abgewiesen = ohne.statusCode === 401 && mit.statusCode === 429;
          if (ohne.statusCode !== mit.statusCode && !abgewiesen) {
            abweichend.push(`${method} ${url}: ${ohne.statusCode} / ${mit.statusCode}`);
          }
        }
      }
      expect(abweichend).toEqual([]);
    } finally {
      await eigene.close();
    }
  });
});

function routenAus(baum: string): { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] {
  const pfad: string[] = [];
  const ergebnis: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }[] = [];
  for (const zeile of baum.split('\n')) {
    const treffer = /^([│ ]*)[├└]── (\S*?)(?: \(([A-Z, ]+)\))?$/.exec(zeile);
    if (!treffer) continue;
    const tiefe = (treffer[1] ?? '').length / 4;
    pfad.length = tiefe;
    pfad[tiefe] = treffer[2] ?? '';
    const url = pfad.join('').replace(/:[^/]+/g, randomUUID());
    if (url.includes('*') || !url.startsWith('/')) continue;
    for (const m of (treffer[3] ?? '').split(', ')) {
      if (m === 'GET' || m === 'POST' || m === 'PUT' || m === 'DELETE') {
        ergebnis.push({ method: m, url });
      }
    }
  }
  return ergebnis;
}

const kurzWarten = () => new Promise((ok_) => setTimeout(ok_, 20));

describe('Signal und Job', () => {
  it('bewertet erst mit Token oder erster Synchronisation; aus bei null', () => {
    const jetzt = new Date('2026-06-10T12:00:00Z');
    const vor = (h: number) => new Date(jetzt.getTime() - h * 3_600_000);
    expect(syncBewerten(48, null, null, jetzt).status).toBe('nicht_bewertet');
    expect(syncBewerten(null, vor(100), null, jetzt).status).toBe('aus');
    expect(syncBewerten(48, vor(47), null, jetzt).status).toBe('ok');
    expect(syncBewerten(48, vor(49), null, jetzt).status).toBe('veraltet');
    expect(syncBewerten(48, null, vor(47), jetzt).status).toBe('ok');
    expect(syncBewerten(48, null, vor(49), jetzt).status).toBe('veraltet');
  });

  it('Status-Route: 200 frisch, 503 veraltet, 200 wenn aus; Seite zeigt Zeit und Zähler', async () => {
    const u = await umgebung();
    await ok(u, 'a', { name: 'N' });
    await ok(u, 'a', { name: 'N' });
    await ok(u, 'a', { name: 'N neu' });
    const lesen = () =>
      app.inject({ url: STATUS, headers: { authorization: `Bearer ${u.token}` } });
    const frisch = await lesen();
    expect(frisch.statusCode).toBe(200);
    expect(katalogSyncStatusAntwortSchema.parse(frisch.json()).status).toBe('ok');
    const e = await einstellung(u);
    expect(e.sync.zuletzt_sync).not.toBeNull();
    expect(e.sync.warnung_stunden).toBe(48);
    expect(e.sync.tage[0]).toMatchObject({ neu: 1, aktualisiert: 1, unveraendert: 1 });

    await withMandant(db, u.mandantId, (t) =>
      t
        .updateTable('mandant_projektkatalog')
        .set({ zuletzt_sync: new Date(Date.now() - 49 * 3_600_000) })
        .execute(),
    );
    const alt = await lesen();
    expect(alt.statusCode).toBe(503);
    expect(alt.json<{ status: string }>().status).toBe('veraltet');
    expect((await einstellung(u)).sync.status).toBe('veraltet');
    expect((await setzen(u, { sync_warnung_stunden: null })).statusCode).toBe(200);
    const aus = await lesen();
    expect(aus.statusCode).toBe(200);
    expect(aus.json<{ status: string }>().status).toBe('aus');
    expect((await setzen(u, { sync_warnung_stunden: 0 })).statusCode).toBe(400);
  });

  it('Standard ohne Einstellung: nach Token-Anlage Frist, vorher nicht bewertet', async () => {
    const slug = `t-${randomUUID()}`;
    const e = await mandantAnlegen(db, MASTER, { slug, name: 'Testmandant', orgs: [] });
    const { headers: admin } = await meldeAn(db, e.mandantId, 'mandanten_admin');
    const lesen = async () =>
      katalogEinstellungSchema.parse(
        (await app.inject({ url: '/api/v1/projektkatalog/einstellung', headers: admin })).json(),
      ).sync;
    expect(await lesen()).toMatchObject({ status: 'nicht_bewertet', warnung_stunden: 48 });
    await tokenAnlegen(admin);
    expect((await lesen()).status).toBe('ok');
  });

  it('Import von Hand zählt nicht als Synchronisation, geplanter schon', async () => {
    const u = await umgebung();
    const hand = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv: 'Nummer;Name\nP-1;Eins\n', vollstaendig: false },
    });
    expect(hand.statusCode).toBe(200);
    expect((await einstellung(u)).sync.zuletzt_sync).toBeNull();
    const csv = await tokenAnlegen(u.admin, 'csv_import');
    const geplant = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
      headers: { authorization: `Bearer ${csv.token}`, 'content-type': 'text/csv' },
      payload: 'Nummer;Name\nP-1;Eins\n',
    });
    expect(geplant.statusCode).toBe(200);
    expect((await einstellung(u)).sync.zuletzt_sync).not.toBeNull();
  });

  it('Alarm einmal je Ausfall über die Kanäle, erneut nach Erholung, ohne Kanal nur auf der Seite', async () => {
    const u = await umgebung();
    await ok(u, 'a', { name: 'N' });
    const kanal = await app.inject({
      method: 'POST',
      url: '/api/v1/alarmkanal',
      headers: u.admin,
      payload: {
        typ: 'webhook',
        bezeichnung: 'Hook',
        konfig: { url: 'https://hooks.example.org/x' },
      },
    });
    expect(kanal.statusCode, kanal.body).toBeLessThan(300);
    const gesendet: { ereignis: string; schluessel: string }[] = [];
    let fehler = false;
    const zustell = {
      fetch: (_u: string, init?: RequestInit) => {
        if (fehler) return Promise.resolve(new Response('nein', { status: 500 }));
        gesendet.push(JSON.parse(String(init?.body)) as { ereignis: string; schluessel: string });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    };
    const lauf = (jetzt: Date) => syncJob(jobKontext(), { mandantId: u.mandantId, jetzt, zustell });
    const spaeter = new Date(Date.now() + 49 * 3_600_000);
    fehler = true;
    expect(await lauf(spaeter)).toMatchObject({ veraltet: 1, alarme: 0, zustellfehler: 1 });
    fehler = false;
    expect(await lauf(spaeter)).toMatchObject({ veraltet: 1, alarme: 1, zustellfehler: 0 });
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]?.ereignis).toBe('seatmeter.katalog_sync');
    expect(await lauf(new Date(spaeter.getTime() + 3_600_000))).toMatchObject({ alarme: 0 });
    expect(gesendet).toHaveLength(1);
    // Erholt: Merker weg, nächster Ausfall meldet wieder; keine Entwarnung dazwischen.
    expect(await lauf(new Date())).toMatchObject({ veraltet: 0, alarme: 0 });
    expect(gesendet).toHaveLength(1);
    expect(await lauf(spaeter)).toMatchObject({ alarme: 1 });
    expect(gesendet).toHaveLength(2);
  });

  const H = 3_600_000;
  const T = 24 * H;
  const altern = (u: Umgebung, ms: number, ids?: string[]) =>
    withMandant(db, u.mandantId, (t) => {
      let q = t.updateTable('katalog_projekt').set({ zuletzt_gesehen: new Date(Date.now() - ms) });
      if (ids) q = q.where('externe_id', 'in', ids);
      return q.execute();
    });
  const pushZeit = (u: Umgebung, ms: number) =>
    withMandant(db, u.mandantId, (t) =>
      t
        .updateTable('mandant_projektkatalog')
        .set({ zuletzt_sync: new Date(Date.now() - ms), zuletzt_push: new Date(Date.now() - ms) })
        .execute(),
    );
  const aktivIds = async (u: Umgebung) =>
    (await liste(u))
      .filter((p) => p.aktiv)
      .map((p) => p.externe_id)
      .sort();
  const lauf = (u: Umgebung, o: Parameters<typeof syncJob>[1] = {}) =>
    syncJob(jobKontext(), { mandantId: u.mandantId, ...o });

  it('stille Quelle: Nichts altert, auch wenn die Tage kürzer sind als die Warnfrist', async () => {
    for (const [tage, warnung, stillStunden] of [
      [1, 48, 30],
      [1, null, 30],
      [7, 720, 200],
      [3, 96, 80],
    ] as const) {
      const u = await umgebung();
      for (const id of ['a', 'b', 'c']) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      await setzen(u, {
        sync_deaktivieren_tage: tage,
        sync_warnung_stunden: warnung,
        sync_deaktivieren_max_prozent: 100,
      });
      await altern(u, stillStunden * H);
      await pushZeit(u, stillStunden * H);
      const e = await lauf(u);
      expect(e.deaktiviert, `${tage}/${warnung}/${stillStunden}`).toBe(0);
      expect(await aktivIds(u), `${tage}/${warnung}/${stillStunden}`).toEqual(['a', 'b', 'c']);
    }
  });

  it('Quelle länger still als die Warnfrist: zusätzlicher Riegel', async () => {
    for (const [tage, warnung, stillStunden] of [
      [2, 48, 49],
      [7, 48, 200],
    ] as const) {
      const u = await umgebung();
      await ok(u, 'a', { name: 'a' });
      await syncPuffer(db).leeren();
      await setzen(u, {
        sync_deaktivieren_tage: tage,
        sync_warnung_stunden: warnung,
        sync_deaktivieren_max_prozent: 100,
      });
      await altern(u, 30 * T);
      await pushZeit(u, stillStunden * H);
      expect(await lauf(u)).toMatchObject({ deaktiviert: 0, uebersprungen: 1 });
    }
  });

  it('Deaktivieren: Standard aus; zählt gegen den letzten Push; Zuordnungen bleiben; eine Audit-Zeile', async () => {
    const u = await umgebung();
    const ids = Array.from({ length: 10 }, (_, i) => `p-${i}`);
    for (const id of ids) await ok(u, id, { name: id });
    await syncPuffer(db).leeren();
    const id = (await liste(u)).find((p) => p.externe_id === 'p-0')?.id ?? '';
    const repo = await legeProjektAn(db, u.mandantId, 'firma/alt');
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: { zuordnung: [{ projekt_id: repo, katalog_projekt_id: id }] },
    });
    await altern(u, 10 * T, ['p-0']);
    // Standard: aus.
    expect(await lauf(u)).toMatchObject({ deaktiviert: 0, uebersprungen: 0, gebremst: 0 });
    expect(await aktivIds(u)).toHaveLength(10);
    expect((await setzen(u, { sync_deaktivieren_tage: 7 })).statusCode).toBe(200);
    expect(await lauf(u)).toMatchObject({ deaktiviert: 1, gebremst: 0 });
    expect(await aktivIds(u)).not.toContain('p-0');
    const zuordnungen = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('projekt_katalog').select('katalog_projekt_id').execute(),
    );
    expect(zuordnungen).toEqual([{ katalog_projekt_id: id }]);
    const zeilen = (await audit(u)).filter(
      (a) => a.aktion === 'Veraltete Katalog-Projekte deaktiviert',
    );
    expect(zeilen.map((a) => a.objekt)).toEqual(['anzahl:1 tage:7']);
    // Die nächste Anfrage holt es zurück.
    expect(await ok(u, 'p-0', { name: 'p-0' })).toMatchObject({ active: true });
  });

  it('abgebrochener Lauf: Bremse hält an, Alarm einmal, abgelehnte Anfragen sichtbar, Status bleibt 200', async () => {
    const u = await umgebung();
    for (const id of ['a', 'b', 'c', 'd']) await ok(u, id, { name: id });
    await syncPuffer(db).leeren();
    const kanal = await app.inject({
      method: 'POST',
      url: '/api/v1/alarmkanal',
      headers: u.admin,
      payload: { typ: 'webhook', bezeichnung: 'H', konfig: { url: 'https://hooks.example.org/x' } },
    });
    expect(kanal.statusCode).toBeLessThan(300);
    const gesendet: { ereignis: string }[] = [];
    const zustell = {
      fetch: (_u: string, init?: RequestInit) => {
        gesendet.push(JSON.parse(String(init?.body)) as { ereignis: string });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    };
    await setzen(u, { sync_deaktivieren_tage: 7 });
    await altern(u, 8 * T);
    // Der Lauf bricht nach einer Anfrage ab: eine gültige, eine abgelehnt.
    await ok(u, 'a', { name: 'a' });
    expect((await put(u.token, 'b', { name: '' })).statusCode).toBe(400);
    expect(await lauf(u, { zustell })).toMatchObject({ gebremst: 1, deaktiviert: 0, alarme: 1 });
    expect(await aktivIds(u)).toEqual(['a', 'b', 'c', 'd']);
    expect(gesendet.map((g) => g.ereignis)).toEqual(['seatmeter.katalog_bremse']);
    expect(await lauf(u, { zustell })).toMatchObject({ gebremst: 1, alarme: 0 });
    expect(gesendet).toHaveLength(1);
    expect(
      (await audit(u)).filter((a) => a.aktion.startsWith('Deaktivieren')).map((a) => a.objekt),
    ).toEqual(['anzahl:3 aktiv:4 grenze:25%']);
    const e = await einstellung(u);
    expect(e.sync).toMatchObject({ bremse_aktiv: true, deaktivieren_max_prozent: 25 });
    expect(e.sync.tage[0]?.abgelehnt).toBe(1);
    const st = await app.inject({ url: STATUS, headers: { authorization: `Bearer ${u.token}` } });
    expect(st.statusCode).toBe(200);
    expect(katalogSyncStatusAntwortSchema.parse(st.json())).toMatchObject({
      status: 'ok',
      abgelehnt_heute: 1,
      abgelehnt_7_tage: 1,
    });
    // Mehr Anteil erlaubt: Der Lauf deaktiviert, die Bremse ist wieder weg.
    expect((await setzen(u, { sync_deaktivieren_max_prozent: 100 })).statusCode).toBe(200);
    expect(await lauf(u, { zustell })).toMatchObject({ gebremst: 0, deaktiviert: 3 });
    expect((await einstellung(u)).sync.bremse_aktiv).toBe(false);
    expect((await setzen(u, { sync_deaktivieren_max_prozent: 0 })).statusCode).toBe(400);
  });

  it('nur gesendete Projekte altern; CSV-Zeilen nicht, und eine Teilliste ist kein Lebenszeichen', async () => {
    const u = await umgebung();
    const csv = await tokenAnlegen(u.admin, 'csv_import');
    const upload = (zeilen: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
        headers: { authorization: `Bearer ${csv.token}`, 'content-type': 'text/csv' },
        payload: `ID;Name\n${zeilen}\n`,
      });
    expect((await upload('c-1;Nur CSV')).statusCode).toBe(200);
    for (let i = 0; i < 8; i += 1) await ok(u, `p-${i}`, { name: 'P' });
    await syncPuffer(db).leeren();
    await setzen(u, { sync_deaktivieren_tage: 7 });
    await altern(u, 8 * T, ['c-1', 'p-0']);
    expect(await lauf(u)).toMatchObject({ deaktiviert: 1 });
    const stand = await aktivIds(u);
    expect(stand).toContain('c-1');
    expect(stand).not.toContain('p-0');

    // Quelle nur per CSV-Teilliste: zuletzt_sync frisch, aber nichts gilt als gesendet, also kein Altern.
    const v = await umgebung();
    const vCsv = await tokenAnlegen(v.admin, 'csv_import');
    await ok(v, 'alt', { name: 'Alt' });
    await syncPuffer(db).leeren();
    await setzen(v, { sync_deaktivieren_tage: 7 });
    await altern(v, 30 * T);
    await pushZeit(v, 30 * T);
    const teil = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
      headers: { authorization: `Bearer ${vCsv.token}`, 'content-type': 'text/csv' },
      payload: 'ID;Name\nneu;Neu\n',
    });
    expect(teil.statusCode).toBe(200);
    expect((await einstellung(v)).sync.status).toBe('ok');
    expect(await lauf(v)).toMatchObject({ deaktiviert: 0, uebersprungen: 1 });
    expect(await aktivIds(v)).toContain('alt');
  });

  it('ein kaputter Mandant hält die anderen nicht auf, der Job meldet den Fehler', async () => {
    const a = await umgebung();
    const b = await umgebung();
    for (const u of [a, b]) {
      await ok(u, 'x', { name: 'x' });
      const k = await app.inject({
        method: 'POST',
        url: '/api/v1/alarmkanal',
        headers: u.admin,
        payload: {
          typ: 'webhook',
          bezeichnung: 'H',
          konfig: { url: 'https://hooks.example.org/x' },
        },
      });
      expect(k.statusCode).toBeLessThan(300);
    }
    await syncPuffer(db).leeren();
    await db
      .updateTable('alarm_kanal')
      .set({ geheimnis: Buffer.from('kaputt') })
      .where('mandant_id', '=', a.mandantId)
      .execute();
    const gesendet: string[] = [];
    const zustell = {
      fetch: (_u: string, init?: RequestInit) => {
        gesendet.push((JSON.parse(String(init?.body)) as { schluessel: string }).schluessel);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    };
    const spaeter = new Date(Date.now() + 49 * H);
    const ctx = jobKontext();
    await expect(
      syncJob(ctx, { mandantIds: [a.mandantId, b.mandantId], jetzt: spaeter, zustell }),
    ).rejects.toThrow(a.mandantId);
    expect(gesendet.filter((s) => s.includes(b.mandantId))).toHaveLength(1);
    const lauf2 = await imJobLauf(ctx, 'projektkatalog.sync', 'api', () =>
      syncJob(ctx, { mandantIds: [a.mandantId, b.mandantId], jetzt: spaeter, zustell }),
    );
    expect(lauf2.status).toBe('fehler');
    expect(lauf2.fehler).toContain(a.mandantId);
    await db.deleteFrom('alarm_kanal').where('mandant_id', '=', a.mandantId).execute();
  });

  it('der Job wartet auf einen laufenden Import desselben Mandanten', async () => {
    const u = await umgebung();
    await ok(u, 'x', { name: 'x' });
    let fertig = false;
    let job: Promise<unknown> = Promise.resolve();
    await db.transaction().execute(async (t) => {
      await katalogSperren(t, u.mandantId);
      job = lauf(u).then(() => {
        fertig = true;
      });
      await new Promise((ok_) => setTimeout(ok_, 300));
      expect(fertig).toBe(false);
    });
    await job;
    expect(fertig).toBe(true);
  });

  it('Puffer: Zähler eines gelöschten Mandanten verfallen, andere werden geschrieben', async () => {
    const u = await umgebung();
    const v = await umgebung();
    await ok(u, 'a', { name: 'a' });
    await ok(v, 'b', { name: 'b' });
    await db.deleteFrom('mandant').where('id', '=', u.mandantId).execute();
    const p = syncPuffer(db) as unknown as {
      leeren(): Promise<void>;
      zaehler: Map<string, unknown>;
      zuletzt: Map<string, unknown>;
    };
    await p.leeren();
    expect([...p.zaehler.keys()].filter((k) => k.startsWith(u.mandantId))).toEqual([]);
    expect(p.zuletzt.has(u.mandantId)).toBe(false);
    expect((await einstellung(v)).sync.zuletzt_sync).not.toBeNull();
  });

  it('Alarm-Schlüssel enthält den Beginn des Ausfalls: zwei Ausfälle, zwei Vorfälle', async () => {
    const u = await umgebung();
    const k = await app.inject({
      method: 'POST',
      url: '/api/v1/alarmkanal',
      headers: u.admin,
      payload: { typ: 'webhook', bezeichnung: 'H', konfig: { url: 'https://hooks.example.org/x' } },
    });
    expect(k.statusCode).toBeLessThan(300);
    await ok(u, 'a', { name: 'a' });
    await syncPuffer(db).leeren();
    const g: string[] = [];
    const zustell = {
      fetch: (_u: string, init?: RequestInit) => {
        g.push((JSON.parse(String(init?.body)) as { schluessel: string }).schluessel);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    };
    const spaeter = new Date(Date.now() + 49 * H);
    await lauf(u, { jetzt: spaeter, zustell });
    await kurzWarten();
    await ok(u, 'a', { name: 'a' });
    await syncPuffer(db).leeren();
    await lauf(u, { zustell });
    await lauf(u, { jetzt: new Date(spaeter.getTime() + 2 * H), zustell });
    expect(g).toHaveLength(2);
    expect(new Set(g).size).toBe(2);
    expect(g[0]).toContain(`seatmeter|katalog-sync|${u.mandantId}|`);
  });

  it('kein Audit je Anfrage; je Tag und Token eine Zeile ohne Token; läuft als Job mit job_lauf', async () => {
    const u = await umgebung();
    for (let i = 0; i < 5; i += 1) await ok(u, `a-${i % 2}`, { name: 'N' });
    await syncPuffer(db).leeren();
    expect((await audit(u)).filter((a) => a.aktion === 'Katalog-API genutzt')).toEqual([]);
    const ctx = jobKontext();
    const morgen = new Date(Date.now() + 86_400_000);
    const lauf = await imJobLauf(ctx, 'projektkatalog.sync', 'api', () =>
      syncJob(ctx, { mandantId: u.mandantId, jetzt: morgen }),
    );
    expect(lauf.status).toBe('ok');
    const zeilen = (await audit(u)).filter((a) => a.aktion === 'Katalog-API genutzt');
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]?.benutzer_id).toBeNull();
    expect(zeilen[0]?.objekt).toContain('neu:2');
    expect(zeilen[0]?.objekt).toContain('unveraendert:3');
    expect(zeilen[0]?.objekt).not.toContain(u.token);
    // Ein zweiter Lauf schreibt nichts doppelt.
    await syncJob(ctx, { mandantId: u.mandantId, jetzt: morgen });
    expect((await audit(u)).filter((a) => a.aktion === 'Katalog-API genutzt')).toHaveLength(1);
    const protokoll = await sql<{ n: string }>`
      SELECT count(*) AS n FROM job_lauf WHERE job = 'projektkatalog.sync'`.execute(db);
    expect(Number(protokoll.rows[0]?.n)).toBeGreaterThan(0);
    // Letzte Nutzung des Tokens steht, ohne dass jede Anfrage in die Zeile schreibt.
    const t = await withMandant(db, u.mandantId, (x) =>
      x
        .selectFrom('katalog_import_token')
        .select('zuletzt_genutzt')
        .where('id', '=', u.tokenId)
        .executeTakeFirstOrThrow(),
    );
    expect(t.zuletzt_genutzt).not.toBeNull();
  });
});

describe('Verschachtelte Projekte', () => {
  async function baumAnlegen(u: Umgebung) {
    // Kind vor Elternprojekt: Die Reihenfolge der Anfragen zählt nicht.
    await ok(u, 'w-1-1', { name: 'Passwort', parentId: 'w-1', number: 'W.1.1' });
    await ok(u, 'w-1', { name: 'AP Login', parentId: 'w', number: 'W.1' });
    await ok(u, 'w', { name: 'Webshop', number: 'W', customer: 'Muster AG' });
    await ok(u, 'a', { name: 'Archiv', number: 'A', status: 'archived' });
    await ok(u, 'a-1', { name: 'Nachlauf', number: 'A.1', parentId: 'a' });
    await ok(u, 'a-2', { name: 'Alt', number: 'A.2', parentId: 'a', status: 'closed' });
    await ok(u, 'b', { name: 'Tot', number: 'B', status: 'closed' });
    await ok(u, 'waise', { name: 'Waise', number: 'C', parentId: 'gibt-es-nicht' });
    await ok(u, 'selbst', { name: 'Selbst', number: 'D', parentId: 'selbst' });
    await ok(u, 'z1', { name: 'Z1', number: 'E1', parentId: 'z2' });
    await ok(u, 'z2', { name: 'Z2', number: 'E2', parentId: 'z1' });
  }

  it('Listen der Auswahl: Baumreihenfolge, Pfad, inaktive Vorfahren nur als Kontext', async () => {
    const u = await umgebung();
    await baumAnlegen(u);
    const aktive = await liste(u, '1');
    expect(aktive.map((p) => [p.externe_id, p.aktiv, p.pfad])).toEqual([
      ['a', false, 'Archiv'],
      ['a-1', true, 'Archiv › Nachlauf'],
      ['waise', true, 'Waise'],
      ['selbst', true, 'Selbst'],
      ['z1', true, 'Z1'],
      ['z2', true, 'Z2'],
      ['w', true, 'Webshop'],
      ['w-1', true, 'Webshop › AP Login'],
      ['w-1-1', true, 'Webshop › AP Login › Passwort'],
    ]);
    // Inaktiv ohne aktive Nachkommen steht in der Auswahl nicht, in der Übersicht schon.
    expect(aktive.map((p) => p.externe_id)).not.toContain('b');
    expect((await liste(u, '0')).map((p) => p.externe_id)).toEqual(
      expect.arrayContaining(['b', 'a-2']),
    );
  });

  it('Auswahlseite: jede Ebene wählbar, inaktiver Vorfahre nicht; Bestätigung mit Pfad', async () => {
    const u = await umgebung();
    await baumAnlegen(u);
    const stufe = await setzen(u, { stufe: 'blockieren' });
    expect(stufe.statusCode).toBe(200);
    const pruefen = (sitzung: string, repo: string) =>
      app.inject({
        method: 'POST',
        url: PROJEKTWAHL_PRUEF_PFAD,
        headers: {
          authorization: `Bearer ${u.ingestToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ sitzung, repo }).toString(),
      });
    const tokenVon = (t: string) =>
      t.trim().slice(t.indexOf(PROJEKTWAHL_PFAD_PRAEFIX) + PROJEKTWAHL_PFAD_PRAEFIX.length);
    const token = tokenVon((await pruefen('s1', 'https://git.example.org/o/a.git')).body);
    const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
    const seite = projektwahlAntwortSchema.parse(
      (
        await app.inject({ url: `/api/v1/projektwahl?token=${token}`, headers: entwickler.headers })
      ).json(),
    );
    const je = new Map(seite.projekte.map((p) => [p.externe_id, p]));
    expect(je.get('w-1')?.pfad).toBe('Webshop › AP Login');
    expect(je.get('a')?.aktiv).toBe(false);
    const waehlen = (t: string, id: string | undefined) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token: t, katalog_projekt_id: id },
      });
    expect((await waehlen(token, je.get('a')?.id)).statusCode).toBe(400);
    // Ein Elternprojekt ist wählbar …
    const eltern = await waehlen(token, je.get('w')?.id);
    expect(eltern.statusCode).toBe(200);
    // … ein Kind ebenso, und die Bestätigung zeigt den Pfad.
    const t2 = tokenVon((await pruefen('s2', 'https://git.example.org/o/b.git')).body);
    const kind = await waehlen(t2, je.get('w-1-1')?.id);
    expect(kind.json<{ zugeordnet: { pfad: string } }>().zugeordnet.pfad).toBe(
      'Webshop › AP Login › Passwort',
    );
    const z = katalogZuordnungAntwortSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: u.admin })).json(),
    );
    expect(z.zuordnung.map((x) => x.katalog?.pfad).sort()).toEqual([
      'Webshop',
      'Webshop › AP Login › Passwort',
    ]);
  });

  it('Elternprojekt deaktivieren lässt Kinder und Zuordnungen unberührt', async () => {
    const u = await umgebung();
    await baumAnlegen(u);
    const kind = (await liste(u)).find((p) => p.externe_id === 'w-1');
    const repo = await legeProjektAn(db, u.mandantId, 'firma/kind');
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: { zuordnung: [{ projekt_id: repo, katalog_projekt_id: kind?.id }] },
    });
    await ok(u, 'w', { name: 'Webshop', status: 'closed' });
    expect((await zeile(u, 'w')).aktiv).toBe(false);
    expect((await zeile(u, 'w-1')).aktiv).toBe(true);
    expect((await zeile(u, 'w-1-1')).aktiv).toBe(true);
    const stand = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('projekt_katalog').select('katalog_projekt_id').execute(),
    );
    expect(stand).toEqual([{ katalog_projekt_id: kind?.id }]);
    expect((await liste(u, '1')).find((p) => p.externe_id === 'w')?.aktiv).toBe(false);
  });

  it('Kosten: flach je gewähltem Projekt, Pfad als Bezeichnung, nichts doppelt, keine Zwischensummen', async () => {
    const u = await umgebung();
    await baumAnlegen(u);
    const alle = await liste(u);
    const id = (x: string) => alle.find((p) => p.externe_id === x)?.id;
    const person = await legePersonAn(db, u.mandantId);
    const r1 = await legeProjektAn(db, u.mandantId, 'firma/eltern');
    const r2 = await legeProjektAn(db, u.mandantId, 'firma/kind');
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: r1, usd: 3 },
      { tag: TAG, person, projekt: r2, usd: 2 },
    ]);
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: {
        zuordnung: [
          { projekt_id: r1, katalog_projekt_id: id('w') },
          { projekt_id: r2, katalog_projekt_id: id('w-1') },
        ],
      },
    });
    const k = katalogKostenAntwortSchema.parse(
      (
        await app.inject({ url: `/api/v1/projektkatalog/kosten?monat=${MONAT}`, headers: u.admin })
      ).json(),
    );
    expect(k.projekte.map((p) => [p.pfad, p.schatten_usd_micros])).toEqual([
      ['Webshop', 3_000_000],
      ['Webshop › AP Login', 2_000_000],
    ]);
    const csv = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}&format=csv`,
      headers: u.admin,
    });
    expect(csv.body).toContain('Webshop › AP Login');
  });

  it('Kosten-CSV nennt die externe ID, das Audit der Wahl auch', async () => {
    const u = await umgebung();
    await ok(u, 'x', { name: 'Gleich', number: 'P-1' });
    await ok(u, 'y', { name: 'Gleich', number: 'P-1' });
    const alle = await liste(u);
    const person = await legePersonAn(db, u.mandantId);
    const r1 = await legeProjektAn(db, u.mandantId, 'a');
    const r2 = await legeProjektAn(db, u.mandantId, 'b');
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: r1, usd: 3 },
      { tag: TAG, person, projekt: r2, usd: 2 },
    ]);
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: {
        zuordnung: [
          { projekt_id: r1, katalog_projekt_id: alle.find((p) => p.externe_id === 'x')?.id },
          { projekt_id: r2, katalog_projekt_id: alle.find((p) => p.externe_id === 'y')?.id },
        ],
      },
    });
    const csv = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}&format=csv`,
      headers: u.admin,
    });
    const zeilen = csv.body.trim().split(/\r?\n/);
    expect(zeilen[0]).toContain('Externe ID');
    const spalte = (zeilen[0] ?? '').split(/[;,]/).indexOf('Externe ID');
    const ids = zeilen.slice(1).map((z) => z.split(/[;,]/)[spalte]?.replace(/"/g, ''));
    expect(ids.filter(Boolean).sort()).toEqual(['x', 'y']);

    await setzen(u, { stufe: 'blockieren' });
    const pruef = await app.inject({
      method: 'POST',
      url: PROJEKTWAHL_PRUEF_PFAD,
      headers: {
        authorization: `Bearer ${u.ingestToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        sitzung: 's1',
        repo: 'https://git.example.org/o/neu.git',
      }).toString(),
    });
    const t = pruef.body.trim().split(PROJEKTWAHL_PFAD_PRAEFIX)[1];
    const wahl = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: u.admin,
      payload: { token: t, katalog_projekt_id: alle.find((p) => p.externe_id === 'y')?.id },
    });
    expect(wahl.statusCode).toBe(200);
    const objekte = (await audit(u)).filter((a) => a.aktion === 'Projekt gewählt');
    expect(objekte[0]?.objekt).toContain('katalog:y');
  });

  it('gleiche Nummer unter verschiedenen IDs bleibt in den Kosten getrennt', async () => {
    const u = await umgebung();
    await ok(u, 'x', { name: 'Erstes', number: 'P-1' });
    await ok(u, 'y', { name: 'Zweites', number: 'P-1' });
    const alle = await liste(u);
    const person = await legePersonAn(db, u.mandantId);
    const r1 = await legeProjektAn(db, u.mandantId, 'a');
    const r2 = await legeProjektAn(db, u.mandantId, 'b');
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: r1, usd: 3 },
      { tag: TAG, person, projekt: r2, usd: 2 },
    ]);
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: {
        zuordnung: [
          { projekt_id: r1, katalog_projekt_id: alle.find((p) => p.externe_id === 'x')?.id },
          { projekt_id: r2, katalog_projekt_id: alle.find((p) => p.externe_id === 'y')?.id },
        ],
      },
    });
    const k = katalogKostenAntwortSchema.parse(
      (
        await app.inject({ url: `/api/v1/projektkatalog/kosten?monat=${MONAT}`, headers: u.admin })
      ).json(),
    );
    expect(k.projekte.map((p) => p.pfad)).toEqual(['Erstes', 'Zweites']);
  });
});
