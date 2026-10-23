// Budgets und Alarme (Kern, bis 2026-10-24 ee): Verbrauch und Prognose (Arbeitstage), jede Schwelle genau einmal (auch nach
// Quittieren und wiederholten Läufen), Zustellung über Webhook/Relay/SMTP mit Wiederholung, Geheimnisse nie
// in Antworten, Rollen, RLS; ohne Plugin und ohne Lizenz erreichbar.
//
// Datensatz Mandant A, Monat 2026-10, Kurs manuell 0,86 € je $, keine Sitze:
//   Projekt x: Schatten 300 $ → Projektpreis 300,00 $ → 258,00 € (30 000 Cent × 0,86)
//   Projekt y: Schatten 150 $ → 150,00 $
//   Budget x 250 € (Schwellen 50/80/100): Verbrauch 258 € = 103,2 % → drei Alarme.
//   Arbeitstage Oktober 2026 (1. = Donnerstag): bis 22.10. 16, ganzer Monat 22
//   → Prognose 258 / 16 · 22 = 354,75 € (141,9 %).
import { randomUUID } from 'node:crypto';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import type { Alarm, Budget, BudgetListe, Kanal } from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  arbeitstage,
  prognose,
  pruefeBudgets,
  zustellen,
  ZustellFehler,
} from '../src/budgets/index.js';
import { kernApp, legeMandantAn, legeProjektAn, meldeAn, testKonfiguration } from './api-hilfen.js';
import { kurs, starteEmpfaenger, tagAggregat, type Empfaenger } from './modul-hilfen.js';

const JETZT = new Date('2026-10-22T10:00:00Z');
const MONAT = '2026-10';

describe('Budget-Prognose (Architektur §5)', () => {
  it('rechnet linear über Arbeitstage hoch (Beispiel aus §5: 380 € an Tag 14 von 21 → 570 €)', () => {
    expect(prognose(380, { bisher: 14, monat: 21, kalenderBisher: 20, kalenderMonat: 30 })).toBe(
      570,
    );
  });

  it('zählt Arbeitstage Mo–Fr; abgeschlossener Monat = Verbrauch; Wochenende am Anfang über Kalendertage', () => {
    expect(arbeitstage(MONAT, '2026-10-22')).toEqual({
      bisher: 16,
      monat: 22,
      kalenderBisher: 22,
      kalenderMonat: 31,
    });
    const vorbei = arbeitstage('2026-09', '2026-10-22');
    expect(prognose(100, vorbei)).toBe(100);
    // 2026-11-01 ist ein Sonntag: noch kein Arbeitstag, 1 von 30 Kalendertagen.
    const sonntag = arbeitstage('2026-11', '2026-11-01');
    expect(sonntag.bisher).toBe(0);
    expect(prognose(10, sonntag)).toBe(300);
  });
});

