// Projektkatalog: Import (JSON, CSV), Zuordnung ohne Umschreiben der Nutzung, Kosten je Katalog-Projekt mit
// mehreren Repos und Sitzungen ohne Repo, eingefrorene Monate, Prüf-Route des Hooks, signierter Link,
// Auswahlseite (erste Wahl gilt), Rechte der Rolle `entwickler` und Trennung der Mandanten.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  kanonischeRepoInfo,
  projektwahlHookBefehl,
  PROJEKTWAHL_TOKEN_VARIABLE,
  katalogEinstellungSchema,
  katalogImportErgebnisSchema,
  katalogKostenAntwortSchema,
  katalogListeSchema,
  katalogZuordnungAntwortSchema,
  projekteAntwortSchema,
  projektwahlAntwortSchema,
  projektwahlErgebnisSchema,
  PROJEKTWAHL_PFAD_PRAEFIX,
  PROJEKTWAHL_PRUEF_PFAD,
  type Rolle,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { schliesseMonat } from '../src/kalkulation/abschluss.js';
import { logSerializer } from '../src/app.js';
import {
  LINK_GUELTIG_MS,
  linkTokenErzeugen,
  linkTokenPruefen,
} from '../src/projektkatalog/index.js';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import { mandantKontextLaden } from '../src/ingest-gemeinsam/kontext.js';
import { projektAufloesen } from '../src/ingest-gemeinsam/speichern.js';
import { mandantKontoAnmelden, type MandantOidc } from '../src/oidc/mandant.js';
import { rollenAbgleichen } from '../src/oidc/rollen.js';
import { stufeCli } from '../src/projektkatalog/cli-stufe.js';
import {
  kernApp,
  legeProjektAn,
  MASTER_KEY_B64,
  meldeAn,
  legePersonAn,
  testKonfiguration,
} from './api-hilfen.js';
import { M, tagAggregat } from './modul-hilfen.js';

// Der laufende Monat, nie der Vormonat: Der Job des Monatsabschlusses in anderen Testdateien schließt den Vormonat für
// alle Mandanten, das friert hier die Kosten mitten im Test ein. Anfrage-Partitionen gibt es ab dem Migrationsmonat.
const MONAT = new Date().toISOString().slice(0, 7);
const TAG = `${MONAT}-15`;
const FOLGEMONAT = new Date(Date.UTC(Number(MONAT.slice(0, 4)), Number(MONAT.slice(5, 7)), 1))
  .toISOString()
  .slice(0, 7);
const MASTER = Buffer.from(MASTER_KEY_B64, 'base64');

let db: Db;
let app: FastifyInstance;

interface Umgebung {
  mandantId: string;
  token: string;
  admin: Record<string, string>;
}

async function umgebung(): Promise<Umgebung> {
  const e = await mandantAnlegen(db, MASTER, {
    slug: `t-${randomUUID()}`,
    name: 'Testmandant',
    orgs: [],
  });
  if (!e.token) throw new Error('Token fehlt');
  const admin = await meldeAn(db, e.mandantId, 'mandanten_admin');
  return { mandantId: e.mandantId, token: e.token, admin: admin.headers };
}

const PROJEKTE = [
  { nummer: 'P-100', name: 'Webshop', kunde: 'Muster AG' },
  { nummer: 'P-200', name: 'Portal', kunde: 'Beispiel GmbH' },
  { nummer: 'P-300', name: 'Intern' },
];

async function importieren(u: Umgebung, projekte: unknown = PROJEKTE, vollstaendig = true) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/projektkatalog/import',
    headers: u.admin,
    payload: { projekte, vollstaendig },
  });
}

async function katalogIds(u: Umgebung): Promise<Record<string, string>> {
  const r = await app.inject({
    url: '/api/v1/projektkatalog/projekte?aktiv=0',
    headers: u.admin,
  });
  const l = katalogListeSchema.parse(r.json());
  return Object.fromEntries(l.projekte.map((p) => [p.nummer, p.id]));
}

async function erzwingen(u: Umgebung, wert = true) {
  const r = await app.inject({
    method: 'PUT',
    url: '/api/v1/projektkatalog/einstellung',
    headers: u.admin,
    payload: { stufe: wert ? 'blockieren' : 'aus' },
  });
  expect(r.statusCode).toBe(200);
}

function pruefen(token: string, sitzung: string, repo = '') {
  return app.inject({
    method: 'POST',
    url: PROJEKTWAHL_PRUEF_PFAD,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ sitzung, repo }).toString(),
  });
}

function tokenAusLink(text: string): string {
  const link = text.trim().replace(/^waehlen /, '');
  const i = link.indexOf(PROJEKTWAHL_PFAD_PRAEFIX);
  expect(i).toBeGreaterThan(0);
  return link.slice(i + PROJEKTWAHL_PFAD_PRAEFIX.length);
}

function zuordnen(u: Umgebung, projektId: string, katalogId: string | null, kopf = u.admin) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/projektkatalog/zuordnung',
    headers: kopf,
    payload: { zuordnung: [{ projekt_id: projektId, katalog_projekt_id: katalogId }] },
  });
}

async function kosten(u: Umgebung, monat = MONAT, kopf = u.admin) {
  const r = await app.inject({
    url: `/api/v1/projektkatalog/kosten?monat=${monat}`,
    headers: kopf,
  });
  expect(r.statusCode).toBe(200);
  return katalogKostenAntwortSchema.parse(r.json());
}

/** Einzelanfrage ohne Repo (für Sitzungen ohne Repo), direkt im Mandanten angelegt. */
async function anfrageOhneRepo(mandantId: string, personId: string, sessionId: string) {
  await withMandant(db, mandantId, async (trx) => {
    await sql`
      INSERT INTO anfrage (mandant_id, anfrage_key, ts, tag, session_id, person_id, projekt_id, model,
        auth_klasse, zaehlt_als_abo, input, output, cache_read, cache_write, quellen)
      VALUES (${mandantId}::uuid, ${`msg:${randomUUID()}`}, ${`${TAG}T10:00:00Z`}::timestamptz, ${TAG}::date,
        ${sessionId}, ${personId}::uuid, NULL, 'claude-opus-5-5', 'abo', true, 1000, 500, 0, 0, 1)`.execute(
      trx,
    );
  });
}

beforeAll(async () => {
  const url = inject('testDatenbankUrl');
  db = erstelleDb(url, 4);
  app = await kernApp(db, url);
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

describe('Import', () => {
  it('legt an, aktualisiert und deaktiviert fehlende Projekte bei vollständiger Liste', async () => {
    const u = await umgebung();
    const erst = katalogImportErgebnisSchema.parse((await importieren(u)).json());
    expect(erst).toMatchObject({ neu: 3, aktualisiert: 0, deaktiviert: 0, aktiv_gesamt: 3 });

    const zweit = katalogImportErgebnisSchema.parse(
      (await importieren(u, [{ nummer: 'P-100', name: 'Webshop neu', kunde: 'Muster AG' }])).json(),
    );
    expect(zweit).toMatchObject({ neu: 0, aktualisiert: 1, deaktiviert: 2, aktiv_gesamt: 1 });

    const teil = katalogImportErgebnisSchema.parse(
      (await importieren(u, [{ nummer: 'P-400', name: 'Neu' }], false)).json(),
    );
    expect(teil).toMatchObject({ neu: 1, deaktiviert: 0, aktiv_gesamt: 2 });

    const aktiv = katalogListeSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/projekte', headers: u.admin })).json(),
    );
    expect(aktiv.projekte.map((p) => p.nummer)).toEqual(['P-400', 'P-100']);
    expect(aktiv.projekte.find((p) => p.nummer === 'P-100')?.name).toBe('Webshop neu');
    expect(aktiv.projekte[0]?.quelle).toBe('json');
  });

  it('lehnt leere Listen und ungültige Einträge ab', async () => {
    const u = await umgebung();
    expect((await importieren(u, [])).statusCode).toBe(400);
    expect((await importieren(u, [{ nummer: '', name: 'x' }])).statusCode).toBe(400);
    expect((await importieren(u, [{ nummer: 'A', name: 'x', extra: 1 }])).statusCode).toBe(400);
  });

  it('CSV über die JSON-Route: ganze Datei falsch ändert nichts, schlechte Zeile nur diese', async () => {
    const u = await umgebung();
    await importieren(u);
    const kaputt = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv: 'Titel;Kunde\nA;B\n' },
    });
    expect(kaputt.statusCode).toBe(400);
    expect(kaputt.json<{ fehler: string }>().fehler).toContain('Kopfzeile');
    // Der abgelehnte Import hat nichts deaktiviert.
    const e = katalogEinstellungSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/einstellung', headers: u.admin })).json(),
    );
    expect(e.projekte_aktiv).toBe(3);

    const teils = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv: 'Nummer;Name\nP-9;Neun\nP-8;\n', vollstaendig: false },
    });
    expect(katalogImportErgebnisSchema.parse(teils.json())).toMatchObject({
      neu: 1,
      abgelehnt: 1,
      aktiv_gesamt: 4,
    });

    const komma = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv: 'Nummer,Name\nP-7,Sieben\n', trennzeichen: ',', vollstaendig: false },
    });
    expect(katalogImportErgebnisSchema.parse(komma.json())).toMatchObject({ neu: 1 });
  });

  it('nur Mandanten-Admin darf importieren und den Schalter setzen', async () => {
    const u = await umgebung();
    for (const rolle of ['controller', 'projektleiter', 'betriebsrat', 'entwickler'] as const) {
      const s = await meldeAn(db, u.mandantId, rolle);
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/projektkatalog/import',
        headers: s.headers,
        payload: { projekte: PROJEKTE },
      });
      expect(r.statusCode, rolle).toBe(403);
      const e = await app.inject({
        method: 'PUT',
        url: '/api/v1/projektkatalog/einstellung',
        headers: s.headers,
        payload: { stufe: 'blockieren' },
      });
      expect(e.statusCode, rolle).toBe(403);
    }
  });
});

