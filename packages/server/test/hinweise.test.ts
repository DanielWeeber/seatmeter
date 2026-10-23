// Projekt-Hinweise (Kern, bis 2026-10-24 ee): Regeln als reine Funktion (Schwellen) und der Job gegen die Datenbank (Upsert je
// Monat/Projekt/Typ, erledigt bleibt erledigt, nicht mehr zutreffende offene Hinweise verschwinden), RLS.
//
// Datensatz Mandant H, Monat 2026-10 (Preise aus dem Seed; Opus 5.5 Cache-Write 1h = 8 $/MTok):
//   x: Opus, Schatten 100 $, davon 10 M Cache-Write-1h-Tokens = 80 $ → Cache-Write 80 % (> 60), Opus 100 % (> 80)
//   x: Modell „claude-neu-9“ ohne Preis → Hinweis „Modell ohne Preis“
//   z: Sonnet Fast Mode, Schatten 50 $ → Fast 100 % (> 20)
//   unzugeordnet: 20 $ von 170 $ = 11,8 % (> 5)
//   Person q mit Premium-Sitz (100 $) ohne Nutzung → „Ungenutzte Sitze“ 100 $
//   Budget x 10 $ → Prognose über Budget
import { randomUUID } from 'node:crypto';
import { erstelleDb, type Db } from '../src/index.js';
import { hinweisRegelnSchema, type HinweisListe } from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { erzeugeHinweise } from '../src/hinweise/index.js';
import { kernApp, legeMandantAn, legePersonAn, legeProjektAn, meldeAn } from './api-hilfen.js';
import { M, kurs, tagAggregat } from './modul-hilfen.js';

const MONAT = '2026-10';
const regeln = hinweisRegelnSchema.parse({});

describe('Hinweis-Regeln', () => {
  const projekt = (werte: Partial<Parameters<typeof erzeugeHinweise>[0]['projekte'][number]>) => ({
    projektId: 'p1',
    schattenUsdMicros: 100 * M,
    cacheWriteUsdMicros: 0,
    fastUsdMicros: 0,
    opusUsdMicros: 0,
    modelleOhnePreis: [],
    ...werte,
  });

  it('löst je Regel genau oberhalb der Schwelle aus', () => {
    const typen = (p: ReturnType<typeof projekt>) =>
      erzeugeHinweise({ projekte: [p], ungenutztUsdMicros: 0, budgets: [], regeln }).map(
        (h) => h.typ,
      );
    expect(
      typen(projekt({ cacheWriteUsdMicros: 60 * M, fastUsdMicros: 20 * M, opusUsdMicros: 80 * M })),
    ).toEqual([]);
    expect(
      typen(projekt({ cacheWriteUsdMicros: 61 * M, fastUsdMicros: 21 * M, opusUsdMicros: 81 * M })),
    ).toEqual(['cache_write', 'fast_mode', 'opus_anteil']);
    // Unter dem Mindestbetrag (5 $) keine Kostenhinweise, Modell ohne Preis trotzdem.
    expect(
      typen(projekt({ schattenUsdMicros: 4 * M, opusUsdMicros: 4 * M, modelleOhnePreis: ['m'] })),
    ).toEqual(['modell_ohne_preis']);
  });

  it('mandantenweite Hinweise: unzugeordnet, ungenutzte Sitze, Prognose über Budget', () => {
    const h = erzeugeHinweise({
      projekte: [projekt({}), projekt({ projektId: null, schattenUsdMicros: 6 * M })],
      ungenutztUsdMicros: 20 * M,
      budgets: [
        { projektId: 'p1', name: 'x', betrag: 100, prognose: 120, einheit: 'EUR' },
        { projektId: 'p1', name: 'x2', betrag: 100, prognose: 130, einheit: 'EUR' },
        { projektId: null, name: 'alle', betrag: 100, prognose: 90, einheit: 'EUR' },
      ],
      regeln,
    });
    expect(h.map((z) => [z.typ, z.projektId, z.wert])).toEqual([
      ['unzugeordnet', null, 5.7],
      ['sitze_ungenutzt', null, 20],
      ['prognose_ueber_budget', 'p1', 120],
    ]);
    expect(h[2]!.text).toContain('120,00 €');
    expect(h[2]!.text).toContain('% von 100,00 €)');
  });
});