describe('Budgets und Alarme', () => {
  let db: Db;
  let app: FastifyInstance;
  let empfaenger: Empfaenger;
  const url = inject('modulDatenbankUrl');
  const ctx = () => ({
    db,
    konfiguration: testKonfiguration(url, { SEATMETER_PUBLIC_URL: 'http://seatmeter.test' }),
  });
  let a: string;
  let b: string;
  let c: string;
  let x: string;
  let y: string;
  let admin: Awaited<ReturnType<typeof meldeAn>>;
  let adminB: Awaited<ReturnType<typeof meldeAn>>;
  let adminC: Awaited<ReturnType<typeof meldeAn>>;
  let controller: Awaited<ReturnType<typeof meldeAn>>;
  let leiter: Awaited<ReturnType<typeof meldeAn>>;
  let budgetX: Budget;

  const anfrage = (
    s: { headers: Record<string, string> },
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    pfad: string,
    payload?: unknown,
    instanz?: FastifyInstance,
  ) =>
    (instanz ?? app).inject({
      method,
      url: pfad,
      headers: s.headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  beforeAll(async () => {
    db = erstelleDb(url, 4);
    app = await kernApp(db, url);
    empfaenger = await starteEmpfaenger();
    a = await legeMandantAn(db);
    b = await legeMandantAn(db);
    c = await legeMandantAn(db);
    x = await legeProjektAn(db, a, `x-${randomUUID().slice(0, 6)}`);
    y = await legeProjektAn(db, a, `y-${randomUUID().slice(0, 6)}`);
    await kurs(db, a, MONAT, 0.86);
    await tagAggregat(db, a, [
      { tag: '2026-10-05', person: null, projekt: x, usd: 300 },
      { tag: '2026-10-06', person: null, projekt: y, usd: 150 },
    ]);
    admin = await meldeAn(db, a, 'mandanten_admin');
    adminB = await meldeAn(db, b, 'mandanten_admin');
    adminC = await meldeAn(db, c, 'mandanten_admin');
    controller = await meldeAn(db, a, 'controller');
    leiter = await meldeAn(db, a, 'projektleiter', [x]);
  });

  afterAll(async () => {
    await empfaenger.schliessen();
    await app.close();
    await db.destroy();
  });

  it('läuft im Kern ohne Plugin und ohne Lizenz (kein 402)', async () => {
    for (const pfad of [`/api/v1/budgets?monat=${MONAT}`, '/api/v1/hinweise', '/api/v1/abgleich']) {
      const r = await anfrage(admin, 'GET', pfad);
      expect(r.statusCode, pfad).toBe(200);
    }
    expect((await anfrage(admin, 'GET', '/api/v1/ee/budgets')).statusCode).toBe(404);
    // Die Jobs laufen im Job-Planer des Kerns (ohne Lizenz-Tor).
    expect(app.seatmeterKernJobs.map((j) => j.name)).toEqual(
      expect.arrayContaining(['budgets.pruefen', 'hinweise.erzeugen', 'abgleich.analytics']),
    );
    expect(app.seatmeter.plugins).toEqual([]);
  });

  it('legt Budgets an (Standard-Schwellen, mandantenweit) und prüft Eingaben und Rollen', async () => {
    const r = await anfrage(admin, 'POST', '/api/v1/budgets', { projekt_id: x, betrag: 250 });
    expect(r.statusCode).toBe(201);
    budgetX = r.json<Budget>();
    expect(budgetX).toMatchObject({
      projekt_id: x,
      betrag: 250,
      waehrung: 'EUR',
      basis: 'projektpreis',
      schwellen: [50, 80, 100],
    });
    const gesamt = await anfrage(admin, 'POST', '/api/v1/budgets', {
      projekt_id: null,
      betrag: 1e9,
      basis: 'tokens',
      bezeichnung: 'Alle Projekte (Tokens)',
    });
    expect(gesamt.statusCode).toBe(201);
    expect(
      (await anfrage(admin, 'POST', '/api/v1/budgets', { projekt_id: x, betrag: -1 })).statusCode,
    ).toBe(400);
    expect(
      (await anfrage(admin, 'POST', '/api/v1/budgets', { projekt_id: randomUUID(), betrag: 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await anfrage(controller, 'POST', '/api/v1/budgets', { projekt_id: x, betrag: 1 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await anfrage(leiter, 'POST', '/api/v1/budgets', { projekt_id: null, betrag: 1 }))
        .statusCode,
    ).toBe(403);
    expect(
      (await anfrage(leiter, 'POST', '/api/v1/budgets', { projekt_id: y, betrag: 1 })).statusCode,
    ).toBe(403);
  });

  it('zeigt Verbrauch und Prognose je Budget; Projektleiter sieht nur eigene Projekte', async () => {
    const liste = (
      await anfrage(admin, 'GET', `/api/v1/budgets?monat=${MONAT}`)
    ).json<BudgetListe>();
    const bx = liste.budgets.find((z) => z.id === budgetX.id)!;
    expect(bx.stand).toMatchObject({ verbrauch: 258, prozent: 103.2, arbeitstage_monat: 22 });
    // Prognose hängt vom heutigen Tag ab; für den Stichtag 22.10. prüft der Job-Test unten 354,75 €.
    const gesamt = liste.budgets.find((z) => z.projekt_id === null)!;
    expect(gesamt.projekt_name).toBeNull();
    const leiterListe = (
      await anfrage(leiter, 'GET', `/api/v1/budgets?monat=${MONAT}`)
    ).json<BudgetListe>();
    expect(leiterListe.budgets.map((z) => z.id)).toEqual([budgetX.id]);
  });

  it('jede Schwelle alarmiert genau einmal, auch über wiederholte Läufe und nach dem Quittieren', async () => {
    const kanal = await anfrage(admin, 'POST', '/api/v1/alarmkanal', {
      typ: 'webhook',
      bezeichnung: 'Test-Webhook',
      konfig: { url: `${empfaenger.url}/hook` },
      geheimnis: 'geheim-token-123',
    });
    expect(kanal.statusCode).toBe(201);
    expect(kanal.body).not.toContain('geheim-token-123');

    const lauf1 = await pruefeBudgets(ctx(), {}, JETZT, a);
    expect(lauf1).toMatchObject({ budgets: 2, neue_alarme: 3, zugestellt: 3, fehler: 0 });
    expect(empfaenger.anfragen).toHaveLength(3);
    const erste = empfaenger.anfragen[0]!;
    expect(erste.pfad).toBe('/hook');
    expect(erste.header.authorization).toBe('Bearer geheim-token-123');
    expect(erste.koerper).toMatchObject({
      ereignis: 'seatmeter.budget_alarm',
      link: `http://seatmeter.test/budgets?monat=${MONAT}`,
    });
    const schwellen = empfaenger.anfragen
      .map((e) => (e.koerper as { alarm: Alarm }).alarm.schwelle)
      .sort((p, q) => p - q);
    expect(schwellen).toEqual([50, 80, 100]);
    expect((erste.koerper as { prognose: number }).prognose).toBe(354.75);

    expect(await pruefeBudgets(ctx(), {}, JETZT, a)).toMatchObject({
      neue_alarme: 0,
      zugestellt: 0,
    });
    expect(empfaenger.anfragen).toHaveLength(3);

    const alarme = (await anfrage(admin, 'GET', `/api/v1/alarme?monat=${MONAT}&offen=1`)).json<{
      alarme: Alarm[];
    }>().alarme;
    expect(alarme).toHaveLength(3);
    expect(alarme.every((al) => al.zustellung === 'zugestellt')).toBe(true);
    const q = await anfrage(admin, 'POST', `/api/v1/alarme/${alarme[0]!.id}/quittieren`);
    expect(q.statusCode).toBe(200);
    expect(q.json<Alarm>().quittiert).not.toBeNull();
    expect(await pruefeBudgets(ctx(), {}, JETZT, a)).toMatchObject({ neue_alarme: 0 });
    expect(
      (await anfrage(admin, 'GET', `/api/v1/alarme?monat=${MONAT}&offen=1`)).json<{
        alarme: Alarm[];
      }>().alarme,
    ).toHaveLength(2);

    // Neue Schwelle 120 % (Betrag 200 € → 129 %): genau ein weiterer Alarm, die alten bleiben einmalig.
    const put = await anfrage(admin, 'PUT', `/api/v1/budgets/${budgetX.id}`, {
      projekt_id: x,
      betrag: 200,
      schwellen: [50, 80, 100, 120],
    });
    expect(put.statusCode).toBe(200);
    expect(await pruefeBudgets(ctx(), {}, JETZT, a)).toMatchObject({
      neue_alarme: 1,
      zugestellt: 1,
    });
    expect(await pruefeBudgets(ctx(), {}, JETZT, a)).toMatchObject({ neue_alarme: 0 });
    const zaehlung = await db
      .selectFrom('alarm')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('budget_id', '=', budgetX.id)
      .executeTakeFirstOrThrow();
    expect(Number(zaehlung.n)).toBe(4);
  });

  it('wiederholt fehlgeschlagene Zustellungen und nennt keine Geheimnisse im Fehler', async () => {
    await anfrage(admin, 'POST', '/api/v1/budgets', {
      projekt_id: y,
      betrag: 100,
      waehrung: 'USD',
      schwellen: [100],
    });
    empfaenger.antworten.push({ status: 500 });
    expect(await pruefeBudgets(ctx(), {}, JETZT, a)).toMatchObject({
      neue_alarme: 1,
      fehler: 1,
      zugestellt: 0,
    });
    const offen = (await anfrage(admin, 'GET', `/api/v1/alarme?monat=${MONAT}`)).json<{
      alarme: Alarm[];
    }>().alarme;
    const fehler = offen.find((al) => al.zustellung === 'fehler')!;
    expect(fehler.zustellfehler).toContain('HTTP 500');
    expect(fehler.zustellfehler).not.toContain('geheim');
    expect(await pruefeBudgets(ctx(), {}, JETZT, a)).toMatchObject({
      neue_alarme: 0,
      zugestellt: 1,
      fehler: 0,
    });
  });

  it('ohne Kanal: Alarm entsteht und bleibt als „ohne_kanal“ stehen', async () => {
    const pc = await legeProjektAn(db, c, `c-${randomUUID().slice(0, 6)}`);
    await tagAggregat(db, c, [{ tag: '2026-10-05', person: null, projekt: pc, usd: 10 }]);
    await anfrage(adminC, 'POST', '/api/v1/budgets', {
      projekt_id: pc,
      betrag: 5,
      waehrung: 'USD',
    });
    expect(await pruefeBudgets(ctx(), {}, JETZT, c)).toMatchObject({
      neue_alarme: 3,
      ohne_kanal: 3,
    });
    const al = (await anfrage(adminC, 'GET', '/api/v1/alarme')).json<{ alarme: Alarm[] }>().alarme;
    expect(al.map((z) => z.zustellung)).toEqual(['ohne_kanal', 'ohne_kanal', 'ohne_kanal']);
  });

  it('Alarmkanäle: Geheimnis nur verschlüsselt, PUT ohne Geheimnis behält es, Test über Relay /dm', async () => {
    const liste = (await anfrage(admin, 'GET', '/api/v1/alarmkanal')).json<{
      kanaele: Kanal[];
    }>().kanaele;
    const webhook = liste[0]!;
    expect(webhook.geheimnis_gesetzt).toBe(true);
    const roh = await withMandant(db, a, (trx) =>
      trx
        .selectFrom('alarm_kanal')
        .select('geheimnis')
        .where('id', '=', webhook.id)
        .executeTakeFirstOrThrow(),
    );
    expect(roh.geheimnis!.toString('latin1')).not.toContain('geheim-token-123');
    const put = await anfrage(admin, 'PUT', `/api/v1/alarmkanal/${webhook.id}`, {
      typ: 'webhook',
      bezeichnung: 'Webhook neu',
      aktiv: false,
      konfig: { url: `${empfaenger.url}/hook` },
    });
    expect(put.json<Kanal>()).toMatchObject({
      bezeichnung: 'Webhook neu',
      aktiv: false,
      geheimnis_gesetzt: true,
    });

    const relay = await anfrage(admin, 'POST', '/api/v1/alarmkanal', {
      typ: 'weeberwrk-relay',
      bezeichnung: 'Relay',
      konfig: { url: empfaenger.url, pfad: '/dm', prio: 'normal' },
      geheimnis: 'relay-token-xyz',
    });
    expect(relay.statusCode).toBe(201);
    const vorher = empfaenger.anfragen.length;
    const test = await anfrage(admin, 'POST', `/api/v1/alarmkanal/${relay.json<Kanal>().id}/test`);
    expect(test.json()).toEqual({
      ok: true,
      meldung: 'Relay erreicht (Testmodus, keine Nachricht)',
    });
    const e = empfaenger.anfragen[vorher]!;
    expect(e.pfad).toBe('/dm');
    expect(e.header['x-relay-token']).toBe('relay-token-xyz');
    expect(e.koerper).toMatchObject({ prio: 'normal', test: true });
    expect((e.koerper as { text: string }).text).toMatch(
      /^\[seatmeter \(Testnachricht\)\]\(http:\/\/seatmeter\.test\)\n- /,
    );
    expect((await anfrage(controller, 'GET', '/api/v1/alarmkanal')).statusCode).toBe(403);
    expect(
      (
        await anfrage(admin, 'POST', '/api/v1/alarmkanal', {
          typ: 'webhook',
          bezeichnung: 'x',
          konfig: { url: 'ftp://x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('Relay /alert und SMTP (Fake-Versand); Fehlertexte ohne Geheimnisse', async () => {
    const n = {
      schluessel: 's|1',
      titel: 'Budget-Alarm 80 %',
      zeilen: ['Budget: x'],
      link: 'http://seatmeter.test/budgets',
      daten: {},
    };
    const vorher = empfaenger.anfragen.length;
    await zustellen(
      {
        id: '1',
        typ: 'weeberwrk-relay',
        bezeichnung: 'r',
        konfig: { url: empfaenger.url, pfad: '/alert' },
        geheimnis: 't',
      },
      n,
    );
    expect(empfaenger.anfragen[vorher]!.koerper).toMatchObject({
      key: 's|1',
      topic: 'seatmeter',
      prio: 'normal',
      ttl_aktion: 'expire',
    });
    const mails: unknown[] = [];
    await zustellen(
      {
        id: '2',
        typ: 'smtp',
        bezeichnung: 'm',
        konfig: {
          host: 'smtp.example.org',
          von: 'seatmeter@example.org',
          an: ['team@example.org'],
        },
        geheimnis: 'pw',
      },
      n,
      { smtp: () => ({ sendMail: async (m) => mails.push(m) }) },
    );
    expect(mails[0]).toMatchObject({
      from: 'seatmeter@example.org',
      to: ['team@example.org'],
      subject: 'seatmeter: Budget-Alarm 80 %',
    });
    const fehler = await zustellen(
      {
        id: '3',
        typ: 'smtp',
        bezeichnung: 'm',
        konfig: {
          host: 'smtp.example.org',
          benutzer: 'u',
          von: 'a@example.org',
          an: ['b@example.org'],
        },
        geheimnis: 'sehr-geheim',
      },
      n,
      {
        smtp: () => ({
          sendMail: async () =>
            Promise.reject(Object.assign(new Error('auth sehr-geheim'), { code: 'EAUTH' })),
        }),
      },
    ).catch((e: unknown) => e);
    expect(fehler).toBeInstanceOf(ZustellFehler);
    expect((fehler as Error).message).toBe('SMTP-Versand fehlgeschlagen (EAUTH)');
  });

  it('RLS: Mandant B sieht und ändert nichts von A', async () => {
    expect(
      (await anfrage(adminB, 'GET', `/api/v1/budgets?monat=${MONAT}`)).json<BudgetListe>().budgets,
    ).toEqual([]);
    expect(
      (await anfrage(adminB, 'GET', '/api/v1/alarme')).json<{ alarme: Alarm[] }>().alarme,
    ).toEqual([]);
    expect(
      (await anfrage(adminB, 'GET', '/api/v1/alarmkanal')).json<{ kanaele: Kanal[] }>().kanaele,
    ).toEqual([]);
    expect(
      (
        await anfrage(adminB, 'PUT', `/api/v1/budgets/${budgetX.id}`, {
          projekt_id: null,
          betrag: 1,
        })
      ).statusCode,
    ).toBe(404);
    expect((await anfrage(adminB, 'DELETE', `/api/v1/budgets/${budgetX.id}`)).statusCode).toBe(404);
    const alarmA = await db
      .selectFrom('alarm')
      .select('id')
      .where('mandant_id', '=', a)
      .executeTakeFirstOrThrow();
    expect(
      (await anfrage(adminB, 'POST', `/api/v1/alarme/${alarmA.id}/quittieren`)).statusCode,
    ).toBe(404);
    const kanaeleB = await withMandant(db, b, (trx) =>
      trx.selectFrom('alarm_kanal').select('id').execute(),
    );
    expect(kanaeleB).toEqual([]);
    expect(await pruefeBudgets(ctx(), {}, JETZT, b)).toMatchObject({ budgets: 0, neue_alarme: 0 });
  });

  it('löscht ein Budget samt Alarmen (Audit)', async () => {
    const r = await anfrage(admin, 'DELETE', `/api/v1/budgets/${budgetX.id}`);
    expect(r.statusCode).toBe(204);
    expect(
      await db.selectFrom('budget').select('id').where('id', '=', budgetX.id).execute(),
    ).toEqual([]);
    const rest = await db
      .selectFrom('alarm')
      .select('id')
      .where('budget_id', '=', budgetX.id)
      .execute();
    expect(rest).toEqual([]);
    const audit = await db
      .selectFrom('audit')
      .select('aktion')
      .where('mandant_id', '=', a)
      .execute();
    expect(audit.map((z) => z.aktion)).toEqual(
      expect.arrayContaining([
        'Budget angelegt',
        'Budget geändert',
        'Budget gelöscht',
        'Alarm quittiert',
        'Alarmkanal angelegt',
      ]),
    );
  });
});