describe('Zuordnung und Kosten', () => {
  it('rollt mehrere Repos auf, wirkt rückwirkend, ändert die Nutzung nicht, zeigt Name und Kunde', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const a = await legeProjektAn(db, u.mandantId, 'shop-backend');
    const b = await legeProjektAn(db, u.mandantId, 'shop-frontend');
    const c = await legeProjektAn(db, u.mandantId, 'unklar');
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: a, usd: 3 },
      { tag: TAG, person, projekt: b, usd: 2 },
      { tag: TAG, person, projekt: c, usd: 1 },
    ]);

    // Vorher: alles offen.
    let k = await kosten(u);
    expect(k.projekte).toEqual([]);
    expect(k.offen.repos.map((r) => r.id).sort()).toEqual([a, b, c].sort());

    expect((await zuordnen(u, a, ids['P-100'] ?? null)).statusCode).toBe(200);
    expect((await zuordnen(u, b, ids['P-100'] ?? null)).statusCode).toBe(200);
    k = await kosten(u);
    expect(k.quelle).toBe('live');
    expect(k.projekte).toHaveLength(1);
    const p = k.projekte[0];
    expect(p?.nummer).toBe('P-100');
    expect(p?.kunde).toBe('Muster AG');
    expect(p?.schatten_usd_micros).toBe(5 * M);
    expect(p?.repos.map((r) => r.id)).toEqual([a, b]);
    expect(k.offen.repos.map((r) => r.id)).toEqual([c]);

    // Nutzungsdaten bleiben unverändert auf dem Repo.
    const roh = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('tag_aggregat').select(['projekt_id']).where('projekt_id', '=', a).execute(),
    );
    expect(roh).toHaveLength(1);

    // Seite „Projekte“ zeigt Katalog-Name und Kunde, ohne Zuordnung den Repo-Namen.
    const liste = projekteAntwortSchema.parse(
      (await app.inject({ url: `/api/v1/projekte?monat=${MONAT}`, headers: u.admin })).json(),
    );
    const zeile = (id: string) => liste.projekte.find((x) => x.id === id);
    expect(zeile(a)?.name).toBe('P-100 Webshop');
    expect(zeile(a)?.kunde).toBe('Muster AG');
    expect(zeile(a)?.url_norm).toContain('shop-backend');
    expect(zeile(c)?.name).toContain('unklar');

    // Korrigierbar: umhängen und entfernen.
    await zuordnen(u, b, ids['P-200'] ?? null);
    k = await kosten(u);
    expect(k.projekte.map((x) => [x.nummer, x.schatten_usd_micros])).toEqual([
      ['P-100', 3 * M],
      ['P-200', 2 * M],
    ]);
    await zuordnen(u, b, null);
    k = await kosten(u);
    expect(k.projekte.map((x) => x.nummer)).toEqual(['P-100']);
    expect(k.offen.repos.map((r) => r.id).sort()).toEqual([b, c].sort());
  });

  it('prüft Projekte und Katalog; inaktive lassen sich nicht neu wählen', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const a = await legeProjektAn(db, u.mandantId, 'a');
    expect((await zuordnen(u, randomUUID(), ids['P-100'] ?? null)).statusCode).toBe(400);
    expect((await zuordnen(u, a, randomUUID())).statusCode).toBe(400);
    await importieren(u, [{ nummer: 'P-200', name: 'Portal' }]);
    expect((await zuordnen(u, a, ids['P-100'] ?? null)).statusCode).toBe(400);
    expect((await zuordnen(u, a, ids['P-200'] ?? null)).statusCode).toBe(200);
  });

  it('Projektleiter sehen und ändern nur eigene Repos; Controller nur Kosten', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const eigen = await legeProjektAn(db, u.mandantId, 'eigen');
    const fremd = await legeProjektAn(db, u.mandantId, 'fremd');
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: eigen, usd: 1 },
      { tag: TAG, person, projekt: fremd, usd: 4 },
    ]);
    await zuordnen(u, fremd, ids['P-200'] ?? null);

    const leiter = await meldeAn(db, u.mandantId, 'projektleiter', [eigen]);
    const z = katalogZuordnungAntwortSchema.parse(
      (
        await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: leiter.headers })
      ).json(),
    );
    expect(z.zuordnung.map((x) => x.projekt_id)).toEqual([eigen]);
    expect((await zuordnen(u, fremd, null, leiter.headers)).statusCode).toBe(403);
    expect((await zuordnen(u, eigen, ids['P-100'] ?? null, leiter.headers)).statusCode).toBe(200);
    const sicht = await kosten(u, MONAT, leiter.headers);
    expect(sicht.projekte.map((p) => p.nummer)).toEqual(['P-100']);
    expect(sicht.offen.repos).toEqual([]);

    const controller = await meldeAn(db, u.mandantId, 'controller');
    expect((await kosten(u, MONAT, controller.headers)).projekte).toHaveLength(2);
    expect((await zuordnen(u, eigen, null, controller.headers)).statusCode).toBe(403);
    const br = await meldeAn(db, u.mandantId, 'betriebsrat');
    const verboten = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}`,
      headers: br.headers,
    });
    expect(verboten.statusCode).toBe(403);
  });

  it('Projektleitung mit weiterer Rolle: keine Sicht und kein Schreiben über die Zuordnung', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const a = await legeProjektAn(db, u.mandantId, 'a');
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person, projekt: a, usd: 1 }]);
    const mix = await meldeAn(db, u.mandantId, 'projektleiter', [a]);
    await db
      .insertInto('rolle')
      .values({ mandant_id: u.mandantId, benutzer_id: mix.benutzerId, rolle: 'controller' })
      .execute();
    const z = await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: mix.headers });
    expect(katalogZuordnungAntwortSchema.parse(z.json()).zuordnung).toEqual([]);
    const r = await zuordnen(u, a, ids['P-100'] ?? null, mix.headers);
    expect(r.statusCode).toBe(403);
    // Admin bleibt unbeschränkt, auch mit weiterer Rolle.
    const adminMix = await meldeAn(db, u.mandantId, 'mandanten_admin');
    await db
      .insertInto('rolle')
      .values({ mandant_id: u.mandantId, benutzer_id: adminMix.benutzerId, rolle: 'projektleiter' })
      .execute();
    expect((await zuordnen(u, a, ids['P-100'] ?? null, adminMix.headers)).statusCode).toBe(200);
  });

  it('offen ohne Repo: aus den Einzelanfragen, auch bevor das Tagesaggregat sie kennt', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const person = await legePersonAn(db, u.mandantId);
    await anfrageOhneRepo(u.mandantId, person, 's-offen');
    await anfrageOhneRepo(u.mandantId, person, 's-gewaehlt');
    await withMandant(db, u.mandantId, (t) =>
      t
        .insertInto('sitzung_katalog')
        .values({
          mandant_id: u.mandantId,
          session_id: 's-gewaehlt',
          katalog_projekt_id: ids['P-100'] ?? '',
        })
        .execute(),
    );
    // Kein Tagesaggregat: Tagsüber liefe es hinterher.
    const k = await kosten(u);
    expect(k.offen.ohne_repo.anfragen).toBe(1);
    expect(k.projekte.find((p) => p.nummer === 'P-100')?.ohne_repo.anfragen).toBe(1);
    // Aggregat vorhanden: nichts doppelt.
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person, projekt: null, usd: 1 }]);
    const mitAggregat = await kosten(u);
    expect(mitAggregat.offen.ohne_repo.anfragen).toBe(1);
    // Einzelanfragen gelöscht: Was nur noch im Aggregat steht, bleibt offen sichtbar.
    await sql`DELETE FROM anfrage WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    const danach = await kosten(u);
    expect(danach.offen.ohne_repo.schatten_usd_micros).toBeGreaterThan(0);
  });

  it('erneuter Abschluss nach gelöschten Einzelanfragen behält die Sitzungen ohne Repo', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const person = await legePersonAn(db, u.mandantId);
    const repo = await legeProjektAn(db, u.mandantId, 'shop');
    await zuordnen(u, repo, ids['P-200'] ?? null);
    await anfrageOhneRepo(u.mandantId, person, 's-1');
    await withMandant(db, u.mandantId, (t) =>
      t
        .insertInto('sitzung_katalog')
        .values({
          mandant_id: u.mandantId,
          session_id: 's-1',
          katalog_projekt_id: ids['P-100'] ?? '',
        })
        .execute(),
    );
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: null, usd: 1 },
      { tag: TAG, person, projekt: repo, usd: 2 },
    ]);
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    const vorher = await kosten(u);
    const p100 = vorher.projekte.find((p) => p.nummer === 'P-100');
    expect(p100?.sitzungen_ohne_repo).toBe(1);
    expect(vorher.quelle).toBe('monatsabschluss');

    // Aufbewahrung: Einzelanfragen und Sitzungswahl sind weg, das Tagesaggregat bleibt.
    await sql`DELETE FROM anfrage WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    await sql`DELETE FROM sitzung_katalog WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    const nachher = await kosten(u);
    expect(nachher.projekte.find((p) => p.nummer === 'P-100')?.ohne_repo).toEqual(p100?.ohne_repo);
    expect(nachher.offen.ohne_repo).toEqual(vorher.offen.ohne_repo);
    // Repos rechnet der erneute Abschluss weiter neu.
    expect(nachher.projekte.find((p) => p.nummer === 'P-200')?.repos).toHaveLength(1);
  });

  it('CSV enthält auch das Offene: Die Zeilen ergeben die Summe der Seite', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const person = await legePersonAn(db, u.mandantId);
    const a = await legeProjektAn(db, u.mandantId, 'zugeordnet');
    const b = await legeProjektAn(db, u.mandantId, 'offen');
    await zuordnen(u, a, ids['P-100'] ?? null);
    await anfrageOhneRepo(u.mandantId, person, 's-1');
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: a, usd: 3 },
      { tag: TAG, person, projekt: b, usd: 2 },
    ]);
    const k = await kosten(u);
    const r = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}&format=csv`,
      headers: u.admin,
    });
    const zeilen = r.body
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((z) => z.split(/[;,]/));
    const anfragenSpalte = zeilen.map((z) => Number(z[7]));
    const seite =
      k.projekte.reduce((n, p) => n + p.anfragen, 0) +
      k.offen.repos.reduce((n, x) => n + x.anfragen, 0) +
      k.offen.ohne_repo.anfragen;
    expect(anfragenSpalte.reduce((x, y) => x + y, 0)).toBe(seite);
    expect(zeilen.some((z) => z[1] === '' && z[5]?.includes('offen'))).toBe(true);
    expect(zeilen.some((z) => z[1] === '' && z[5]?.includes('ohne Repo'))).toBe(true);
  });

  it('CSV-Beträge auf Mikro-USD genau: Kleine Beträge verschwinden nicht, die Summe stimmt mit der Seite', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const person = await legePersonAn(db, u.mandantId);
    const zeilen = [];
    for (let i = 0; i < 5; i += 1) {
      const projekt = await legeProjektAn(db, u.mandantId, `klein-${i}`);
      await zuordnen(u, projekt, ids['P-100'] ?? null);
      zeilen.push({ tag: TAG, person, projekt, usd: 0.0022 });
    }
    await tagAggregat(db, u.mandantId, zeilen);
    const k = await kosten(u);
    const micros = k.projekte[0]?.schatten_usd_micros;
    expect(micros).toBe(11_000);
    const r = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}&format=csv`,
      headers: u.admin,
    });
    const betraege = r.body
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((z) => z.split(';').at(-1) ?? '');
    expect(betraege).toEqual(Array(5).fill('0,002200'));
    const summe = betraege.reduce((n, b) => n + Math.round(Number(b.replace(',', '.')) * 1e6), 0);
    expect(summe).toBe(micros);
  });

  it('abgeschlossener Monat bleibt eingefroren, auch nach Korrektur und Import', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const a = await legeProjektAn(db, u.mandantId, 'a');
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person, projekt: a, usd: 3 }]);
    await zuordnen(u, a, ids['P-100'] ?? null);

    await schliesseMonat(db, u.mandantId, MONAT);
    const vorher = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('monatsabschluss').select(['projekt_id', 'schatten_usd_micros']).execute(),
    );

    await zuordnen(u, a, ids['P-200'] ?? null);
    await importieren(u, [
      { nummer: 'P-100', name: 'Umbenannt' },
      { nummer: 'P-200', name: 'Portal' },
    ]);

    const k = await kosten(u);
    expect(k.quelle).toBe('monatsabschluss');
    expect(k.projekte.map((p) => [p.nummer, p.name, p.kunde, p.schatten_usd_micros])).toEqual([
      ['P-100', 'Webshop', 'Muster AG', 3 * M],
    ]);
    const nachher = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('monatsabschluss').select(['projekt_id', 'schatten_usd_micros']).execute(),
    );
    expect(nachher).toEqual(vorher);

    // Live gilt die neue Zuordnung für offene Monate.
    await tagAggregat(db, u.mandantId, [{ tag: `${FOLGEMONAT}-03`, person, projekt: a, usd: 1 }]);
    const offen = await kosten(u, FOLGEMONAT);
    expect(offen.quelle).toBe('live');
    expect(offen.projekte.find((p) => p.schatten_usd_micros > 0)?.nummer).toBe('P-200');

    // Erneuter Abschluss ersetzt den Stand.
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    expect((await kosten(u)).projekte.map((p) => p.nummer)).toEqual(['P-200']);
  });

  it('Abschluss ohne jede Zuordnung friert nichts ein: spätere Zuordnung wirkt', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const a = await legeProjektAn(db, u.mandantId, 'a');
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person, projekt: a, usd: 3 }]);
    await schliesseMonat(db, u.mandantId, MONAT);
    await zuordnen(u, a, ids['P-100'] ?? null);
    const k = await kosten(u);
    expect(k.quelle).toBe('live');
    expect(k.projekte[0]?.schatten_usd_micros).toBe(3 * M);
  });

  it('CSV-Export protokolliert und schützt vor Formeln', async () => {
    const u = await umgebung();
    await importieren(u, [{ nummer: '=HACK()', name: 'x' }]);
    const ids = await katalogIds(u);
    const a = await legeProjektAn(db, u.mandantId, 'a');
    await zuordnen(u, a, ids['=HACK()'] ?? null);
    const r = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}&format=csv`,
      headers: u.admin,
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain("'=HACK()");
    const audit = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('audit')
        .select('aktion')
        .where('aktion', '=', 'Export Katalog-Kosten')
        .execute(),
    );
    expect(audit).toHaveLength(1);
  });
});

describe('Prüf-Route des Hooks', () => {
  it('braucht ein Token und antwortet „frei“, solange nicht erzwungen oder der Katalog leer ist', async () => {
    const u = await umgebung();
    const ohne = await app.inject({
      method: 'POST',
      url: PROJEKTWAHL_PRUEF_PFAD,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'sitzung=abc',
    });
    expect(ohne.statusCode).toBe(401);
    expect((await pruefen(u.token, 'abc')).body).toBe('frei\n');
    await erzwingen(u);
    expect((await pruefen(u.token, 'abc')).body).toBe('frei\n');
    await importieren(u);
    await erzwingen(u, false);
    expect((await pruefen(u.token, 'abc')).body).toBe('frei\n');
  });

  it('lehnt ungültige Eingaben ab; der Prompt hat kein Feld und landet nie im Log', async () => {
    const u = await umgebung();
    expect((await pruefen(u.token, 'mit leerzeichen')).statusCode).toBe(400);
    const r = await app.inject({
      method: 'POST',
      url: PROJEKTWAHL_PRUEF_PFAD,
      headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ sitzung: 'abc', prompt: 'GEHEIM' }),
    });
    expect(r.statusCode).toBe(415);
  });

  describe('scp-Remotes: echter Hook, dann Prüfung und Wahl', () => {
    /** Führt den erzeugten Hook in bash aus, mit Nachbauten von git und curl, und liefert, was er als Repo sendet. */
    const hookSendet = (remote: string): string => {
      const ordner = mkdtempSync(join(tmpdir(), 'projektwahl-e2e-'));
      try {
        const bin = join(ordner, 'bin');
        mkdirSync(bin);
        const protokoll = join(ordner, 'curl.log');
        for (const [name, inhalt] of [
          ['git', `#!/bin/bash\nprintf '%s\\n' '${remote}'\n`],
          [
            'curl',
            `#!/bin/bash\nprintf ' [%s]' "$@" >> '${protokoll}'\ncat >/dev/null\necho frei\n`,
          ],
        ] as const) {
          writeFileSync(join(bin, name), inhalt);
          chmodSync(join(bin, name), 0o755);
        }
        const r = spawnSync(
          'bash',
          ['-c', projektwahlHookBefehl({ ingestUrl: 'https://ingest.example.org' })],
          {
            input: JSON.stringify({ session_id: 'sitzung-e2e', prompt: 'nie senden' }),
            encoding: 'utf8',
            cwd: ordner,
            env: {
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              HOME: ordner,
              TMPDIR: ordner,
              [PROJEKTWAHL_TOKEN_VARIABLE]: 'smi_erfunden',
            },
          },
        );
        expect(r.status, r.stderr).toBe(0);
        const gesendet = /\[repo=([^\]]*)\]/.exec(readFileSync(protokoll, 'utf8'))?.[1];
        if (gesendet === undefined) throw new Error('Hook hat kein Repo gesendet');
        return gesendet;
      } finally {
        rmSync(ordner, { recursive: true, force: true });
      }
    };
    const TOKEN_ALS_NUTZER = 'ghp_ERFUNDEN123';

    it('git@, Token als Nutzer und gewöhnliches scp treffen dasselbe Repo; der Token kommt nie an', async () => {
      const u = await umgebung();
      await importieren(u);
      await erzwingen(u);
      const ids = await katalogIds(u);
      const entwickler = await meldeAn(db, u.mandantId, 'entwickler');

      const gesendet = hookSendet(`${TOKEN_ALS_NUTZER}@git.example.org:firma/a.git`);
      expect(gesendet).toBe('git@git.example.org:firma/a.git');
      const r = await pruefen(u.token, 'sitzung-1', gesendet);
      const wahl = await app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token: tokenAusLink(r.body), katalog_projekt_id: ids['P-100'] },
      });
      expect(wahl.statusCode, wahl.body).toBe(200);

      for (const remote of [
        `${TOKEN_ALS_NUTZER}@git.example.org:firma/a.git`,
        'git@git.example.org:firma/a.git',
        'deploy@git.example.org:firma/a',
        'git.example.org:firma/a.git',
        'https://git.example.org/firma/a',
      ]) {
        const repo = hookSendet(remote);
        expect(repo, remote).not.toContain(TOKEN_ALS_NUTZER);
        expect((await pruefen(u.token, 'sitzung-2', repo)).body, remote).toBe('zugeordnet\n');
      }
      const projekte = await withMandant(db, u.mandantId, (t) =>
        t.selectFrom('projekt').selectAll().execute(),
      );
      expect(projekte).toHaveLength(1);
      expect(JSON.stringify(projekte)).not.toContain(TOKEN_ALS_NUTZER);
    });

    it('der Server bildet denselben Schlüssel wie zuvor: Eine Wahl aus dem alten Hook gilt weiter', async () => {
      for (const roh of [
        `${TOKEN_ALS_NUTZER}@git.example.org:firma/b.git`,
        'git@git.example.org:firma/b.git',
        'git.example.org:firma/b.git',
      ]) {
        expect(kanonischeRepoInfo(roh)?.urlNorm, roh).toBe('https://git.example.org/firma/b');
      }
      const u = await umgebung();
      await importieren(u);
      await erzwingen(u);
      const ids = await katalogIds(u);
      const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
      // So sendete der Hook bisher: mit dem Nutzer.
      const alt = await pruefen(u.token, 'sitzung-1', `deploy@git.example.org:firma/b.git`);
      const wahl = await app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token: tokenAusLink(alt.body), katalog_projekt_id: ids['P-200'] },
      });
      expect(wahl.statusCode, wahl.body).toBe(200);
      const neu = hookSendet('deploy@git.example.org:firma/b.git');
      expect(neu).toBe('git@git.example.org:firma/b.git');
      expect((await pruefen(u.token, 'sitzung-2', neu)).body).toBe('zugeordnet\n');
    });
  });

  it('Repo ohne Zuordnung: Link; nach der Wahl „zugeordnet“, auch für andere Sitzungen und URL-Formen', async () => {
    const u = await umgebung();
    await importieren(u);
    await erzwingen(u);
    const ids = await katalogIds(u);
    const entwickler = await meldeAn(db, u.mandantId, 'entwickler');

    const r = await pruefen(u.token, 'sitzung-1', 'git@git.example.org:firma/shop.git');
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toMatch(/^waehlen http:\/\/seatmeter\.test\/projektwahl\/[\w.-]+\n$/);
    const token = tokenAusLink(r.body);

    const seite = await app.inject({
      url: `/api/v1/projektwahl?token=${token}`,
      headers: entwickler.headers,
    });
    expect(seite.statusCode).toBe(200);
    const d = projektwahlAntwortSchema.parse(seite.json());
    expect(d.ziel).toEqual({ art: 'repo', name: 'firma/shop' });
    expect(d.zugeordnet).toBeNull();
    expect(d.projekte.map((p) => p.nummer)).toEqual(['P-300', 'P-200', 'P-100']);

    const wahl = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: entwickler.headers,
      payload: { token, katalog_projekt_id: ids['P-100'] },
    });
    expect(wahl.statusCode).toBe(200);
    expect(projektwahlErgebnisSchema.parse(wahl.json()).zugeordnet.nummer).toBe('P-100');

    for (const [sitzung, repo] of [
      ['sitzung-1', 'git@git.example.org:firma/shop.git'],
      ['sitzung-2', 'https://git.example.org/firma/shop'],
      ['sitzung-3', 'ssh://git@git.example.org:2222/firma/shop.git'],
    ] as const) {
      expect((await pruefen(u.token, sitzung, repo)).body, repo).toBe('zugeordnet\n');
    }

    // Die erste Wahl gilt; eine zweite wird abgelehnt und ändert nichts.
    const zweite = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: (await meldeAn(db, u.mandantId, 'mandanten_admin')).headers,
      payload: { token, katalog_projekt_id: ids['P-200'] },
    });
    expect(zweite.statusCode).toBe(409);
    expect(zweite.json<{ code: string }>().code).toBe('bereits_zugeordnet');
    const z = katalogZuordnungAntwortSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: u.admin })).json(),
    );
    expect(z.zuordnung[0]?.katalog?.nummer).toBe('P-100');

    // Im Audit steht die Wahl, aber kein Konto.
    const audit = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('audit')
        .select(['benutzer_id', 'objekt'])
        .where('aktion', '=', 'Projekt gewählt')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.benutzer_id).toBeNull();
    expect(audit[0]?.objekt).toContain('katalog:P-100');
  });

  it('Stufen: aus frei, warnen mit Link ohne Block, blockieren mit Link', async () => {
    const u = await umgebung();
    await importieren(u);
    const setzen = (stufe: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/v1/projektkatalog/einstellung',
        headers: u.admin,
        payload: { stufe },
      });
    const repo = 'https://git.example.org/o/r';
    expect((await pruefen(u.token, 's1', repo)).body).toBe('frei\n');
    expect((await setzen('warnen')).statusCode).toBe(200);
    expect((await pruefen(u.token, 's1', repo)).body).toMatch(
      /^warnen http:\/\/seatmeter\.test\/projektwahl\/[\w-]+\n$/,
    );
    expect((await setzen('blockieren')).statusCode).toBe(200);
    expect((await pruefen(u.token, 's1', repo)).body).toMatch(/^waehlen /);
    expect((await setzen('vielleicht')).statusCode).toBe(400);
    const audit = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('audit').select('objekt').where('objekt', 'like', 'stufe:%').execute(),
    );
    expect(audit.map((a) => a.objekt).sort()).toEqual(['stufe:blockieren', 'stufe:warnen']);
  });

  it('Header-Modus mit Admin als Auto-Rolle: Stufe verweigert, Prüf-Route frei, Seite zeigt es', async () => {
    const url = inject('testDatenbankUrl');
    const proxy = await kernApp(db, url, { SEATMETER_TRUST_REMOTE_USER_HEADER: 'remote-email' });
    try {
      const u = await umgebung();
      await importieren(u);
      for (const stufe of ['warnen', 'blockieren']) {
        const r = await proxy.inject({
          method: 'PUT',
          url: '/api/v1/projektkatalog/einstellung',
          headers: u.admin,
          payload: { stufe },
        });
        expect(r.statusCode, stufe).toBe(409);
        expect(r.json<{ hinderung: string }>().hinderung).toBe('auto_rolle');
      }
      const aus = await proxy.inject({
        method: 'PUT',
        url: '/api/v1/projektkatalog/einstellung',
        headers: u.admin,
        payload: { stufe: 'aus' },
      });
      expect(aus.statusCode).toBe(200);
      expect(katalogEinstellungSchema.parse(aus.json()).hinderung).toBe('auto_rolle');
      // Schon aktive Stufe (z. B. Konfiguration später geändert): niemand wird aufgehalten.
      await withMandant(db, u.mandantId, (t) =>
        t.updateTable('mandant_projektkatalog').set({ stufe: 'blockieren' }).execute(),
      );
      const r = await proxy.inject({
        method: 'POST',
        url: PROJEKTWAHL_PRUEF_PFAD,
        headers: {
          authorization: `Bearer ${u.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'sitzung=abc&repo=https://git.example.org/o/r',
      });
      expect(r.body).toBe('frei\n');
    } finally {
      await proxy.close();
    }
    const entwickler = await kernApp(db, url, {
      SEATMETER_TRUST_REMOTE_USER_HEADER: 'remote-email',
      SEATMETER_AUTO_ROLLE: 'entwickler',
    });
    try {
      const u = await umgebung();
      const r = await entwickler.inject({
        method: 'PUT',
        url: '/api/v1/projektkatalog/einstellung',
        headers: u.admin,
        payload: { stufe: 'blockieren' },
      });
      expect(r.statusCode).toBe(200);
      const e = katalogEinstellungSchema.parse(r.json());
      expect(e).toMatchObject({ hinderung: null, auswahl_erreichbar: true });
    } finally {
      await entwickler.close();
    }
  });

  it('Ingest-URL ohne öffentliche URL: Link wäre falsch, also frei und keine Stufe', async () => {
    vi.stubEnv('SEATMETER_INGEST_URL', 'https://ingest.example.org');
    const url = inject('testDatenbankUrl');
    const ohne = await kernApp(db, url, { SEATMETER_PUBLIC_URL: '' });
    try {
      const u = await umgebung();
      await importieren(u);
      const r = await ohne.inject({
        method: 'PUT',
        url: '/api/v1/projektkatalog/einstellung',
        headers: u.admin,
        payload: { stufe: 'blockieren' },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ hinderung: string }>().hinderung).toBe('link_basis');
      await withMandant(db, u.mandantId, (t) =>
        t
          .insertInto('mandant_projektkatalog')
          .values({ mandant_id: u.mandantId, stufe: 'blockieren' })
          .onConflict((oc) => oc.column('mandant_id').doUpdateSet({ stufe: 'blockieren' }))
          .execute(),
      );
      const p = await ohne.inject({
        method: 'POST',
        url: PROJEKTWAHL_PRUEF_PFAD,
        headers: {
          authorization: `Bearer ${u.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: 'sitzung=abc',
      });
      expect(p.body).toBe('frei\n');
    } finally {
      await ohne.close();
      vi.unstubAllEnvs();
    }
  });

  it('warnt, wenn niemand die Auswahl erreichen kann: ohne Rolle entwickler und ohne Gruppen', async () => {
    const lesen = async (u: Umgebung, a = app) =>
      katalogEinstellungSchema.parse(
        (await a.inject({ url: '/api/v1/projektkatalog/einstellung', headers: u.admin })).json(),
      ).auswahl_erreichbar;
    const u = await umgebung();
    expect(await lesen(u)).toBe(false);
    await meldeAn(db, u.mandantId, 'entwickler');
    expect(await lesen(u)).toBe(true);

    const v = await umgebung();
    const slug = await db
      .selectFrom('mandant')
      .select('slug')
      .where('id', '=', v.mandantId)
      .executeTakeFirstOrThrow();
    const mitGruppen = await kernApp(db, inject('testDatenbankUrl'), {
      SEATMETER_OIDC_GRUPPEN: JSON.stringify({
        devs: { mandant: slug.slug, rolle: 'entwickler' },
      }),
    });
    try {
      expect(await lesen(v, mitGruppen)).toBe(true);
    } finally {
      await mitGruppen.close();
    }
  });

  it('kein Mitglied: Die Seite nennt den Kontakt des Mandanten oder sonst die Betreuung', async () => {
    const u = await umgebung();
    await importieren(u);
    await erzwingen(u);
    const anderer = await umgebung();
    const token = tokenAusLink((await pruefen(u.token, 'abc')).body);
    const lesen = () =>
      app.inject({ url: `/api/v1/projektwahl?token=${token}`, headers: anderer.admin });
    expect((await lesen()).json<{ fehler: string }>().fehler).toContain('betreut');
    const k = await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/einstellung',
      headers: u.admin,
      payload: { stufe: 'blockieren', kontakt: 'IT-Hotline, Tel. 123' },
    });
    expect(katalogEinstellungSchema.parse(k.json()).kontakt).toBe('IT-Hotline, Tel. 123');
    const r = await lesen();
    expect(r.statusCode).toBe(403);
    expect(r.json<{ code: string; fehler: string }>()).toMatchObject({ code: 'kein_mitglied' });
    expect(r.json<{ fehler: string }>().fehler).toContain('IT-Hotline, Tel. 123');
  });

  it('Notfall-CLI setzt die Stufe ohne Anmeldung, protokolliert, Exit 1 bei Fehlern', async () => {
    const u = await umgebung();
    await importieren(u);
    await erzwingen(u);
    const slug = (
      await db
        .selectFrom('mandant')
        .select('slug')
        .where('id', '=', u.mandantId)
        .executeTakeFirstOrThrow()
    ).slug;
    const konfiguration = testKonfiguration(inject('testDatenbankUrl'), {
      SEATMETER_PUBLIC_URL: 'http://seatmeter.test',
    });
    const aus: string[] = [];
    const fehler: string[] = [];
    const umg = {
      db,
      konfiguration,
      ausgabe: (z: string) => aus.push(z),
      fehler: (z: string) => fehler.push(z),
    };
    expect(await stufeCli(['--mandant', slug, '--stufe', 'aus'], umg)).toBe(0);
    expect(JSON.parse(aus[0] ?? '')).toEqual({ stufe: 'aus' });
    expect((await pruefen(u.token, 'abc')).body).toBe('frei\n');
    const audit = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('audit')
        .select('objekt')
        .where('objekt', '=', 'stufe:aus ausloeser:cli')
        .execute(),
    );
    expect(audit).toHaveLength(1);
    for (const a of [
      [],
      ['--mandant', slug],
      ['--mandant', slug, '--stufe', 'an'],
      ['--mandant', 'gibt-es-nicht', '--stufe', 'aus'],
      ['--mandant', slug, '--stufe', 'aus', '--mehr'],
    ]) {
      expect(await stufeCli(a, umg), a.join(' ')).toBe(1);
    }
    expect(fehler).toHaveLength(5);
    const header = testKonfiguration(inject('testDatenbankUrl'), {
      SEATMETER_TRUST_REMOTE_USER_HEADER: 'remote-email',
    });
    expect(
      await stufeCli(['--mandant', slug, '--stufe', 'blockieren'], {
        ...umg,
        konfiguration: header,
      }),
    ).toBe(1);
    // Ausschalten geht immer: Dafür ist die CLI da.
    expect(
      await stufeCli(['--mandant', slug, '--stufe', 'aus'], { ...umg, konfiguration: header }),
    ).toBe(0);
  });

  // scp-Remotes, die `normalisiereRepoUrl` beim zweiten Durchlauf anders schreibt: Remote, wie der Hook es sendet, und
  // URL, wie die Telemetrie sie für dasselbe Repo meldet.
  const BESONDERE_REMOTES = [
    [
      'Umlaut',
      'git@gitea.example:kunden/müller/webshop.git',
      'https://gitea.example/kunden/müller/webshop',
    ],
    [
      'Punkte',
      'git@gitea.example:kunden/../webshop.git',
      'https://gitea.example/kunden/../webshop',
    ],
    [
      'Klammern',
      'git@gitea.example:kunden/{a}/webshop.git',
      'https://gitea.example/kunden/{a}/webshop',
    ],
    [
      'Anführungszeichen',
      'git@gitea.example:kunden/a"b/webshop.git',
      'https://gitea.example/kunden/a"b/webshop',
    ],
    [
      'Backslash',
      'git@gitea.example:kunden/a\\b/webshop.git',
      'https://gitea.example/kunden/a\\b/webshop',
    ],
    ['IDN', 'git@bücher.example:kunden/webshop.git', 'https://bücher.example/kunden/webshop'],
    ['gewöhnlich', 'git@firma.example:team/shop.git', 'https://firma.example/team/shop'],
  ] as const;

  it.each(BESONDERE_REMOTES)(
    'scp-Remote (%s): Nach der Wahl gilt „zugeordnet“, keine dauerhafte Sperre',
    async (_name, remote) => {
      const u = await umgebung();
      await importieren(u);
      await erzwingen(u);
      const ids = await katalogIds(u);
      const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
      const token = tokenAusLink((await pruefen(u.token, 's-1', remote)).body);
      const wahl = await app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token, katalog_projekt_id: ids['P-100'] },
      });
      expect(wahl.statusCode, wahl.body).toBe(200);
      expect((await pruefen(u.token, 's-2', remote)).body).toBe('zugeordnet\n');
      const seite = await app.inject({
        url: `/api/v1/projektwahl?token=${token}`,
        headers: entwickler.headers,
      });
      expect(projektwahlAntwortSchema.parse(seite.json()).zugeordnet?.nummer).toBe('P-100');
      const zweite = await app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token, katalog_projekt_id: ids['P-200'] },
      });
      expect(zweite.statusCode).toBe(409);
      const zeilen = await withMandant(db, u.mandantId, (t) =>
        t.selectFrom('projekt').select('id').execute(),
      );
      expect(zeilen).toHaveLength(1);
    },
  );

  it.each(BESONDERE_REMOTES)(
    'scp-Remote (%s): Das Projekt mit Nutzung bekommt die Zuordnung, keine verwaiste Zeile',
    async (_name, remote, telemetrie) => {
      const u = await umgebung();
      await importieren(u);
      await erzwingen(u);
      const ids = await katalogIds(u);
      // So legt der Ingest das Repo an, wenn die Telemetrie es zuerst meldet.
      const projektId = await withMandant(db, u.mandantId, async (trx) => {
        const kontext = await mandantKontextLaden(trx, MASTER, u.mandantId);
        return projektAufloesen(trx, kontext, { url: telemetrie }, new Map());
      });
      expect(projektId).toBeTruthy();
      const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
      const token = tokenAusLink((await pruefen(u.token, 's-1', remote)).body);
      const wahl = await app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token, katalog_projekt_id: ids['P-100'] },
      });
      expect(wahl.statusCode, wahl.body).toBe(200);
      const stand = await withMandant(db, u.mandantId, async (t) => ({
        projekte: await t.selectFrom('projekt').select('id').execute(),
        zuordnung: await t.selectFrom('projekt_katalog').select('projekt_id').execute(),
      }));
      expect(stand.projekte).toHaveLength(1);
      expect(stand.zuordnung).toEqual([{ projekt_id: projektId }]);
      expect((await pruefen(u.token, 's-2', remote)).body).toBe('zugeordnet\n');
    },
  );

  it('schreibt nichts: Wer nur das Mandanten-Token hat, legt keine Zeilen an; das Repo entsteht bei der Wahl', async () => {
    const u = await umgebung();
    await importieren(u);
    await erzwingen(u);
    const ids = await katalogIds(u);
    const zeilen = () =>
      withMandant(db, u.mandantId, (t) => t.selectFrom('projekt').select('url_norm').execute());
    for (let i = 0; i < 5; i += 1) {
      const r = await pruefen(u.token, `s-${i}`, `https://git.example.org/spam/repo-${i}.git`);
      expect(r.body).toMatch(/^waehlen /);
    }
    expect(await zeilen()).toEqual([]);

    const repo = 'https://git.example.org/firma/neu.git';
    const token = tokenAusLink((await pruefen(u.token, 's-9', repo)).body);
    const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
    const seite = await app.inject({
      url: `/api/v1/projektwahl?token=${token}`,
      headers: entwickler.headers,
    });
    // Die Seite zeigt das Repo, obwohl es noch keine Zeile dazu gibt, und legt auch keine an.
    expect(projektwahlAntwortSchema.parse(seite.json()).ziel).toEqual({
      art: 'repo',
      name: 'firma/neu',
    });
    expect(await zeilen()).toEqual([]);
    const wahl = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: entwickler.headers,
      payload: { token, katalog_projekt_id: ids['P-100'] },
    });
    expect(wahl.statusCode).toBe(200);
    expect(await zeilen()).toEqual([{ url_norm: 'https://git.example.org/firma/neu' }]);
    expect((await pruefen(u.token, 's-10', repo)).body).toBe('zugeordnet\n');
  });

  it('Zuordnungsliste zeigt nur Repos mit Nutzung oder Wahl', async () => {
    const u = await umgebung();
    await importieren(u);
    const ids = await katalogIds(u);
    const leer = await legeProjektAn(db, u.mandantId, 'nie-benutzt');
    const genutzt = await legeProjektAn(db, u.mandantId, 'genutzt');
    const gewaehlt = await legeProjektAn(db, u.mandantId, 'gewaehlt');
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person, projekt: genutzt, usd: 1 }]);
    expect((await zuordnen(u, gewaehlt, ids['P-100'] ?? null)).statusCode).toBe(200);
    const z = katalogZuordnungAntwortSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: u.admin })).json(),
    );
    const sichtbar = z.zuordnung.map((x) => x.projekt_id);
    expect(sichtbar.sort()).toEqual([genutzt, gewaehlt].sort());
    expect(sichtbar).not.toContain(leer);
  });

  it('Ordner ohne Repo: Wahl gilt nur für die Sitzung und rechnet die Nutzung dieser Sitzung zu', async () => {
    const u = await umgebung();
    await importieren(u);
    await erzwingen(u);
    const ids = await katalogIds(u);
    const person = await legePersonAn(db, u.mandantId);
    const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
    await anfrageOhneRepo(u.mandantId, person, 'ohne-repo-1');
    await anfrageOhneRepo(u.mandantId, person, 'ohne-repo-2');
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person, projekt: null, usd: 9 }]);

    for (const repo of ['', '/lokaler/pfad']) {
      const r = await pruefen(u.token, 'ohne-repo-1', repo);
      expect(r.body, repo).toMatch(/^waehlen /);
    }
    const token = tokenAusLink((await pruefen(u.token, 'ohne-repo-1')).body);
    const d = projektwahlAntwortSchema.parse(
      (
        await app.inject({ url: `/api/v1/projektwahl?token=${token}`, headers: entwickler.headers })
      ).json(),
    );
    expect(d.ziel).toEqual({ art: 'sitzung' });
    const wahl = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: entwickler.headers,
      payload: { token, katalog_projekt_id: ids['P-300'] },
    });
    expect(wahl.statusCode).toBe(200);
    expect((await pruefen(u.token, 'ohne-repo-1')).body).toBe('zugeordnet\n');
    expect((await pruefen(u.token, 'ohne-repo-2')).body).toMatch(/^waehlen /);

    const k = await kosten(u);
    const p = k.projekte.find((x) => x.nummer === 'P-300');
    expect(p?.sitzungen_ohne_repo).toBe(1);
    expect(p?.ohne_repo.anfragen).toBe(1);
    expect(p?.tokens.input).toBe(1000);
    expect(p?.schatten_usd_micros).toBeGreaterThan(0);
    expect(k.offen.ohne_repo.schatten_usd_micros).toBeLessThan(9 * M);

    // Projektleiter sehen Sitzungen ohne Repo nicht (keine Projekt-ID).
    const leiter = await meldeAn(db, u.mandantId, 'projektleiter', []);
    expect((await kosten(u, MONAT, leiter.headers)).projekte).toEqual([]);

    // Der Monatsabschluss friert auch die Sitzung ein.
    const a = await legeProjektAn(db, u.mandantId, 'a');
    await zuordnen(u, a, ids['P-100'] ?? null);
    await schliesseMonat(db, u.mandantId, MONAT);
    const fest = await kosten(u);
    expect(fest.quelle).toBe('monatsabschluss');
    expect(fest.projekte.find((x) => x.nummer === 'P-300')?.sitzungen_ohne_repo).toBe(1);
  });
});

