// Push aus dem Quellsystem: Das Quellsystem bricht bei allem außer 200 ab. Status, Toleranz, Feldregeln, Tokens, Signal,
// Job, Zähler, verschachtelte Projekte. Nur erfundene Daten.
import { randomUUID } from 'node:crypto';
import {
  KATALOG_NAME_MAX,
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
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { imJobLauf } from '../src/jobs/index.js';
import {
  fehlerArt,
  katalogSperren,
  syncBewerten,
  syncJob,
  syncPuffer,
} from '../src/projektkatalog/index.js';
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

  it('SEATMETER_RATE_* trifft Push, CSV-Upload und Status gültiger Tokens nie, auch mit sehr kleinen Werten', async () => {
    const eng = await kernApp(db, inject('testDatenbankUrl'), {
      SEATMETER_RATE_OTLP: '1/1',
      SEATMETER_RATE_AGENT: '1/1',
      SEATMETER_RATE_IP: '1/1',
      SEATMETER_RATE_FEHLVERSUCHE: '1/1',
      SEATMETER_RATE_ENROLL: '1/1',
      SEATMETER_RATE_ENROLL_FEHLVERSUCHE: '1/1',
    });
    try {
      const u = await umgebung();
      const csv = await tokenAnlegen(u.admin, 'csv_import');
      const lesen = await tokenAnlegen(u.admin, 'sync_status');
      const codes = new Set<number>();
      for (let i = 0; i < 60; i += 1) {
        codes.add((await put(u.token, `r-${i}`, { name: 'R' }, {}, eng)).statusCode);
      }
      for (const t of [u.token, lesen.token]) {
        for (let i = 0; i < 20; i += 1) {
          const r = await eng.inject({ url: STATUS, headers: { authorization: `Bearer ${t}` } });
          codes.add(r.statusCode);
        }
      }
      for (let i = 0; i < 20; i += 1) {
        const r = await eng.inject({
          method: 'POST',
          url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
          headers: { authorization: `Bearer ${csv.token}`, 'content-type': 'text/csv' },
          payload: `ID;Name\nc-${i};C\n`,
        });
        codes.add(r.statusCode);
      }
      expect([...codes]).toEqual([200]);
      // Gegenprobe: Die Werte greifen, nur eben auf den Ingest-Pfaden.
      const enroll = () =>
        eng.inject({
          method: 'POST',
          url: '/api/agent/v1/enroll',
          payload: { code: 'FALSCH', os: 'linux', agent_version: '0.1.2' },
        });
      await enroll();
      expect((await enroll()).statusCode).toBe(429);
    } finally {
      await eng.close();
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
  /** Macht Zeilen alt; die Quelle sendet dabei schon lange ohne Lücke. Ausfälle stellen die Tests mit `pushZeit` nach. */
  const altern = (u: Umgebung, ms: number, ids?: string[]) =>
    withMandant(db, u.mandantId, async (t) => {
      let q = t.updateTable('katalog_projekt').set({ zuletzt_gesehen: new Date(Date.now() - ms) });
      if (ids) q = q.where('externe_id', 'in', ids);
      await q.execute();
      await t
        .updateTable('mandant_projektkatalog')
        .set({ push_aktiv_ab: new Date(Date.now() - 400 * T) })
        .execute();
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

  describe('Unveränderte Anfragen schreiben nicht', () => {
    /** Zeilenversion: Sie ändert sich mit jeder Schreibung, auch wenn alle Werte gleich bleiben. */
    const version = async (u: Umgebung, id: string) => {
      const r = await withMandant(db, u.mandantId, (t) =>
        sql<{ v: string }>`
          SELECT xmin::text || '/' || ctid::text AS v FROM katalog_projekt
          WHERE externe_id = ${id}`.execute(t),
      );
      return r.rows[0]?.v;
    };
    const KOERPER = {
      name: 'N',
      number: 'N-1',
      customer: 'K',
      parentId: 'nie-gesendet',
      status: 'closed',
    };

    it('jünger als 24 h: keine Schreibung, 200 unverändert; Zähler und Signal laufen gebündelt weiter', async () => {
      const u = await umgebung();
      await ok(u, 'g', KOERPER);
      await syncPuffer(db).leeren();
      await altern(u, 23 * H, ['g']);
      await pushZeit(u, 10 * H);
      const vorher = await version(u, 'g');
      const auditVorher = (await audit(u)).length;
      for (let i = 0; i < 3; i += 1) {
        expect(await ok(u, 'g', KOERPER)).toMatchObject({
          ergebnis: 'unveraendert',
          active: false,
        });
      }
      await syncPuffer(db).leeren();
      expect(await version(u, 'g')).toBe(vorher);
      const e = await einstellung(u);
      expect(e.sync.status).toBe('ok');
      expect(e.sync.tage[0]).toMatchObject({ neu: 1, unveraendert: 3 });
      expect(Date.now() - new Date(e.sync.zuletzt_sync ?? 0).getTime()).toBeLessThan(H);
      const { zuletzt_push: push } = await withMandant(db, u.mandantId, (t) =>
        t.selectFrom('mandant_projektkatalog').select('zuletzt_push').executeTakeFirstOrThrow(),
      );
      expect(Date.now() - new Date(push ?? 0).getTime()).toBeLessThan(H);
      // Keine Audit-Zeile je Anfrage.
      expect(await audit(u)).toHaveLength(auditVorher);
    });

    it('älter als 24 h: schreibt nur zuletzt_gesehen, und danach wieder 24 h nichts', async () => {
      const u = await umgebung();
      await ok(u, 'g', KOERPER);
      await altern(u, 25 * H, ['g']);
      const vorher = await zeile(u, 'g');
      const v1 = await version(u, 'g');
      expect((await ok(u, 'g', KOERPER)).ergebnis).toBe('unveraendert');
      const v2 = await version(u, 'g');
      expect(v2).not.toBe(v1);
      const nachher = await zeile(u, 'g');
      expect(Date.now() - new Date(nachher.zuletzt_gesehen).getTime()).toBeLessThan(H);
      expect({ ...nachher, zuletzt_gesehen: null }).toEqual({ ...vorher, zuletzt_gesehen: null });
      expect((await ok(u, 'g', KOERPER)).ergebnis).toBe('unveraendert');
      expect(await version(u, 'g')).toBe(v2);
    });

    it('vergleicht wie der Schreibweg: weggelassen, null, active und Status', async () => {
      const u = await umgebung();
      const nochmal = async (koerper: unknown, ergebnis: string) => {
        const v = await version(u, 'f');
        expect((await ok(u, 'f', koerper)).ergebnis, JSON.stringify(koerper)).toBe(ergebnis);
        if (ergebnis === 'unveraendert') expect(await version(u, 'f')).toBe(v);
        else expect(await version(u, 'f')).not.toBe(v);
      };
      await ok(u, 'f', { name: 'N', number: 'N-1', customer: 'K', status: 'closed' });
      // Weggelassene Felder behalten den Wert; der Status bleibt geschlossen, solange er mitkommt.
      await nochmal({ name: 'N', status: 'closed' }, 'unveraendert');
      // Großschreibung des Status ist ein anderer Rohwert, aber weiter geschlossen.
      await nochmal({ name: 'N', status: 'CLOSED' }, 'aktualisiert');
      await nochmal({ name: 'N', status: 'CLOSED' }, 'unveraendert');
      // Ohne Status und active heißt aktiv, auch wenn der gespeicherte Status geschlossen sagt.
      await nochmal({ name: 'N' }, 'aktualisiert');
      await nochmal({ name: 'N' }, 'unveraendert');
      await nochmal({ name: 'N', active: true }, 'unveraendert');
      await nochmal({ name: 'N', active: false }, 'aktualisiert');
      await nochmal({ name: 'N', active: 'nein' }, 'unveraendert');
      // Leeren und Setzen sind Änderungen, ein schon leeres Feld nicht.
      await nochmal({ name: 'N', active: false, customer: null }, 'aktualisiert');
      await nochmal({ name: 'N', active: false, customer: null }, 'unveraendert');
      await nochmal({ name: 'N', active: false, customer: '' }, 'unveraendert');
      await nochmal({ name: 'N', active: false, parentId: 'x' }, 'aktualisiert');
      await nochmal({ name: 'N', active: false, parentId: 'x' }, 'unveraendert');
      await nochmal({ name: '  N ', active: false }, 'unveraendert');
      await nochmal({ name: 'M', active: false }, 'aktualisiert');
      // Eine geänderte Liste der inaktiven Status wirkt mit der nächsten Anfrage.
      await nochmal({ name: 'M', status: 'pausiert' }, 'aktualisiert');
      await nochmal({ name: 'M', status: 'pausiert' }, 'unveraendert');
      expect((await setzen(u, { inaktiv_status: ['pausiert'] })).statusCode).toBe(200);
      await nochmal({ name: 'M', status: 'pausiert' }, 'aktualisiert');
      expect((await zeile(u, 'f')).aktiv).toBe(false);
    });

    it('jedes Feld und die Liste der inaktiven Status: genau einmal aktualisiert, danach unverändert', async () => {
      const u = await umgebung();
      const k = { name: 'x', status: 'Offen', number: 'N', customer: 'K', parentId: 'p' };
      const erg = async (koerper: unknown) => {
        const r = await ok(u, 'x', koerper);
        return `${r.ergebnis}/${r.active}`;
      };
      expect(await erg(k)).toBe('neu/true');
      expect(await erg(k)).toBe('unveraendert/true');
      await setzen(u, { inaktiv_status: ['offen'] });
      expect(await erg(k)).toBe('aktualisiert/false');
      expect(await erg(k)).toBe('unveraendert/false');
      await setzen(u, { inaktiv_status: [] });
      expect(await erg(k)).toBe('aktualisiert/true');
      for (const a of [
        { number: 'N2' },
        { customer: 'K2' },
        { parentId: 'p2' },
        { status: 'S2' },
        { active: false },
        { active: true },
      ]) {
        expect(await erg({ name: 'x', ...a }), JSON.stringify(a)).toMatch(/^aktualisiert\//);
      }
      expect(await erg({ name: 'x' })).toBe('unveraendert/true');
      expect(await erg({ name: 'x', number: null })).toBe('aktualisiert/true');
      expect(await erg({ name: 'x', number: null })).toBe('unveraendert/true');
    });

    it('Kürzen mitten in einem Emoji: gleicher Wert bei jedem Lauf, also keine Schreibung', async () => {
      const u = await umgebung();
      const name = `${'a'.repeat(KATALOG_NAME_MAX - 1)}😀b`;
      expect((await ok(u, 's', { name })).ergebnis).toBe('neu');
      const v = await version(u, 's');
      expect((await ok(u, 's', { name })).ergebnis).toBe('unveraendert');
      expect((await ok(u, 's', { name })).ergebnis).toBe('unveraendert');
      expect(await version(u, 's')).toBe(v);
      expect((await zeile(u, 's')).name).toBe('a'.repeat(KATALOG_NAME_MAX - 1));
      // Passt das Emoji noch ganz hinein, bleibt es.
      const passt = `${'a'.repeat(KATALOG_NAME_MAX - 2)}😀b`;
      await ok(u, 'g', { name: passt });
      expect((await zeile(u, 'g')).name).toBe(`${'a'.repeat(KATALOG_NAME_MAX - 2)}😀`);
      // Ein einzelnes Surrogat in der Eingabe fällt weg, statt beim Speichern zum Ersetzungszeichen zu werden.
      const einzeln = '{"name":"vor\\ud83dnach"}';
      expect((await ok(u, 'e', einzeln)).ergebnis).toBe('neu');
      expect((await zeile(u, 'e')).name).toBe('vornach');
      expect((await ok(u, 'e', einzeln)).ergebnis).toBe('unveraendert');
    });

    it('CSV-Zeile: Der erste Push ist eine echte Änderung, erst danach kann sie altern', async () => {
      const u = await umgebung();
      const csv = await tokenAnlegen(u.admin, 'csv_import');
      const upload = await app.inject({
        method: 'POST',
        url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
        headers: { authorization: `Bearer ${csv.token}`, 'content-type': 'text/csv' },
        payload: 'ID;Name\nc-1;Aus CSV\n',
      });
      expect(upload.statusCode, upload.body).toBe(200);
      expect((await zeile(u, 'c-1')).quelle).toBe('csv');
      expect((await ok(u, 'c-1', { name: 'Aus CSV' })).ergebnis).toBe('aktualisiert');
      expect((await zeile(u, 'c-1')).quelle).toBe('api');
      expect((await ok(u, 'c-1', { name: 'Aus CSV' })).ergebnis).toBe('unveraendert');
    });

    it('gleichzeitig: Eine Änderung geht nie verloren, auch wenn Unverändertes gerade auffrischt', async () => {
      const u = await umgebung();
      await ok(u, 'p', { name: 'A', customer: 'K' });
      await altern(u, 25 * H, ['p']);
      const alle = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          put(u.token, 'p', i === 20 ? { name: 'A', customer: 'L' } : { name: 'A' }),
        ),
      );
      expect(alle.map((r) => r.statusCode).filter((c) => c !== 200)).toEqual([]);
      const ergebnisse = alle.map((r) => katalogPushAntwortSchema.parse(r.json()).ergebnis);
      expect(ergebnisse.filter((e) => e === 'aktualisiert')).toHaveLength(1);
      expect(ergebnisse.filter((e) => e === 'unveraendert')).toHaveLength(39);
      const z = await zeile(u, 'p');
      expect(z.kunde).toBe('L');
      expect(Date.now() - new Date(z.zuletzt_gesehen).getTime()).toBeLessThan(H);
      expect(await liste(u)).toHaveLength(1);
    });

    it('gleichzeitig dieselbe neue ID und dieselbe Änderung: eine Schreibung, Rest unverändert', async () => {
      const u = await umgebung();
      const neu = await Promise.all(
        Array.from({ length: 20 }, () => put(u.token, 'n', { name: 'A' })),
      );
      const ergebnisse = neu.map((r) => katalogPushAntwortSchema.parse(r.json()).ergebnis);
      expect(ergebnisse.filter((e) => e === 'neu')).toHaveLength(1);
      expect(ergebnisse.filter((e) => e === 'unveraendert')).toHaveLength(19);
      const geaendert = await Promise.all(
        Array.from({ length: 20 }, () => put(u.token, 'n', { name: 'B' })),
      );
      const e2 = geaendert.map((r) => katalogPushAntwortSchema.parse(r.json()).ergebnis);
      expect(e2.filter((e) => e === 'aktualisiert')).toHaveLength(1);
      expect(e2.filter((e) => e === 'unveraendert')).toHaveLength(19);
    });
  });

  describe('Stündliche volle Läufe', () => {
    /** Lässt nur `Date` laufen; Beginn so weit zurück, dass die echte Sitzung des Admins gültig bleibt. */
    const mitUhr = async (stundenZurueck: number, f: (start: number) => Promise<void>) => {
      const start = Date.now() - stundenZurueck * H;
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        await f(start);
      } finally {
        vi.useRealTimers();
      }
    };

    it('tage=1: nichts flackert, auch wenn der Job mitten im Lauf feuert und Läufe versetzt beginnen', async () => {
      const u = await umgebung();
      await setzen(u, { sync_deaktivieren_tage: 1, sync_deaktivieren_max_prozent: 100 });
      const ids = ['a', 'b', 'c', 'd'];
      await mitUhr(101, async (start) => {
        for (let h = 0; h < 100; h += 1) {
          const beginn = start + h * H + ((h * 37) % 300) * 1000;
          for (const [i, id] of ids.entries()) {
            vi.setSystemTime(beginn + i * 10_000);
            await ok(u, id, { name: id });
            if (i === 1) {
              const e = await lauf(u, { jetzt: new Date(Date.now()) });
              expect(e.deaktiviert, `Stunde ${h}`).toBe(0);
            }
          }
          const e = await lauf(u, { jetzt: new Date(beginn + H / 2) });
          expect(e.deaktiviert, `Stunde ${h}, nach dem Lauf`).toBe(0);
        }
      });
      expect(await aktivIds(u)).toEqual(ids);
    });

    it('tage=1: nicht mehr gesendet heißt inaktiv nach den Tagen bis einem Tag und einem Joblauf mehr, nie früher', async () => {
      const u = await umgebung();
      await setzen(u, { sync_deaktivieren_tage: 1, sync_deaktivieren_max_prozent: 100 });
      // Zuletzt gesendet direkt vor und genau beim Auffrischen nach 24 h.
      const zuletzt: Record<string, number> = { 'weg-23': 23, 'weg-24': 24 };
      const inaktivBei: Record<string, number> = {};
      await mitUhr(81, async (start) => {
        for (let h = 0; h < 80; h += 1) {
          vi.setSystemTime(start + h * H);
          await ok(u, 'bleibt', { name: 'bleibt' });
          for (const [id, letzte] of Object.entries(zuletzt)) {
            if (h <= letzte) await ok(u, id, { name: id });
          }
          await lauf(u, { jetzt: new Date(start + h * H + 60_000) });
          const inaktiv = await withMandant(db, u.mandantId, (t) =>
            t
              .selectFrom('katalog_projekt')
              .select('externe_id')
              .where('aktiv', '=', false)
              .execute(),
          );
          for (const { externe_id: id } of inaktiv) inaktivBei[id] ??= h;
        }
      });
      for (const [id, letzte] of Object.entries(zuletzt)) {
        const bei = inaktivBei[id] ?? Number.NaN;
        expect(bei - letzte, id).toBeGreaterThan(24);
        expect(bei - letzte, id).toBeLessThanOrEqual(24 + 24 + 1);
      }
      expect(inaktivBei.bleibt).toBeUndefined();
    });

    it('nur unveränderte Anfragen halten den Status über die Warnfrist hinaus auf 200, Seite und Status stimmen überein', async () => {
      const u = await umgebung();
      const ids = ['a', 'b', 'c'];
      const status = () =>
        app.inject({ url: STATUS, headers: { authorization: `Bearer ${u.token}` } });
      const vergleich = async () => {
        const r = await status();
        const k = katalogSyncStatusAntwortSchema.parse(r.json());
        const seite = (await einstellung(u)).sync;
        expect(seite.status).toBe(k.status);
        expect(seite.zuletzt_sync).toBe(k.zuletzt_sync);
        return { code: r.statusCode, ...k };
      };
      await mitUhr(120, async (start) => {
        for (let h = 0; h <= 60; h += 1) {
          vi.setSystemTime(start + h * H);
          for (const id of ids) {
            const e = await ok(u, id, { name: id });
            expect(e.ergebnis).toBe(h === 0 ? 'neu' : 'unveraendert');
          }
          if (h === 60) {
            const s = await vergleich();
            expect(s).toMatchObject({ code: 200, status: 'ok', warnung_stunden: 48 });
            expect(s.zuletzt_sync).toBe(new Date(start + 60 * H).toISOString());
          }
        }
        // Die Zeilen selbst sind nur alle 24 h geschrieben, nicht bei jedem der 61 Läufe.
        const z = await zeile(u, 'a');
        expect(new Date(z.zuletzt_gesehen).toISOString()).toBe(
          new Date(start + 48 * H).toISOString(),
        );
        // Kommt nichts mehr, greift die Warnung wie immer.
        vi.setSystemTime(start + 109 * H);
        expect(await vergleich()).toMatchObject({ code: 503, status: 'veraltet' });
      });
    });
  });

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
    await altern(u, 9 * T);
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
    ).toEqual(['anzahl:3 gesamt:3 basis:4 erlaubt:1 grenze:25%']);
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

  it('Bremse rechnet nur gegen gesendete Projekte: 30 CSV-Zeilen schützen keine 9 von 10 gesendeten', async () => {
    const u = await umgebung();
    const csv = await tokenAnlegen(u.admin, 'csv_import');
    const zeilen = Array.from({ length: 30 }, (_, i) => `c-${i};CSV ${i}`).join('\n');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/datei?vollstaendig=0',
      headers: { authorization: `Bearer ${csv.token}`, 'content-type': 'text/csv' },
      payload: `ID;Name\n${zeilen}\n`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const ids = Array.from({ length: 10 }, (_, i) => `p-${i}`);
    for (const id of ids) await ok(u, id, { name: id });
    await syncPuffer(db).leeren();
    await setzen(u, { sync_deaktivieren_tage: 7 });
    await altern(u, 9 * T, ids.slice(0, 9));
    expect(await lauf(u)).toMatchObject({ gebremst: 1, deaktiviert: 0 });
    expect(await aktivIds(u)).toHaveLength(40);
  });

  it('Bremse im kleinen Katalog: Ein Projekt darf immer gehen, nie mehr als der Anteil; leer wird er nicht', async () => {
    const u = await umgebung();
    for (const id of ['a', 'b', 'c']) await ok(u, id, { name: id });
    await syncPuffer(db).leeren();
    await setzen(u, { sync_deaktivieren_tage: 7 });
    // 1 von 3 wäre über 25 %, aber allein bliebe es für immer stehen.
    await altern(u, 9 * T, ['a']);
    expect(await lauf(u)).toMatchObject({ gebremst: 0, deaktiviert: 1 });
    expect(await aktivIds(u)).toEqual(['b', 'c']);
    // Das nächste im selben Zeitraum wäre zu viel; ist er vorbei, geht es, und das gerade gesendete bleibt.
    await altern(u, 9 * T, ['b']);
    await ok(u, 'c', { name: 'c' });
    expect(await lauf(u)).toMatchObject({ gebremst: 1, deaktiviert: 0 });
    await withMandant(db, u.mandantId, (t) =>
      t
        .updateTable('katalog_projekt')
        .set({ veraltet_seit: new Date(Date.now() - 30 * T) })
        .where('externe_id', '=', 'a')
        .execute(),
    );
    expect(await lauf(u)).toMatchObject({ gebremst: 0, deaktiviert: 1 });
    expect(await aktivIds(u)).toEqual(['c']);
    await ok(u, 'c', { name: 'c' });
    expect(await lauf(u)).toMatchObject({ gebremst: 0, deaktiviert: 0 });
    expect(await aktivIds(u)).toEqual(['c']);

    // Mehr als eins bei wenigen: Grenze greift weiter.
    const v = await umgebung();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) await ok(v, id, { name: id });
    await syncPuffer(db).leeren();
    await setzen(v, { sync_deaktivieren_tage: 7 });
    await altern(v, 9 * T, ['a', 'b']);
    expect(await lauf(v)).toMatchObject({ gebremst: 0, deaktiviert: 2 });
    const w = await umgebung();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) await ok(w, id, { name: id });
    await syncPuffer(db).leeren();
    await setzen(w, { sync_deaktivieren_tage: 7 });
    await altern(w, 9 * T, ['a', 'b', 'c']);
    expect(await lauf(w)).toMatchObject({ gebremst: 1, deaktiviert: 0 });
  });

  describe('Ein Ausfall zählt nicht als Alter', () => {
    const pushAktivAb = async (u: Umgebung) =>
      (
        await withMandant(db, u.mandantId, (t) =>
          t.selectFrom('mandant_projektkatalog').select('push_aktiv_ab').executeTakeFirstOrThrow(),
        )
      ).push_aktiv_ab;
    const hundert = Array.from({ length: 100 }, (_, i) => `p${i}`);

    it('Ausfall 9 Tage, tage=7, der erste Lauf danach bricht bei 80 % ab: nichts wird deaktiviert, kein Alarm', async () => {
      const u = await umgebung();
      for (const id of hundert) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      await setzen(u, { sync_deaktivieren_tage: 7 });
      await altern(u, 9 * T);
      await pushZeit(u, 9 * T);
      expect(await lauf(u)).toMatchObject({ uebersprungen: 1, deaktiviert: 0 });
      for (const id of hundert.slice(0, 80)) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      expect(Date.now() - new Date((await pushAktivAb(u)) ?? 0).getTime()).toBeLessThan(H);
      expect(await lauf(u)).toMatchObject({
        uebersprungen: 1,
        deaktiviert: 0,
        gebremst: 0,
        alarme: 0,
      });
      expect(await aktivIds(u)).toHaveLength(100);
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(false);
      // Senden sie wieder so lange, wie die Tage sagen, und fehlen die 20 weiter, gelten sie als entfallen.
      await withMandant(db, u.mandantId, (t) =>
        t
          .updateTable('mandant_projektkatalog')
          .set({ push_aktiv_ab: new Date(Date.now() - 7 * T) })
          .execute(),
      );
      await ok(u, 'p0', { name: 'p0' });
      expect(await lauf(u)).toMatchObject({ uebersprungen: 0, deaktiviert: 20, gebremst: 0 });
    });

    it('Lücke 26 h, tage=1, der erste Lauf danach bricht bei 85 % ab: nichts wird deaktiviert', async () => {
      const u = await umgebung();
      for (const id of hundert) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      await setzen(u, { sync_deaktivieren_tage: 1 });
      await altern(u, 49 * H);
      await pushZeit(u, 26 * H);
      for (const id of hundert.slice(0, 85)) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      expect(await lauf(u)).toMatchObject({ uebersprungen: 1, deaktiviert: 0, gebremst: 0 });
      expect(await aktivIds(u)).toHaveLength(100);
    });

    it('Quelle mit einem Lauf je Tag und Lücken um 24 h: bleibt durchgehend und altert weiter', async () => {
      const u = await umgebung();
      await setzen(u, { sync_deaktivieren_tage: 2 });
      const start = Date.now() - 12 * T;
      const zeitpunkt = (tag: number) => start + tag * T + (tag % 2 === 0 ? -1 : 1) * 30 * 60_000;
      let inaktivAm: number | null = null;
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        for (let tag = 0; tag < 10; tag += 1) {
          vi.setSystemTime(zeitpunkt(tag));
          for (const id of ['a', 'b', 'c', 'd']) await ok(u, id, { name: id });
          if (tag <= 2) await ok(u, 'weg', { name: 'weg' });
          await lauf(u, { jetzt: new Date(zeitpunkt(tag) + 60_000) });
          if (inaktivAm === null && !(await zeile(u, 'weg')).aktiv) inaktivAm = tag;
        }
      } finally {
        vi.useRealTimers();
      }
      // Lücken von 25 h und 23 h: kein Neubeginn.
      expect(new Date((await pushAktivAb(u)) ?? 0).toISOString()).toBe(
        new Date(zeitpunkt(0)).toISOString(),
      );
      expect(inaktivAm).not.toBeNull();
      expect((inaktivAm ?? 0) - 2).toBeGreaterThan(2);
      expect(await aktivIds(u)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('die Lücke zählt ab dem letzten Push: 25 h bleibt durchgehend, darüber beginnt es neu', async () => {
      const u = await umgebung();
      await ok(u, 'a', { name: 'a' });
      await syncPuffer(db).leeren();
      const anfang = new Date(Date.now() - 30 * T);
      const stellen = (push: Date) =>
        withMandant(db, u.mandantId, (t) =>
          t
            .updateTable('mandant_projektkatalog')
            .set({ zuletzt_push: push, push_aktiv_ab: anfang })
            .execute(),
        );
      await stellen(new Date(Date.now() - 24.5 * H));
      await ok(u, 'a', { name: 'a' });
      await syncPuffer(db).leeren();
      expect(await pushAktivAb(u)).toEqual(anfang);
      await stellen(new Date(Date.now() - 25.5 * H));
      await ok(u, 'a', { name: 'a' });
      await syncPuffer(db).leeren();
      expect(Date.now() - new Date((await pushAktivAb(u)) ?? 0).getTime()).toBeLessThan(H);
    });
  });

  describe('Bremse zählt über den Zeitraum', () => {
    const mitKanal = async (u: Umgebung) => {
      const kanal = await app.inject({
        method: 'POST',
        url: '/api/v1/alarmkanal',
        headers: u.admin,
        payload: {
          typ: 'webhook',
          bezeichnung: 'H',
          konfig: { url: 'https://hooks.example.org/x' },
        },
      });
      expect(kanal.statusCode).toBeLessThan(300);
      const ereignisse: string[] = [];
      const zustell = {
        fetch: (_u: string, init?: RequestInit) => {
          ereignisse.push((JSON.parse(String(init?.body)) as { ereignis: string }).ereignis);
          return Promise.resolve(new Response('{}', { status: 200 }));
        },
      };
      return { ereignisse, zustell };
    };

    it('gestaffelt alternde Projekte kommen nicht in kleinen Scheiben durch', async () => {
      const u = await umgebung();
      const ids = Array.from({ length: 40 }, (_, i) => `p-${i}`);
      for (const id of ids) await ok(u, id, { name: id });
      await ok(u, 'live', { name: 'live' });
      await setzen(u, { sync_deaktivieren_tage: 1 });
      const { ereignisse, zustell } = await mitKanal(u);
      const laeufe = [];
      // Jede Stunde werden 8 weitere alt, jede Scheibe allein läge unter 25 %.
      for (let b = 0; b < 5; b += 1) {
        await altern(u, 3 * T, ids.slice(b * 8, (b + 1) * 8));
        await ok(u, 'live', { name: 'live' });
        laeufe.push(await lauf(u, { zustell }));
      }
      expect(laeufe[0]).toMatchObject({ deaktiviert: 8, gebremst: 0 });
      for (const l of laeufe.slice(1)) expect(l).toMatchObject({ deaktiviert: 0, gebremst: 1 });
      expect(await aktivIds(u)).toHaveLength(33);
      expect(ereignisse).toEqual(['seatmeter.katalog_bremse']);
      const zeile = (await audit(u)).find((a) => a.aktion.startsWith('Deaktivieren'));
      expect(zeile?.objekt).toBe('anzahl:8 gesamt:16 basis:41 erlaubt:10 grenze:25%');
    });

    it('Schwund von 20 % je Tag: Der erste Schub geht durch, dann hält es an und alarmiert einmal', async () => {
      const u = await umgebung();
      await setzen(u, { sync_deaktivieren_tage: 1 });
      const { ereignisse, zustell } = await mitKanal(u);
      let gesendet = Array.from({ length: 50 }, (_, i) => `p-${i}`);
      const start = Date.now() - 15 * T;
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        for (let tag = 0; tag < 14; tag += 1) {
          vi.setSystemTime(start + tag * T);
          for (const id of gesendet) await ok(u, id, { name: id });
          await lauf(u, { jetzt: new Date(start + tag * T + 60_000), zustell });
          gesendet = gesendet.slice(0, Math.max(1, Math.floor(gesendet.length * 0.8)));
        }
      } finally {
        vi.useRealTimers();
      }
      // Ohne Summe über den Zeitraum blieben von 50 nur eine Handvoll.
      expect(await aktivIds(u)).toHaveLength(40);
      expect(ereignisse).toEqual(['seatmeter.katalog_bremse']);
    });

    it('ein zurückgekehrtes Projekt zählt nicht mehr', async () => {
      const u = await umgebung();
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      for (const id of ids) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      await setzen(u, { sync_deaktivieren_tage: 7 });
      await altern(u, 9 * T, ['a', 'b']);
      expect(await lauf(u)).toMatchObject({ deaktiviert: 2 });
      expect((await zeile(u, 'a')).veraltet_seit).not.toBeNull();
      expect(await ok(u, 'a', { name: 'a' })).toMatchObject({
        ergebnis: 'aktualisiert',
        active: true,
      });
      expect((await zeile(u, 'a')).veraltet_seit).toBeNull();
      // b plus c: zwei von acht, das ist erlaubt. Zählte a weiter, wären es drei.
      await altern(u, 9 * T, ['c']);
      await ok(u, 'd', { name: 'd' });
      expect(await lauf(u)).toMatchObject({ deaktiviert: 1, gebremst: 0 });
    });

    it('stille Quelle lässt den Halt stehen, ohne neuen Alarm; erst eine echte Prüfung löst ihn', async () => {
      const u = await umgebung();
      const ids = Array.from({ length: 8 }, (_, i) => `p-${i}`);
      for (const id of ids) await ok(u, id, { name: id });
      await setzen(u, { sync_deaktivieren_tage: 7 });
      const { ereignisse, zustell } = await mitKanal(u);
      await altern(u, 9 * T, ids.slice(0, 6));
      await ok(u, 'p-7', { name: 'p-7' });
      expect(await lauf(u, { zustell })).toMatchObject({ gebremst: 1, alarme: 1 });
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(true);
      // Quelle verstummt: übersprungen, nicht geprüft.
      const stumm = new Date(Date.now() + 49 * H);
      const still = await lauf(u, { jetzt: stumm, zustell });
      expect(still).toMatchObject({ uebersprungen: 1, gebremst: 0 });
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(true);
      // Zurück und immer noch zu viel: kein zweiter Alarm für denselben Halt.
      await ok(u, 'p-7', { name: 'p-7' });
      expect(await lauf(u, { zustell })).toMatchObject({ gebremst: 1, alarme: 0 });
      expect(ereignisse.filter((x) => x === 'seatmeter.katalog_bremse')).toHaveLength(1);
      // Vollständiger Lauf: Die Projekte kommen zurück, die Prüfung findet nichts, der Halt ist weg.
      for (const id of ids) await ok(u, id, { name: id });
      expect(await lauf(u, { zustell })).toMatchObject({ gebremst: 0, deaktiviert: 0 });
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(false);
    });

    it('Deaktivieren ausgeschaltet: Der Halt ist nicht mehr anwendbar und verschwindet', async () => {
      const u = await umgebung();
      const ids = Array.from({ length: 8 }, (_, i) => `p-${i}`);
      for (const id of ids) await ok(u, id, { name: id });
      await setzen(u, { sync_deaktivieren_tage: 7 });
      await altern(u, 9 * T, ids.slice(0, 6));
      await ok(u, 'p-7', { name: 'p-7' });
      expect(await lauf(u)).toMatchObject({ gebremst: 1 });
      await setzen(u, { sync_deaktivieren_tage: null });
      expect(await lauf(u)).toMatchObject({ gebremst: 0, uebersprungen: 0 });
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(false);
    });

    it('wegen Alters inaktiv und wieder als inaktiv gesendet: Merker weg, zählt nicht mehr für die Bremse', async () => {
      const u = await umgebung();
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      for (const id of ids) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      await setzen(u, { sync_deaktivieren_tage: 1 });
      await altern(u, 4 * T, ['a', 'b']);
      expect(await lauf(u)).toMatchObject({ deaktiviert: 2, gebremst: 0 });
      for (const id of ['a', 'b']) {
        expect((await zeile(u, id)).veraltet_seit).not.toBeNull();
        expect(await ok(u, id, { name: id, active: false })).toMatchObject({
          ergebnis: 'aktualisiert',
          active: false,
        });
        expect((await zeile(u, id)).veraltet_seit).toBeNull();
        expect((await zeile(u, id)).aktiv).toBe(false);
        // Danach wieder ohne Schreiben.
        expect((await ok(u, id, { name: id, active: false })).ergebnis).toBe('unveraendert');
      }
      // Zählten a und b weiter, wären es mit c drei von acht, erlaubt sind zwei.
      await altern(u, 4 * T, ['c']);
      await ok(u, 'd', { name: 'd' });
      expect(await lauf(u)).toMatchObject({ deaktiviert: 1, gebremst: 0 });
    });

    it('Ausweg: Grenze einmal erhöhen und zurückstellen; Speichern ohne Änderung beginnt nichts neu', async () => {
      const u = await umgebung();
      const ids = Array.from({ length: 20 }, (_, i) => `p-${i}`);
      for (const id of ids) await ok(u, id, { name: id });
      await syncPuffer(db).leeren();
      await setzen(u, { sync_deaktivieren_tage: 7 });
      await altern(u, 9 * T, ids.slice(0, 8));
      expect(await lauf(u)).toMatchObject({ gebremst: 1, deaktiviert: 0 });
      // Ein vollständiger Lauf hülfe hier nicht: Die acht sind wirklich entfallen.
      for (const id of ids.slice(8)) await ok(u, id, { name: id });
      expect(await lauf(u)).toMatchObject({ gebremst: 1, deaktiviert: 0 });
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(true);
      await setzen(u, { sync_deaktivieren_max_prozent: 100 });
      expect(await lauf(u)).toMatchObject({ gebremst: 0, deaktiviert: 8 });
      expect((await einstellung(u)).sync.bremse_aktiv).toBe(false);
      await setzen(u, { sync_deaktivieren_max_prozent: 25 });
      const ab = await withMandant(db, u.mandantId, (t) =>
        t.selectFrom('mandant_projektkatalog').select('sync_fenster_ab').executeTakeFirstOrThrow(),
      );
      expect(ab.sync_fenster_ab).not.toBeNull();
      // Die Seite speichert die Grenze immer mit: gleicher Wert, gleicher Zeitraum.
      await setzen(u, { sync_deaktivieren_max_prozent: 25 });
      const ab2 = await withMandant(db, u.mandantId, (t) =>
        t.selectFrom('mandant_projektkatalog').select('sync_fenster_ab').executeTakeFirstOrThrow(),
      );
      expect(ab2.sync_fenster_ab).toEqual(ab.sync_fenster_ab);
      // Danach hält das nächste entfallene Projekt nicht gleich wieder an.
      await altern(u, 9 * T, ['p-8']);
      await ok(u, 'p-9', { name: 'p-9' });
      expect(await lauf(u)).toMatchObject({ gebremst: 0, deaktiviert: 1 });
    });
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
    await altern(u, 9 * T, ['c-1', 'p-0']);
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
    // Die Klasse nennt die Ursache, der Text selbst bleibt draußen.
    expect(lauf2.fehler).toMatch(new RegExp(`${a.mandantId} \\(\\w*Error\\)`));
    expect(fehlerArt(Object.assign(new Error('geheim: Wert'), { code: '23505' }))).toBe(
      'Error 23505',
    );
    expect(fehlerArt(Object.assign(new TypeError('x'), { code: 'ERR_CRYPTO' }))).toBe('TypeError');
    expect(fehlerArt('Text')).toBe('string');
    expect(fehlerArt(null)).toBe('object');
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
      ['selbst', true, 'Selbst'],
      ['waise', true, 'Waise'],
      ['w', true, 'Webshop'],
      ['w-1', true, 'Webshop › AP Login'],
      ['w-1-1', true, 'Webshop › AP Login › Passwort'],
      ['z1', true, 'Z1'],
      ['z2', true, 'Z2'],
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
