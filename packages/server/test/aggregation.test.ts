import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Insertable } from 'kysely';
import {
  preiseAntwortSchema,
  projekteAntwortSchema,
  sitzkostenAntwortSchema,
} from '@seatmeter/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aggregiereTage } from '../src/aggregation/job.js';
import { heuteIn } from '../src/aggregation/tage.js';
import { erstelleApp } from '../src/app.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import type { AnfrageTabelle } from '../src/db/schema.js';
import { verschluessele } from '../src/krypto.js';
import {
  legeMandantAn,
  legePersonAn,
  legeProjektAn,
  meldeAn,
  testKonfiguration,
  type TestSitzung,
} from './api-hilfen.js';

describe('Tagesaggregat und Dashboard-Lesezugriffe', () => {
  let db: Db;
  let app: FastifyInstance;
  const konfiguration = testKonfiguration(inject('testDatenbankUrl'));
  const tag = heuteIn('Europe/Berlin');
  const monat = tag.slice(0, 7);
  const ts = new Date(`${tag}T10:00:00Z`);
  let a: string;
  let b: string;
  let p: string[];
  let x: string;
  let y: string;
  let admin: TestSitzung;
  let adminB: TestSitzung;
  let controller: TestSitzung;

  const anfrage = (werte: Partial<Insertable<AnfrageTabelle>>): Insertable<AnfrageTabelle> => ({
    mandant_id: a,
    anfrage_key: `req_${randomUUID()}`,
    ts,
    tag,
    model: 'claude-sonnet-5-5',
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    auth_klasse: 'abo',
    zaehlt_als_abo: true,
    quellen: 1,
    ...werte,
  });

  beforeAll(async () => {
    db = erstelleDb(konfiguration.DATABASE_URL, 4);
    app = await erstelleApp({ konfiguration, db });
    a = await legeMandantAn(db);
    b = await legeMandantAn(db);
    p = [];
    for (let i = 0; i < 4; i++) p.push(await legePersonAn(db, a));
    x = await legeProjektAn(db, a, 'x-shop');
    y = await legeProjektAn(db, a, 'y-portal');
    const [p1, p2, p3, p4] = p as [string, string, string, string];
    await db
      .insertInto('anfrage')
      .values([
        // Präfix-Treffer: claude-opus-5-5 (4/20/0,2/5/8) schlägt claude-opus-5; 1h-Annahme für A.
        // 1000·4 + 2000·20 + 10000·0,2 + 4000·8 = 78 000 µUSD
        anfrage({
          person_id: p1,
          projekt_id: x,
          session_id: 's1',
          model: 'claude-opus-5-5-20261001',
          input: 1000,
          output: 2000,
          cache_read: 10_000,
          cache_write: 4000,
        }),
        // 500·4 + 100·20 + 600·5 + 400·8 = 10 200 µUSD (5m/1h-Aufteilung aus Quelle B)
        anfrage({
          person_id: p1,
          projekt_id: x,
          session_id: 's1',
          model: 'claude-opus-5-5-20261001',
          input: 500,
          output: 100,
          cache_write: 1000,
          cache_write_1h: 400,
          quellen: 3,
        }),
        // unzugeordnet: 2000·2 + 1000·10 = 14 000 µUSD
        anfrage({ person_id: p2, projekt_id: null, input: 2000, output: 1000, quellen: 2 }),
        // US-Inferenz × 1,1: (100·2 + 100·10) · 1,1 = 1320 µUSD
        anfrage({ person_id: p3, projekt_id: y, input: 100, output: 100, inference_geo: 'us' }),
        anfrage({ person_id: p2, projekt_id: y, input: 10, output: 10 }), // 120 µUSD
        anfrage({ person_id: p4, projekt_id: y, input: 10, output: 10 }), // 120 µUSD
        // zählt nicht (kein Abo)
        anfrage({
          person_id: p1,
          projekt_id: x,
          input: 99_999,
          auth_klasse: 'api',
          zaehlt_als_abo: false,
        }),
        // Modell ohne Preis: Tokens zählen, Schattenpreis 0
        anfrage({ person_id: p1, projekt_id: x, model: 'unbekanntes-modell', input: 7 }),
        // Mandant B: eigene Daten
        anfrage({ mandant_id: b, input: 5, output: 5 }),
      ])
      .execute();
    await db
      .insertInto('otel_kontrollsumme')
      .values([
        {
          mandant_id: a,
          tag,
          session_id: 's1',
          model: 'claude-opus-5-5-20261001',
          typ: 'input',
          wert: 1500,
        },
        {
          mandant_id: a,
          tag,
          session_id: 's1',
          model: 'claude-opus-5-5-20261001',
          typ: 'output',
          wert: 2100,
        },
        {
          mandant_id: a,
          tag,
          session_id: 's1',
          model: 'claude-opus-5-5-20261001',
          typ: 'cacheRead',
          wert: 10_000,
        },
        {
          mandant_id: a,
          tag,
          session_id: 's1',
          model: 'claude-opus-5-5-20261001',
          typ: 'cacheCreation',
          wert: 5000,
        },
      ])
      .execute();
    await db
      .insertInto('ingest_statistik')
      .values({
        mandant_id: a,
        tag,
        quelle: 'a',
        angenommen: 5,
        verworfen_api: 2,
        verworfen_fremd_org: 1,
        verworfen_inhalt: 4,
      })
      .execute();
    admin = await meldeAn(db, a, 'mandanten_admin');
    controller = await meldeAn(db, a, 'controller');
    adminB = await meldeAn(db, b, 'mandanten_admin');
    await aggregiereTage(db, a, tag, tag);
    await aggregiereTage(db, b, tag, tag);
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const hole = (s: TestSitzung, url: string) =>
    app.inject({ method: 'GET', url, headers: s.headers });

  it('reproduziert Summen und Schattenpreis von Hand', async () => {
    const zeilen = await db
      .selectFrom('tag_aggregat')
      .selectAll()
      .where('mandant_id', '=', a)
      .execute();
    const opus = zeilen.find((z) => z.projekt_id === x && z.model.startsWith('claude-opus'));
    expect(opus).toMatchObject({
      person_id: p[0],
      input: 1500,
      output: 2100,
      cache_read: 10_000,
      cache_write: 5000,
      cache_write_1h: 4400,
      anfragen: 2,
      schatten_usd_micros: 88_200,
      preis_version: 'global:claude-opus-5-5@2026-01-01',
      speed: 'normal',
      auth_klasse: 'abo',
    });
    expect(Number(opus?.abo_anteil)).toBe(1);
    const unz = zeilen.find((z) => z.projekt_id === null);
    expect(unz).toMatchObject({
      person_id: p[1],
      input: 2000,
      output: 1000,
      schatten_usd_micros: 14_000,
    });
    const us = zeilen.find((z) => z.person_id === p[2]);
    expect(us?.schatten_usd_micros).toBe(1320);
    const ohne = zeilen.find((z) => z.model === 'unbekanntes-modell');
    expect(ohne).toMatchObject({ input: 7, schatten_usd_micros: 0, preis_version: null });
    // Nicht-Abo-Anfrage fehlt, Summe aller Schattenpreise stimmt.
    expect(zeilen.some((z) => z.auth_klasse === 'api')).toBe(false);
    expect(zeilen.reduce((s, z) => s + z.schatten_usd_micros, 0)).toBe(
      88_200 + 14_000 + 1320 + 240,
    );
  });

  it('Neuaufbau ist idempotent', async () => {
    const vorher = await db
      .selectFrom('tag_aggregat')
      .selectAll()
      .where('mandant_id', '=', a)
      .execute();
    const e = await aggregiereTage(db, a, tag, tag);
    expect(e).toMatchObject({ tage: 1, zeilen: vorher.length, anfragen: 7, ohne_preis: 1 });
    const nachher = await db
      .selectFrom('tag_aggregat')
      .selectAll()
      .where('mandant_id', '=', a)
      .execute();
    expect(nachher).toHaveLength(vorher.length);
  });

  it('GET /api/v1/uebersicht liefert Monatssummen, Modelle, Abdeckung und Filterzähler', async () => {
    const r = await hole(admin, `/api/v1/uebersicht?monat=${monat}`);
    expect(r.statusCode).toBe(200);
    const u = r.json();
    expect(u.monat).toBe(monat);
    expect(u.schatten_usd_micros).toBe(103_760);
    expect(u.tokens).toMatchObject({
      input: 3627,
      output: 3220,
      cache_read: 10_000,
      cache_write: 5000,
    });
    expect(u.anfragen).toBe(7);
    expect(u.nach_modell[0].model).toBe('claude-opus-5-5-20261001');
    expect(u.abdeckung).toMatchObject({
      anfragen: 7,
      nur_a: 5,
      nur_b: 1,
      beide: 1,
      a_prozent: 85.7,
      b_prozent: 28.6,
    });
    expect(u.gefiltert).toEqual({ api: 2, fremd_org: 1, inhalt_verworfen: 4 });
  });

  it('ohne Sitzung 401, falscher Monat 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/uebersicht' })).statusCode).toBe(401);
    expect((await hole(admin, '/api/v1/uebersicht?monat=2026-13')).statusCode).toBe(400);
  });

  it('Projekte: Stufe 1 versteckt Personenzahl unter 3', async () => {
    const r = await hole(admin, `/api/v1/projekte?monat=${monat}`);
    expect(r.statusCode).toBe(200);
    const liste = r.json().projekte as {
      id: string | null;
      name: string;
      personen: number | null;
      personen_hinweis: string | null;
      schatten_usd_micros: number;
    }[];
    const px = liste.find((z) => z.id === x);
    const py = liste.find((z) => z.id === y);
    const unz = liste.find((z) => z.id === null);
    expect(px).toMatchObject({
      name: 'test/x-shop',
      personen: null,
      personen_hinweis: 'zu wenige Personen',
      schatten_usd_micros: 88_200,
    });
    expect(py).toMatchObject({ personen: 3, personen_hinweis: null, schatten_usd_micros: 1560 });
    expect(unz).toMatchObject({ name: 'unzugeordnet', schatten_usd_micros: 14_000 });
  });

  it('Projektdetail: nach Modell und Tag, Personen nur ab Mindestgruppe', async () => {
    const rx = await hole(admin, `/api/v1/projekte/${x}?monat=${monat}`);
    expect(rx.statusCode).toBe(200);
    const dx = rx.json();
    expect(dx.personen).toBeNull();
    expect(dx.personen_hinweis).toBe('zu wenige Personen');
    expect(dx.nach_modell.map((m: { model: string }) => m.model).sort()).toEqual([
      'claude-opus-5-5-20261001',
      'unbekanntes-modell',
    ]);
    expect(dx.nach_tag).toEqual([expect.objectContaining({ tag, schatten_usd_micros: 88_200 })]);
    const ry = await hole(admin, `/api/v1/projekte/${y}?monat=${monat}`);
    const dy = ry.json();
    expect(dy.personen).toHaveLength(3);
    expect(dy.personen[0].nach_tag).toBeUndefined();
    const unz = await hole(admin, `/api/v1/projekte/unzugeordnet?monat=${monat}`);
    expect(unz.json().schatten_usd_micros).toBe(14_000);
    // Controller sieht Projekte, aber keine Personen.
    const rc = await hole(controller, `/api/v1/projekte/${y}?monat=${monat}`);
    expect(rc.json()).toMatchObject({
      personen: null,
      personen_hinweis: 'Rolle ohne Personensicht',
    });
    // Linie: ganze Ressource verboten → 403 mit Code, eingebettetes Feld → null + Hinweis (oben).
    const pc = await hole(controller, `/api/v1/personen?monat=${monat}`);
    expect(pc.statusCode).toBe(403);
    expect(pc.json()).toEqual({ code: 'rolle_fehlt', fehler: 'Rolle ohne Personensicht' });
  });

  it('Personen: Pseudonyme mit Monatssummen, Klarnamen nur mit Opt-in, Zugriff im Audit', async () => {
    const r = await hole(admin, `/api/v1/personen?monat=${monat}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().personen).toHaveLength(4);
    expect(r.json().personen.every((z: { klarname: unknown }) => z.klarname === null)).toBe(true);

    await db.updateTable('mandant').set({ klarnamen_aktiv: true }).where('id', '=', a).execute();
    await db
      .insertInto('person_klar')
      .values({
        person_id: p[0] as string,
        mandant_id: a,
        email_enc: verschluessele(
          konfiguration.SEATMETER_MASTER_KEY,
          'person@example.org',
          'person_klar.email_enc',
        ),
        name_enc: null,
      })
      .execute();
    const k = await hole(admin, `/api/v1/personen?monat=${monat}`);
    const p1 = k.json().personen.find((z: { id: string }) => z.id === p[0]);
    expect(p1.klarname).toEqual({ email: 'person@example.org', name: null });
    await db.updateTable('mandant').set({ klarnamen_aktiv: false }).where('id', '=', a).execute();

    const audit = await db
      .selectFrom('audit')
      .select(['aktion', 'objekt', 'benutzer_id'])
      .where('mandant_id', '=', a)
      .where('aktion', '=', 'Personensicht geöffnet')
      .execute();
    expect(
      audit.some(
        (z) => z.objekt === `personen ${monat} (Klarnamen)` && z.benutzer_id === admin.benutzerId,
      ),
    ).toBe(true);
  });

  it('Mandant mit weniger als 3 Personen: Personenliste versteckt', async () => {
    const r = await hole(adminB, `/api/v1/personen?monat=${monat}`);
    expect(r.json()).toMatchObject({ personen: null, personen_hinweis: 'zu wenige Personen' });
  });

  it('Datenqualität: unzugeordnet, Modelle ohne Preis, Ingest, Kontrollsumme', async () => {
    const r = await hole(admin, `/api/v1/datenqualitaet?monat=${monat}`);
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.unzugeordnet).toMatchObject({ tokens: 3000, anfragen: 1 });
    expect(d.modelle_ohne_preis).toEqual(['unbekanntes-modell']);
    expect(d.ingest).toEqual([
      {
        quelle: 'a',
        angenommen: 5,
        verworfen_inhalt: 4,
        verworfen_api: 2,
        verworfen_fremd_org: 1,
        unzugeordnet: 0,
      },
    ]);
    expect(d.kontrollsumme).toMatchObject({
      sitzungen: 1,
      sitzungen_abweichend: 0,
      tokens_kontrolle: 18_600,
      tokens_gezaehlt: 18_600,
      prozent: 100,
    });
  });

  it('Datenqualität für Projektleiter: nur sichtbare Projekte (Modelle, Kontrollsumme, Abdeckung)', async () => {
    const plX = await meldeAn(db, a, 'projektleiter', [x]);
    const plY = await meldeAn(db, a, 'projektleiter', [y]);
    const dx = (await hole(plX, `/api/v1/datenqualitaet?monat=${monat}`)).json();
    // x enthält das Modell ohne Preis und die Sitzung s1 (beide Anfragen von s1 liegen in x).
    expect(dx.modelle_ohne_preis).toEqual(['unbekanntes-modell']);
    expect(dx.kontrollsumme).toMatchObject({ sitzungen: 1, tokens_kontrolle: 18_600 });
    expect(dx.unzugeordnet).toMatchObject({ tokens: 0, anfragen: 0 });
    expect(dx.abdeckung).toMatchObject({ anfragen: 3, nur_a: 2, beide: 1 });
    const dy = (await hole(plY, `/api/v1/datenqualitaet?monat=${monat}`)).json();
    expect(dy.modelle_ohne_preis).toEqual([]);
    expect(dy.kontrollsumme).toMatchObject({ sitzungen: 0, tokens_kontrolle: 0, prozent: null });
    expect(dy.abdeckung).toMatchObject({ anfragen: 3 });
    // Ingest-Zähler haben keine Projektdimension: mandantenweit wie `gefiltert` der Übersicht.
    expect(dy.ingest).toEqual(dx.ingest);
    // Sitzung, die auch in einem fremden Projekt arbeitet, zählt für plX nicht.
    await db
      .insertInto('anfrage')
      .values(anfrage({ person_id: p[0] as string, projekt_id: y, session_id: 's1', input: 1 }))
      .execute();
    try {
      const gemischt = (await hole(plX, `/api/v1/datenqualitaet?monat=${monat}`)).json();
      expect(gemischt.kontrollsumme.sitzungen).toBe(0);
      const adminSicht = (await hole(admin, `/api/v1/datenqualitaet?monat=${monat}`)).json();
      expect(adminSicht.kontrollsumme.sitzungen).toBe(1);
    } finally {
      await db
        .deleteFrom('anfrage')
        .where('session_id', '=', 's1')
        .where('input', '=', 1)
        .execute();
    }
  });

  it('Antworten entsprechen den Schemas aus shared (projekte, preise, sitzkosten)', async () => {
    const projekte = projekteAntwortSchema.parse(
      (await hole(admin, `/api/v1/projekte?monat=${monat}`)).json(),
    );
    expect(projekte.projekte.length).toBeGreaterThan(0);
    const preise = preiseAntwortSchema.parse((await hole(admin, '/api/v1/preise')).json());
    expect(preise.zeilen.length).toBeGreaterThan(0);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/sitzkosten',
      headers: admin.headers,
      payload: {
        sitz_typ: 'premium',
        gueltig_ab: '2026-01-01',
        preis_monat: 150,
        abrechnung: 'monatlich',
      },
    });
    expect(put.statusCode).toBe(200);
    const sitzkosten = sitzkostenAntwortSchema.parse(
      (await hole(admin, '/api/v1/sitzkosten')).json(),
    );
    expect(sitzkosten.zeilen).toContainEqual({
      sitz_typ: 'premium',
      gueltig_ab: '2026-01-01',
      preis_monat: 150,
      waehrung: 'USD',
      abrechnung: 'monatlich',
    });
  });

  it('RLS: Mandant B sieht nichts von A', async () => {
    const u = (await hole(adminB, `/api/v1/uebersicht?monat=${monat}`)).json();
    expect(u.anfragen).toBe(1);
    expect(u.schatten_usd_micros).toBe(60);
    expect(u.gefiltert).toEqual({ api: 0, fremd_org: 0, inhalt_verworfen: 0 });
    const liste = (await hole(adminB, `/api/v1/projekte?monat=${monat}`)).json().projekte;
    expect(liste.map((z: { id: string | null }) => z.id)).toEqual([null]);
    expect((await hole(adminB, `/api/v1/projekte/${x}?monat=${monat}`)).statusCode).toBe(404);
    const dq = (await hole(adminB, `/api/v1/datenqualitaet?monat=${monat}`)).json();
    expect(dq.kontrollsumme.sitzungen).toBe(0);
    expect(dq.ingest).toEqual([]);
    const audit = (await hole(adminB, '/api/v1/audit')).json().eintraege;
    expect(audit).toEqual([]);
  });

  it('Neuaufbau per API nur für Admins, mit CSRF, und protokolliert', async () => {
    const url = `/api/v1/jobs/aggregation/tag?von=${tag}&bis=${tag}`;
    expect(
      (await app.inject({ method: 'POST', url, headers: controller.headers })).statusCode,
    ).toBe(403);
    const ohneCsrf = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: admin.headers.cookie },
    });
    expect(ohneCsrf.statusCode).toBe(403);
    const r = await app.inject({ method: 'POST', url, headers: admin.headers });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ von: tag, bis: tag, tage: 1, anfragen: 7 });
    const lauf = await db
      .selectFrom('job_lauf')
      .select(['status', 'ausloeser'])
      .where('job', '=', 'aggregation.tag')
      .where('ausloeser', '=', 'api')
      .execute();
    expect(lauf.some((z) => z.status === 'ok')).toBe(true);
  });
});