describe('Link und Rechte', () => {
  it('Link: signiert, befristet, genau ein Ziel', () => {
    const jetzt = new Date('2026-11-01T10:00:00Z');
    const m = randomUUID();
    const t = linkTokenErzeugen(
      MASTER,
      { mandantId: m, repoUrl: 'https://git.example.org/o/r' },
      jetzt,
    );
    expect(linkTokenPruefen(MASTER, t, jetzt).art).toBe('ok');
    expect(linkTokenPruefen(MASTER, t, new Date(jetzt.getTime() + LINK_GUELTIG_MS)).art).toBe(
      'abgelaufen',
    );
    expect(linkTokenPruefen(Buffer.alloc(32, 9), t, jetzt).art).toBe('ungueltig');
    // Ohne Punkt: Die Auslieferung des Dashboards behandelt Pfade mit Dateiendung als Dateien (404).
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    const sig = t.slice(-43);
    const nutzlast = t.slice(0, -43);
    const fremd = Buffer.from(
      JSON.stringify({ v: 1, m: randomUUID(), u: 'https://git.example.org/x/y', e: 9e9 }),
    );
    expect(linkTokenPruefen(MASTER, `${fremd.toString('base64url')}${sig}`, jetzt).art).toBe(
      'ungueltig',
    );
    expect(linkTokenPruefen(MASTER, nutzlast, jetzt).art).toBe('ungueltig');
    expect(linkTokenPruefen(MASTER, 'kaputt', jetzt).art).toBe('ungueltig');
    expect(linkTokenPruefen(MASTER, `${t}mehr`, jetzt).art).toBe('ungueltig');
    const beides = linkTokenErzeugen(
      MASTER,
      { mandantId: m, repoUrl: 'https://git.example.org/o/r', sessionId: 'x' },
      jetzt,
    );
    expect(linkTokenPruefen(MASTER, beides, jetzt).art).toBe('ungueltig');
    expect(
      linkTokenPruefen(MASTER, linkTokenErzeugen(MASTER, { mandantId: m }, jetzt), jetzt).art,
    ).toBe('ungueltig');
  });

  it('Auswahlseite: Anmeldung Pflicht, nur Mitglieder des Mandanten, abgelaufener Link 410', async () => {
    const u = await umgebung();
    await importieren(u);
    await erzwingen(u);
    const ids = await katalogIds(u);
    const token = tokenAusLink((await pruefen(u.token, 'abc')).body);
    const anonym = await app.inject({ url: `/api/v1/projektwahl?token=${token}` });
    expect(anonym.statusCode).toBe(401);

    const anderer = await umgebung();
    const fremd = await app.inject({
      url: `/api/v1/projektwahl?token=${token}`,
      headers: anderer.admin,
    });
    expect(fremd.statusCode).toBe(403);
    expect(fremd.json<{ code: string }>().code).toBe('kein_mitglied');
    const fremdWahl = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: anderer.admin,
      payload: { token, katalog_projekt_id: ids['P-100'] },
    });
    expect(fremdWahl.statusCode).toBe(403);

    const alt = linkTokenErzeugen(
      MASTER,
      { mandantId: u.mandantId, sessionId: 'abc' },
      new Date(Date.now() - 2 * LINK_GUELTIG_MS),
    );
    const abgelaufen = await app.inject({
      url: `/api/v1/projektwahl?token=${alt}`,
      headers: u.admin,
    });
    expect(abgelaufen.statusCode).toBe(410);
    expect(abgelaufen.json<{ code: string }>().code).toBe('link_abgelaufen');
    const kaputt = await app.inject({
      url: '/api/v1/projektwahl?token=kaputt',
      headers: u.admin,
    });
    expect(kaputt.statusCode).toBe(400);

    // Wahl braucht das CSRF-Token der Sitzung.
    const ohneCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: { cookie: u.admin.cookie ?? '' },
      payload: { token, katalog_projekt_id: ids['P-100'] },
    });
    expect(ohneCsrf.statusCode).toBe(403);

    // Projekte eines anderen Mandanten oder inaktive lassen sich nicht wählen.
    await importieren(anderer, [{ nummer: 'X-1', name: 'Fremd' }]);
    const fremdeIds = await katalogIds(anderer);
    const fremdesProjekt = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: u.admin,
      payload: { token, katalog_projekt_id: fremdeIds['X-1'] },
    });
    expect(fremdesProjekt.statusCode).toBe(400);
    await importieren(u, [{ nummer: 'P-200', name: 'Portal' }]);
    const inaktiv = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: u.admin,
      payload: { token, katalog_projekt_id: ids['P-100'] },
    });
    expect(inaktiv.statusCode).toBe(400);
  });

  it('Rolle `entwickler` allein sieht keine Auswertung, im Mix erweitert sie nichts', async () => {
    const u = await umgebung();
    const a = await legeProjektAn(db, u.mandantId, 'a');
    const b = await legeProjektAn(db, u.mandantId, 'b');
    const s = await meldeAn(db, u.mandantId, 'entwickler');
    for (const pfad of [
      `/api/v1/projekte?monat=${MONAT}`,
      `/api/v1/projekte/${a}?monat=${MONAT}`,
      `/api/v1/personen?monat=${MONAT}`,
      `/api/v1/kalkulation?monat=${MONAT}`,
      '/api/v1/projektkatalog/zuordnung',
      '/api/v1/projektkatalog/projekte',
      `/api/v1/projektkatalog/kosten?monat=${MONAT}`,
    ]) {
      const r = await app.inject({ url: pfad, headers: s.headers });
      expect(r.statusCode, pfad).toBe(403);
    }
    // /auth/me bleibt erreichbar, damit das Dashboard die Hinweisseite zeigen kann.
    expect((await app.inject({ url: '/api/v1/auth/me', headers: s.headers })).statusCode).toBe(200);

    // Projektleitung plus Entwicklung: weiter nur die eigenen Projekte.
    const person = await legePersonAn(db, u.mandantId);
    await tagAggregat(db, u.mandantId, [
      { tag: TAG, person, projekt: a, usd: 1 },
      { tag: TAG, person, projekt: b, usd: 1 },
    ]);
    const leiter = await meldeAn(db, u.mandantId, 'projektleiter', [a]);
    await db
      .insertInto('rolle')
      .values({ mandant_id: u.mandantId, benutzer_id: leiter.benutzerId, rolle: 'entwickler' })
      .execute();
    const z = katalogZuordnungAntwortSchema.parse(
      (
        await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: leiter.headers })
      ).json(),
    );
    expect(z.zuordnung.map((x) => x.projekt_id)).toEqual([a]);
    expect(z.zuordnung.map((x) => x.projekt_id)).not.toContain(b);
  });

  it('Konto nur mit `entwickler`: kein Anmelde-Eintrag im Audit, andere Konten weiter', async () => {
    const u = await umgebung();
    const { slug } = await db
      .selectFrom('mandant')
      .select('slug')
      .where('id', '=', u.mandantId)
      .executeTakeFirstOrThrow();
    const url = inject('testDatenbankUrl');
    const eintraege = () =>
      withMandant(db, u.mandantId, (t) =>
        t
          .selectFrom('audit')
          .select(['aktion', 'benutzer_id'])
          .where('aktion', 'in', ['Anmeldung', 'Benutzer angelegt'])
          // Ohne Reihenfolge schneidet `.slice(n)` unter Last die falschen Zeilen ab.
          .orderBy('id')
          .execute(),
      );
    const vorher = (await eintraege()).length;
    const name = `dev-${randomUUID()}@example.org`;
    const proxy = await kernApp(db, url, {
      SEATMETER_TRUST_REMOTE_USER_HEADER: 'remote-email',
      SEATMETER_AUTO_ROLLE: 'entwickler',
      SEATMETER_AUTO_MANDANT: slug,
    });
    try {
      const r = await proxy.inject({ url: '/api/v1/auth/me', headers: { 'remote-email': name } });
      expect(r.statusCode).toBe(200);
      const neu = (await eintraege()).slice(vorher);
      expect(neu.map((e) => e.aktion)).toEqual(['Benutzer angelegt']);
      expect(neu[0]?.benutzer_id).toBeNull();
      // Auch keine Anmeldezeit: Sie stünde sonst neben dem Namen in der Kontenliste.
      const konto = await db
        .selectFrom('benutzer')
        .select('zuletzt_angemeldet')
        .where('benutzername', '=', name)
        .executeTakeFirstOrThrow();
      expect(konto.zuletzt_angemeldet).toBeNull();
      const liste = await app.inject({ url: '/api/v1/mandant/konten', headers: u.admin });
      const zeile = liste
        .json<{ konten: { benutzername: string; zuletzt_angemeldet: string | null }[] }>()
        .konten.find((k) => k.benutzername === name);
      expect(zeile).toBeDefined();
      expect(zeile?.zuletzt_angemeldet).toBeNull();
    } finally {
      await proxy.close();
    }
    // Vergleich: Ein Konto mit Dashboard-Rolle steht weiter drin.
    const admin = `admin-${randomUUID()}@example.org`;
    const proxyAdmin = await kernApp(db, url, {
      SEATMETER_TRUST_REMOTE_USER_HEADER: 'remote-email',
      SEATMETER_AUTO_MANDANT: slug,
    });
    try {
      const n = (await eintraege()).length;
      await proxyAdmin.inject({ url: '/api/v1/auth/me', headers: { 'remote-email': admin } });
      const neu = (await eintraege()).slice(n);
      expect(neu.map((e) => e.aktion).sort()).toEqual(['Anmeldung', 'Benutzer angelegt']);
      expect(neu.every((e) => e.benutzer_id !== null)).toBe(true);
      const konto = await db
        .selectFrom('benutzer')
        .select('zuletzt_angemeldet')
        .where('benutzername', '=', admin)
        .executeTakeFirstOrThrow();
      expect(konto.zuletzt_angemeldet).not.toBeNull();
    } finally {
      await proxyAdmin.close();
    }
  });

  describe('Audit bei OIDC: Konten nur mit `entwickler` ohne Konto im Eintrag', () => {
    const kontoZeilen = (mandantId: string) =>
      withMandant(db, mandantId, (t) =>
        t
          .selectFrom('audit')
          .select(['aktion', 'benutzer_id', 'objekt'])
          .where('aktion', 'in', ['Konto angelegt', 'Rolle zugewiesen', 'Rolle entzogen'])
          .orderBy('id')
          .execute(),
      );
    const anmelden = (k: MandantOidc, groups: string[]) =>
      mandantKontoAnmelden(
        db,
        { kontingentPruefen: () => Promise.resolve(null) },
        k,
        {
          sub: randomUUID(),
          email: `sso-${randomUUID()}@example.org`,
          email_verified: true,
          groups,
        },
        () => Promise.resolve(false),
      );
    const oidc = (mandantId: string): MandantOidc => ({
      mandantId,
      slug: 'test',
      issuer: `https://idp-${randomUUID()}.example`,
      clientId: 'c',
      secret: 's',
      scopes: 'openid',
      bezeichnung: 'SSO',
      gruppenRollen: { dev: ['entwickler'], leser: ['controller'] },
      aktiv: true,
    });

    it('SSO des Mandanten: erste Anmeldung mit `entwickler` nennt das Konto nicht', async () => {
      const u = await umgebung();
      const vorher = (await kontoZeilen(u.mandantId)).length;
      const r = await anmelden(oidc(u.mandantId), ['dev']);
      if (!r.ok) throw new Error('Anmeldung fehlgeschlagen');
      const neu = (await kontoZeilen(u.mandantId)).slice(vorher);
      expect(neu.map((e) => e.aktion).sort()).toEqual(['Konto angelegt', 'Rolle zugewiesen']);
      for (const e of neu) {
        expect(e.benutzer_id).toBeNull();
        expect(e.objekt).not.toContain(r.benutzer.id);
      }
      expect(neu.find((e) => e.aktion === 'Rolle zugewiesen')?.objekt).toContain(
        'rolle:entwickler',
      );
    });

    it('SSO des Mandanten: mit weiterer Rolle bleibt das Konto im Eintrag', async () => {
      const u = await umgebung();
      const vorher = (await kontoZeilen(u.mandantId)).length;
      const r = await anmelden(oidc(u.mandantId), ['dev', 'leser']);
      if (!r.ok) throw new Error('Anmeldung fehlgeschlagen');
      const neu = (await kontoZeilen(u.mandantId)).slice(vorher);
      expect(neu.map((e) => e.aktion).sort()).toEqual([
        'Konto angelegt',
        'Rolle zugewiesen',
        'Rolle zugewiesen',
      ]);
      for (const e of neu) {
        expect(e.benutzer_id).toBe(r.benutzer.id);
        expect(e.objekt).toContain(r.benutzer.id);
      }
    });

    const kontoAnlegen = async () =>
      (
        await db
          .insertInto('benutzer')
          .values({ benutzername: `global-${randomUUID()}@example.org`, login: 'oidc' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const abgleichen = (benutzerId: string, mandantId: string, rollen: Rolle[]) =>
      rollenAbgleichen(
        db,
        benutzerId,
        {
          rollen: new Map([[mandantId, new Map(rollen.map((r) => [r, null]))]]),
          plattformAdmin: false,
        },
        new Set(),
        { plattformAdminAbgleichen: () => Promise.resolve() },
      );

    it('Anmeldedienst für alle: nur `entwickler` ohne Konto, sonst mit', async () => {
      const u = await umgebung();
      const dev = await kontoAnlegen();
      const start = (await kontoZeilen(u.mandantId)).length;
      await abgleichen(dev, u.mandantId, ['entwickler']);
      const neu = (await kontoZeilen(u.mandantId)).slice(start);
      expect(neu).toHaveLength(1);
      expect(neu[0]?.benutzer_id).toBeNull();
      expect(neu[0]?.objekt).not.toContain(dev);

      const leser = await kontoAnlegen();
      const danach = (await kontoZeilen(u.mandantId)).length;
      await abgleichen(leser, u.mandantId, ['entwickler', 'controller']);
      const neu2 = (await kontoZeilen(u.mandantId)).slice(danach);
      expect(neu2).toHaveLength(2);
      expect(neu2.every((e) => e.benutzer_id === leser && e.objekt?.includes(leser))).toBe(true);
    });

    it('Anmeldedienst für alle: eine von Hand vergebene Rolle zählt mit', async () => {
      const u = await umgebung();
      const konto = await kontoAnlegen();
      await db
        .insertInto('rolle')
        .values({
          mandant_id: u.mandantId,
          benutzer_id: konto,
          rolle: 'controller',
          quelle: 'manuell',
        })
        .execute();
      const start = (await kontoZeilen(u.mandantId)).length;
      await abgleichen(konto, u.mandantId, ['entwickler']);
      const neu = (await kontoZeilen(u.mandantId)).slice(start);
      expect(neu).toHaveLength(1);
      expect(neu[0]?.benutzer_id).toBe(konto);
    });
  });

  it('Entwickler in einem Mandanten, Admin im anderen: Die Sitzung beginnt dort, wo das Dashboard geht', async () => {
    const a = await umgebung();
    const b = await umgebung();
    const { slug } = await db
      .selectFrom('mandant')
      .select('slug')
      .where('id', '=', a.mandantId)
      .executeTakeFirstOrThrow();
    const name = `mix-${randomUUID()}@example.org`;
    const proxy = await kernApp(db, inject('testDatenbankUrl'), {
      SEATMETER_TRUST_REMOTE_USER_HEADER: 'remote-email',
      SEATMETER_AUTO_ROLLE: 'entwickler',
      SEATMETER_AUTO_MANDANT: slug,
    });
    try {
      const erst = await proxy.inject({
        url: '/api/v1/auth/me',
        headers: { 'remote-email': name },
      });
      const konto = erst.json<{ benutzer_id?: string; id?: string }>();
      expect(erst.statusCode).toBe(200);
      const zeile = await db
        .selectFrom('benutzer')
        .select('id')
        .where('benutzername', '=', name)
        .executeTakeFirstOrThrow();
      expect(konto).toBeTruthy();
      await db
        .insertInto('rolle')
        .values({ mandant_id: b.mandantId, benutzer_id: zeile.id, rolle: 'mandanten_admin' })
        .execute();
      await db.deleteFrom('benutzer_sitzung').where('benutzer_id', '=', zeile.id).execute();
      const r = await proxy.inject({ url: '/api/v1/auth/me', headers: { 'remote-email': name } });
      const me = r.json<{ mandant_id: string; rollen: string[]; mandanten: unknown[] }>();
      expect(me.mandant_id).toBe(b.mandantId);
      expect(me.rollen).toEqual(['mandanten_admin']);
      expect(me.mandanten).toHaveLength(2);
    } finally {
      await proxy.close();
    }
  });

  it('Mandanten bleiben getrennt: RLS auf allen neuen Tabellen', async () => {
    const u = await umgebung();
    const anderer = await umgebung();
    await importieren(u);
    const a = await legeProjektAn(db, u.mandantId, 'a');
    const ids = await katalogIds(u);
    await zuordnen(u, a, ids['P-100'] ?? null);
    await withMandant(db, anderer.mandantId, async (t) => {
      expect(await t.selectFrom('katalog_projekt').selectAll().execute()).toEqual([]);
      expect(await t.selectFrom('projekt_katalog').selectAll().execute()).toEqual([]);
    });
    // Fremde Repos lassen sich nicht zuordnen, auch mit bekannter ID.
    expect((await zuordnen(anderer, a, ids['P-100'] ?? null)).statusCode).toBe(400);
  });

  it('der Link steht nicht im Log', () => {
    const req = logSerializer.serializers?.req as (a: { url: string }) => { path: string };
    expect(req({ url: '/projektwahl/geheim.token?x=1' }).path).toBe('/projektwahl/…');
    expect(req({ url: '/api/v1/projektwahl?token=geheim' }).path).toBe('/api/v1/projektwahl');
  });
});