describe('Hinweise-Job und Routen', () => {
  let db: Db;
  let app: FastifyInstance;
  let h: string;
  let x: string;
  let z: string;
  let admin: Awaited<ReturnType<typeof meldeAn>>;
  let leiter: Awaited<ReturnType<typeof meldeAn>>;
  let fremd: Awaited<ReturnType<typeof meldeAn>>;
  const url = inject('modulDatenbankUrl');
  const get = (s: { headers: Record<string, string> }, pfad: string) =>
    app.inject({ method: 'GET', url: pfad, headers: s.headers });
  const post = (s: { headers: Record<string, string> }, pfad: string, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url: pfad,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  beforeAll(async () => {
    db = erstelleDb(url, 4);
    app = await kernApp(db, url);
    h = await legeMandantAn(db);
    x = await legeProjektAn(db, h, `x-${randomUUID().slice(0, 6)}`);
    z = await legeProjektAn(db, h, `z-${randomUUID().slice(0, 6)}`);
    await kurs(db, h, MONAT, 0.86);
    const p = await legePersonAn(db, h);
    const q = await legePersonAn(db, h);
    await db
      .insertInto('sitzkosten')
      .values({
        mandant_id: h,
        sitz_typ: 'premium',
        gueltig_ab: '2026-01-01',
        preis_monat: 100,
        waehrung: 'USD',
      })
      .execute();
    await db
      .insertInto('person_sitz')
      .values({ mandant_id: h, person_id: q, sitz_typ: 'premium', gueltig_ab: '2026-10-01' })
      .execute();
    await tagAggregat(db, h, [
      {
        tag: '2026-10-05',
        person: p,
        projekt: x,
        usd: 100,
        model: 'claude-opus-5-5',
        tokens: { cache_write: 10_000_000, cache_write_1h: 10_000_000 },
      },
      { tag: '2026-10-05', person: p, projekt: x, usd: 0, model: 'claude-neu-9', preis: null },
      {
        tag: '2026-10-06',
        person: p,
        projekt: z,
        usd: 50,
        model: 'claude-sonnet-5-5',
        speed: 'fast',
      },
      { tag: '2026-10-06', person: p, projekt: null, usd: 20, model: 'claude-sonnet-5-5' },
    ]);
    admin = await meldeAn(db, h, 'mandanten_admin');
    leiter = await meldeAn(db, h, 'projektleiter', [z]);
    fremd = await meldeAn(db, await legeMandantAn(db), 'mandanten_admin');
    expect(
      (await post(admin, '/api/v1/budgets', { projekt_id: x, betrag: 10, waehrung: 'USD' }))
        .statusCode,
    ).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('erzeugt die Hinweise des Monats', async () => {
    const r = await post(admin, `/api/v1/jobs/hinweise/erzeugen?monat=${MONAT}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ monat: MONAT, hinweise: 7, neu: 7, entfernt: 0 });
    const liste = (await get(admin, `/api/v1/hinweise?monat=${MONAT}`)).json<HinweisListe>();
    const typen = liste.hinweise
      .map((t) => `${t.typ}:${t.projekt_id === x ? 'x' : t.projekt_id === z ? 'z' : '-'}`)
      .sort();
    expect(typen).toEqual([
      'cache_write:x',
      'fast_mode:z',
      'modell_ohne_preis:x',
      'opus_anteil:x',
      'prognose_ueber_budget:x',
      'sitze_ungenutzt:-',
      'unzugeordnet:-',
    ]);
    expect(liste.hinweise.find((t) => t.typ === 'cache_write')!.wert).toBe(80);
    expect(liste.hinweise.find((t) => t.typ === 'sitze_ungenutzt')!.wert).toBe(100);
    expect(liste.regeln).toEqual(regeln);
    // Projektleiter sieht nur Hinweise seiner Projekte; fremder Mandant nichts.
    expect(
      (await get(leiter, `/api/v1/hinweise?monat=${MONAT}`))
        .json<HinweisListe>()
        .hinweise.map((t) => t.typ),
    ).toEqual(['fast_mode']);
    expect(
      (await get(fremd, `/api/v1/hinweise?monat=${MONAT}`)).json<HinweisListe>().hinweise,
    ).toEqual([]);
  });

  it('erledigt bleibt erledigt; offene Hinweise verschwinden, wenn die Regel nicht mehr greift', async () => {
    const liste = (await get(admin, `/api/v1/hinweise?monat=${MONAT}`)).json<HinweisListe>();
    const opus = liste.hinweise.find((t) => t.typ === 'opus_anteil')!;
    expect((await post(fremd, `/api/v1/hinweise/${opus.id}/erledigt`)).statusCode).toBe(404);
    const e = await post(admin, `/api/v1/hinweise/${opus.id}/erledigt`);
    expect(e.json()).toMatchObject({ id: opus.id, erledigt: expect.any(String) });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/hinweise/regeln',
      headers: admin.headers,
      payload: { cache_write_prozent: 90, opus_prozent: 99 },
    });
    expect(put.json()).toMatchObject({
      cache_write_prozent: 90,
      opus_prozent: 99,
      fast_prozent: 20,
    });
    const r = await post(admin, `/api/v1/jobs/hinweise/erzeugen?monat=${MONAT}`);
    // Opus 100 % > 99 % bleibt (erledigt), Cache-Write 80 % < 90 % fällt weg.
    expect(r.json()).toMatchObject({ hinweise: 6, neu: 0, entfernt: 1 });
    const danach = (await get(admin, `/api/v1/hinweise?monat=${MONAT}`)).json<HinweisListe>()
      .hinweise;
    expect(danach.find((t) => t.typ === 'cache_write')).toBeUndefined();
    expect(danach.find((t) => t.typ === 'opus_anteil')!.erledigt).not.toBeNull();
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/hinweise/regeln',
          headers: leiter.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
});
