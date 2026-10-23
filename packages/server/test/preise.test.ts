import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PREIS_SEED, SITZ_STANDARDKOSTEN, type PreisEingabe } from '@seatmeter/shared';
import { aggregiereTage } from '../src/aggregation/job.js';
import { heuteIn } from '../src/aggregation/tage.js';
import { erstelleApp } from '../src/app.js';
import { erstelleDb, type Db } from '../src/db/db.js';
import { effektivePreistabelle, preiseSeedEinspielen } from '../src/preise/tabelle.js';
import {
  legeMandantAn,
  legePersonAn,
  meldeAn,
  testKonfiguration,
  type TestSitzung,
} from './api-hilfen.js';

const OPUS_EIGEN: PreisEingabe = {
  modell_praefix: 'claude-opus-5-5',
  gueltig_ab: '2026-01-01',
  saetze: { input: 1, output: 2, cache_read: 0.1, cache_write_5m: 1, cache_write_1h: 1 },
  quelle_url: 'https://example.org/vertrag',
  geprueft_am: '2026-10-22',
};

describe('Modul preise: Seed, Vorrang der Mandanten-Zeilen, Sitzkosten, Sitzliste', () => {
  let db: Db;
  let app: FastifyInstance;
  let a: string;
  let b: string;
  let admin: TestSitzung;
  let leser: TestSitzung;
  let adminB: TestSitzung;

  beforeAll(async () => {
    const konfiguration = testKonfiguration(inject('testDatenbankUrl'));
    db = erstelleDb(konfiguration.DATABASE_URL, 4);
    app = await erstelleApp({ konfiguration, db });
    a = await legeMandantAn(db);
    b = await legeMandantAn(db);
    admin = await meldeAn(db, a, 'mandanten_admin');
    leser = await meldeAn(db, a, 'controller');
    adminB = await meldeAn(db, b, 'mandanten_admin');
  });

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it('Seed ist idempotent und überschreibt keine Mandanten-Zeilen', async () => {
    await preiseSeedEinspielen(db);
    await preiseSeedEinspielen(db);
    const global = await db
      .selectFrom('preis')
      .select('modell_praefix')
      .where('mandant_id', 'is', null)
      .where('quelle_url', '=', PREIS_SEED[0]?.quelle_url ?? '')
      .execute();
    expect(global).toHaveLength(PREIS_SEED.length);
  });

  it('effektive Tabelle: eigener Präfix verdrängt den globalen, andere bleiben', () => {
    const zeilen = [
      { mandant_id: null, modell_praefix: 'claude-opus-5-5' },
      { mandant_id: null, modell_praefix: 'claude-opus-5' },
      { mandant_id: 'm', modell_praefix: 'Claude-Opus-5-5' },
    ];
    expect(effektivePreistabelle(zeilen)).toEqual([zeilen[1], zeilen[2]]);
  });

  it('POST/PUT nur für Admins mit CSRF; Mandanten-Zeile gilt vor der globalen', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/preise',
          headers: leser.headers,
          payload: OPUS_EIGEN,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/preise',
          headers: { cookie: admin.headers.cookie },
          payload: OPUS_EIGEN,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/preise',
          headers: admin.headers,
          payload: { ...OPUS_EIGEN, saetze: { input: -1 } },
        })
      ).statusCode,
    ).toBe(400);
    const neu = await app.inject({
      method: 'POST',
      url: '/api/v1/preise',
      headers: admin.headers,
      payload: OPUS_EIGEN,
    });
    expect(neu.statusCode).toBe(201);
    expect(neu.json()).toMatchObject({ herkunft: 'mandant', aktiv: true, mandant_id: a });
    const doppelt = await app.inject({
      method: 'POST',
      url: '/api/v1/preise',
      headers: admin.headers,
      payload: OPUS_EIGEN,
    });
    expect(doppelt.statusCode).toBe(409);

    const liste = (
      await app.inject({ method: 'GET', url: '/api/v1/preise', headers: leser.headers })
    ).json().zeilen as {
      id: string;
      modell_praefix: string;
      herkunft: string;
      aktiv: boolean;
    }[];
    const opus = liste.filter((z) => z.modell_praefix === 'claude-opus-5-5');
    expect(opus.find((z) => z.herkunft === 'global')?.aktiv).toBe(false);
    expect(opus.find((z) => z.herkunft === 'mandant')?.aktiv).toBe(true);
    expect(liste.find((z) => z.modell_praefix === 'claude-opus-5')?.aktiv).toBe(true);

    // Mandant B sieht die Zeile von A nicht.
    const listeB = (
      await app.inject({ method: 'GET', url: '/api/v1/preise', headers: adminB.headers })
    ).json().zeilen as {
      herkunft: string;
    }[];
    expect(listeB.some((z) => z.herkunft === 'mandant')).toBe(false);

    // Aggregation rechnet mit dem Mandantenpreis: 1000·1 + 1000·2 = 3000 µUSD.
    const tag = heuteIn('Europe/Berlin');
    const person = await legePersonAn(db, a);
    await db
      .insertInto('anfrage')
      .values({
        mandant_id: a,
        anfrage_key: `req_${randomUUID()}`,
        ts: new Date(`${tag}T10:00:00Z`),
        tag,
        person_id: person,
        model: 'claude-opus-5-5',
        input: 1000,
        output: 1000,
        cache_read: 0,
        cache_write: 0,
        auth_klasse: 'abo',
        zaehlt_als_abo: true,
      })
      .execute();
    await aggregiereTage(db, a, tag, tag);
    const agg = await db
      .selectFrom('tag_aggregat')
      .select(['schatten_usd_micros', 'preis_version'])
      .where('mandant_id', '=', a)
      .executeTakeFirstOrThrow();
    expect(agg).toEqual({
      schatten_usd_micros: 3000,
      preis_version: 'mandant:claude-opus-5-5@2026-01-01',
    });

    // PUT ändert die eigene Zeile, globale Zeilen und fremde Zeilen sind tabu.
    const id = neu.json().id as string;
    const geaendert = await app.inject({
      method: 'PUT',
      url: `/api/v1/preise/${id}`,
      headers: admin.headers,
      payload: { ...OPUS_EIGEN, saetze: { ...OPUS_EIGEN.saetze, input: 3 } },
    });
    expect(geaendert.statusCode).toBe(200);
    expect(geaendert.json().saetze.input).toBe(3);
    const globalId = opus.find((z) => z.herkunft === 'global')?.id;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/preise/${globalId}`,
          headers: admin.headers,
          payload: OPUS_EIGEN,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/preise/${id}`,
          headers: adminB.headers,
          payload: OPUS_EIGEN,
        })
      ).statusCode,
    ).toBe(404);
    const audit = await db
      .selectFrom('audit')
      .select('aktion')
      .where('mandant_id', '=', a)
      .execute();
    expect(audit.map((z) => z.aktion)).toEqual(
      expect.arrayContaining(['Preis angelegt', 'Preis geändert']),
    );
  });

  it('Sitzkosten: PUT (einzeln oder Liste) und GET', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/sitzkosten',
      headers: admin.headers,
      payload: [
        { sitz_typ: 'premium', gueltig_ab: '2026-01-01', preis_monat: 100 },
        { sitz_typ: 'standard', gueltig_ab: '2026-01-01', preis_monat: 20 },
      ],
    });
    expect(put.statusCode).toBe(200);
    await app.inject({
      method: 'PUT',
      url: '/api/v1/sitzkosten',
      headers: admin.headers,
      payload: {
        sitz_typ: 'premium',
        gueltig_ab: '2026-01-01',
        preis_monat: 125,
        abrechnung: 'monatlich',
      },
    });
    const get = (
      await app.inject({ method: 'GET', url: '/api/v1/sitzkosten', headers: leser.headers })
    ).json();
    // Standardpreise max5/max20 legt die Datenbank für jeden neuen Mandanten an (Migration 0017).
    const standard = [...SITZ_STANDARDKOSTEN].sort((x, y) => x.sitz_typ.localeCompare(y.sitz_typ));
    expect(get.zeilen).toEqual([
      ...standard,
      {
        sitz_typ: 'premium',
        gueltig_ab: '2026-01-01',
        preis_monat: 125,
        waehrung: 'USD',
        abrechnung: 'monatlich',
      },
      {
        sitz_typ: 'standard',
        gueltig_ab: '2026-01-01',
        preis_monat: 20,
        waehrung: 'USD',
        abrechnung: 'jaehrlich',
      },
    ]);
    const getB = (
      await app.inject({ method: 'GET', url: '/api/v1/sitzkosten', headers: adminB.headers })
    ).json();
    expect(getB.zeilen).toEqual(standard);
  });

  it('Sitzliste je Person: neuer Zeitraum schließt den vorherigen', async () => {
    const person = await legePersonAn(db, a);
    const url = `/api/v1/personen/${person}/sitz`;
    await app.inject({
      method: 'PUT',
      url,
      headers: admin.headers,
      payload: { sitz_typ: 'standard', gueltig_ab: '2026-01-01' },
    });
    const zwei = await app.inject({
      method: 'PUT',
      url,
      headers: admin.headers,
      payload: { sitz_typ: 'premium', gueltig_ab: '2026-07-01' },
    });
    expect(zwei.statusCode).toBe(200);
    const get = (await app.inject({ method: 'GET', url, headers: admin.headers })).json();
    expect(get.sitze).toEqual([
      { sitz_typ: 'standard', gueltig_ab: '2026-01-01', gueltig_bis: '2026-06-30' },
      { sitz_typ: 'premium', gueltig_ab: '2026-07-01', gueltig_bis: null },
    ]);
    // Person von A ist für B unsichtbar.
    expect((await app.inject({ method: 'GET', url, headers: adminB.headers })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers: adminB.headers,
          payload: { sitz_typ: 'max20', gueltig_ab: '2026-08-01' },
        })
      ).statusCode,
    ).toBe(404);
  });
});
