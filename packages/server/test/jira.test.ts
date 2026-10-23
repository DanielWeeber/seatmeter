// Jira (Kern, bis 2026-10-24 ee): Client gegen einen Jira-Nachbau im Testprozess (Cloud: Basic E-Mail + Token,
// Data Center: Bearer PAT), Schutz vor internen Zielen, verschlüsseltes Token, Zuordnung mit Positivliste,
// Kosten je Jira-Projekt und Issue (Titel nachgeladen und zwischengespeichert), Rechte und RLS; ohne Plugin und
// ohne Lizenz.
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import {
  jiraKostenAntwortSchema,
  jiraPruefungSchema,
  jiraProjekteAntwortSchema,
  jiraVerbindungSchema,
  jiraZuordnungAntwortSchema,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  istInterneAdresse,
  jiraIssue,
  jiraMyself,
  JiraFehler,
  normalisiereBasisUrl,
  type JiraZugang,
} from '../src/jira/index.js';
import { kernApp, legeMandantAn, legeProjektAn, meldeAn } from './api-hilfen.js';
import { M, tagAggregat } from './modul-hilfen.js';

const EMAIL = 'jira-bot@example.org';
const TOKEN = 'ATATT-geheimes-test-token-0000';
const PAT = 'dc-pat-geheim-0000';
const MONAT = '2026-10';

interface Anfrage {
  pfad: string;
  header: IncomingHttpHeaders;
}

/** Jira-Nachbau: Cloud unter /cloud, Data Center unter /dc (Kontextpfad). */
class FakeJira {
  private server: Server | null = null;
  url = '';
  anfragen: Anfrage[] = [];

  async starten(): Promise<void> {
    this.server = createServer((req, res) => {
      const pfad = req.url ?? '/';
      this.anfragen.push({ pfad, header: req.headers });
      const [status, body] = this.antwort(pfad, req.headers.authorization ?? '');
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stoppen(): Promise<void> {
    await new Promise<void>((ok) => this.server?.close(() => ok()));
  }

  private antwort(pfad: string, auth: string): [number, unknown] {
    const u = new URL(pfad, 'http://x');
    const cloudOk = auth === `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
    const dcOk = auth === `Bearer ${PAT}`;
    if (u.pathname.startsWith('/cloud/')) {
      if (!cloudOk) return [401, { errorMessages: ['Unauthorized'] }];
      const p = u.pathname.slice('/cloud'.length);
      if (p === '/rest/api/3/myself')
        return [200, { displayName: 'Jira Bot', emailAddress: EMAIL }];
      if (p === '/rest/api/3/project/search') {
        const start = Number(u.searchParams.get('startAt') ?? 0);
        return start === 0
          ? [200, { values: [{ key: 'ABC', name: 'Alpha' }], isLast: false }]
          : [200, { values: [{ key: 'XYZ', name: 'Xylo' }, { key: 'bad key' }], isLast: true }];
      }
      const issue = /^\/rest\/api\/3\/issue\/([A-Z0-9-]+)$/.exec(p)?.[1];
      if (issue === 'ABC-1')
        return [
          200,
          { key: issue, fields: { summary: 'Login reparieren', status: { name: 'In Arbeit' } } },
        ];
      if (issue === 'XYZ-9')
        return [200, { key: issue, fields: { summary: 'Export', status: { name: 'Fertig' } } }];
      if (issue === 'QQ-3') return [500, { errorMessages: ['kaputt'] }];
      return [404, { errorMessages: ['Issue does not exist'] }];
    }
    if (u.pathname.startsWith('/dc/')) {
      if (!dcOk) return [401, {}];
      const p = u.pathname.slice('/dc'.length);
      if (p === '/rest/api/2/myself')
        return [200, { name: 'svc-seatmeter', displayName: 'Dienstkonto' }];
      if (p === '/rest/api/2/project') return [200, [{ key: 'DCP', name: 'Data Center Projekt' }]];
      return [404, {}];
    }
    if (u.pathname === '/umleitung/rest/api/3/myself') return [302, {}];
    return [404, {}];
  }
}

describe('Jira-Client', () => {
  it('Basis-URL: https, ohne Zugangsdaten/Query, keine internen Ziele (außer erlaubt)', () => {
    expect(normalisiereBasisUrl('https://firma.atlassian.net/')).toBe(
      'https://firma.atlassian.net',
    );
    expect(normalisiereBasisUrl('https://jira.example.org/jira//')).toBe(
      'https://jira.example.org/jira',
    );
    for (const falsch of [
      'http://firma.atlassian.net',
      'https://nutzer:pw@firma.atlassian.net',
      'https://firma.atlassian.net/?x=1',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://[::1]',
      'https://localhost',
      'kein-url',
    ])
      expect(() => normalisiereBasisUrl(falsch), falsch).toThrow(JiraFehler);
    expect(normalisiereBasisUrl('http://127.0.0.1:8080', true)).toBe('http://127.0.0.1:8080');
    expect(istInterneAdresse([192, 168, 1, 13].join('.'))).toBe(true);
    expect(istInterneAdresse('::ffff:10.0.0.1')).toBe(true);
    expect(istInterneAdresse('93.184.216.34')).toBe(false);
  });

  it('löst Namen auf und lehnt interne Adressen ab, folgt keiner Weiterleitung, Zeitlimit', async () => {
    const z: JiraZugang = {
      basisUrl: 'https://jira.example.org',
      art: 'cloud',
      email: EMAIL,
      token: TOKEN,
    };
    await expect(
      jiraMyself(z, { aufloesen: async () => ['10.0.0.5'], fetch: async () => new Response('{}') }),
    ).rejects.toMatchObject({ art: 'ziel' });
    const haengt: typeof fetch = (_u, init) =>
      new Promise((_ok, fehler) =>
        init?.signal?.addEventListener('abort', () => fehler(init.signal?.reason)),
      );
    await expect(
      jiraMyself(z, { aufloesen: async () => ['93.184.216.34'], fetch: haengt, timeoutMs: 30 }),
    ).rejects.toMatchObject({ art: 'zeit' });
    const j = new FakeJira();
    await j.starten();
    try {
      await expect(
        jiraMyself({ ...z, basisUrl: `${j.url}/umleitung` }, { internErlaubt: true }),
      ).rejects.toMatchObject({ art: 'ziel', status: 302 });
      const falsch = { ...z, basisUrl: `${j.url}/cloud`, token: 'falsch' };
      const f = await jiraMyself(falsch, { internErlaubt: true }).catch((e: unknown) => e);
      expect(f).toBeInstanceOf(JiraFehler);
      expect(String((f as Error).message)).not.toContain('falsch');
      expect(
        await jiraIssue({ ...z, basisUrl: `${j.url}/cloud` }, 'NIX-1', { internErlaubt: true }),
      ).toBeNull();
    } finally {
      await j.stoppen();
    }
  });
});

describe('Jira je Mandant (Routen)', () => {
  const url = inject('modulDatenbankUrl');
  let db: Db;
  let app: FastifyInstance;
  let jira: FakeJira;
  let m: string;
  let fremd: string;
  let x: string;
  let y: string;
  let z: string;
  let admin: Awaited<ReturnType<typeof meldeAn>>;

  const get = (pfad: string, kopf: { headers: Record<string, string> }) =>
    app.inject({ method: 'GET', url: pfad, headers: kopf.headers });
  const senden = (
    methode: 'PUT' | 'POST' | 'DELETE',
    pfad: string,
    kopf: { headers: Record<string, string> },
    payload?: unknown,
  ) =>
    app.inject({
      method: methode,
      url: pfad,
      headers: kopf.headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  beforeAll(async () => {
    db = erstelleDb(url, 4);
    jira = new FakeJira();
    await jira.starten();
    app = await kernApp(db, url, {
      SEATMETER_JIRA_INTERN_ERLAUBT: '1',
    });
    m = await legeMandantAn(db);
    fremd = await legeMandantAn(db);
    x = await legeProjektAn(db, m, `x-${randomUUID().slice(0, 6)}`);
    y = await legeProjektAn(db, m, `y-${randomUUID().slice(0, 6)}`);
    z = await legeProjektAn(db, m, `z-${randomUUID().slice(0, 6)}`);
    admin = await meldeAn(db, m, 'mandanten_admin');
    const tag = `${MONAT}-05`;
    await tagAggregat(db, m, [
      { tag, person: null, projekt: x, usd: 100, tokens: { input: 1000 } },
      { tag, person: null, projekt: y, usd: 20, tokens: { input: 200 } },
      { tag, person: null, projekt: z, usd: 5, tokens: { input: 50 } },
    ]);
    const issue = (projekt: string, schluessel: string, usd: number, sitzungen: number) => ({
      mandant_id: m,
      monat: `${MONAT}-01`,
      projekt_id: projekt,
      schluessel,
      sitzungen,
      anfragen: 1,
      input: Math.round(usd * 10),
      output: 0,
      cache_read: 0,
      cache_write: 0,
      cache_write_1h: 0,
      schatten_usd_micros: usd * M,
    });
    await db
      .insertInto('issue_aggregat')
      .values([
        issue(x, 'ABC-1', 40, 2),
        issue(x, 'ABC-2', 10, 1),
        issue(y, 'ABC-1', 5, 1),
        issue(y, 'XYZ-9', 10, 1),
        issue(z, 'QQ-3', 2, 1),
      ])
      .execute();
  });
  afterAll(async () => {
    await app?.close();
    await jira?.stoppen();
    await db?.destroy();
  });

  it('Verbindung speichern: Token verschlüsselt, nie in Antwort oder Audit; Cloud braucht E-Mail', async () => {
    const ohneMail = await senden('PUT', '/api/v1/jira/verbindung', admin, {
      basis_url: `${jira.url}/cloud`,
      art: 'cloud',
      token: TOKEN,
    });
    expect(ohneMail.statusCode).toBe(400);
    const ohneToken = await senden('PUT', '/api/v1/jira/verbindung', admin, {
      basis_url: `${jira.url}/cloud`,
      art: 'cloud',
      benutzer_email: EMAIL,
    });
    expect(ohneToken.statusCode).toBe(400);
    const r = await senden('PUT', '/api/v1/jira/verbindung', admin, {
      basis_url: `${jira.url}/cloud/`,
      art: 'cloud',
      benutzer_email: EMAIL,
      token: TOKEN,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(TOKEN);
    expect(jiraVerbindungSchema.parse(r.json())).toMatchObject({
      eingerichtet: true,
      basis_url: `${jira.url}/cloud`,
      token_gesetzt: true,
      nur_zugeordnete: false,
    });
    // Ändern ohne Token behält das gespeicherte.
    const ohne = await senden('PUT', '/api/v1/jira/verbindung', admin, {
      basis_url: `${jira.url}/cloud`,
      art: 'cloud',
      benutzer_email: EMAIL,
      nur_zugeordnete: true,
    });
    expect(ohne.json()).toMatchObject({ token_gesetzt: true, nur_zugeordnete: true });
    const roh = await withMandant(db, m, async (trx) => {
      const v = await sql<{ token: Buffer }>`SELECT token FROM mandant_jira`.execute(trx);
      const audit = await trx.selectFrom('audit').select(['aktion', 'objekt']).execute();
      return { token: v.rows[0]?.token ?? Buffer.alloc(0), audit };
    });
    expect(roh.token.length).toBeGreaterThan(0);
    expect(roh.token.toString('latin1')).not.toContain(TOKEN);
    expect(JSON.stringify(roh.audit)).not.toContain(TOKEN);
    expect(roh.audit.map((a) => a.aktion)).toContain('Jira-Verbindung gespeichert');
  });

  it('Verbindung prüfen (Cloud: Basic, falsches Token ohne Token in der Antwort) und Projekte laden', async () => {
    const ok = await senden('POST', '/api/v1/jira/verbindung/pruefen', admin);
    expect(jiraPruefungSchema.parse(ok.json())).toMatchObject({ ok: true, konto: 'Jira Bot' });
    const p = await get('/api/v1/jira/projekte', admin);
    expect(jiraProjekteAntwortSchema.parse(p.json()).projekte).toEqual([
      { schluessel: 'ABC', name: 'Alpha' },
      { schluessel: 'XYZ', name: 'Xylo' },
    ]);

    const anderer = await legeMandantAn(db);
    const a2 = await meldeAn(db, anderer, 'mandanten_admin');
    await senden('PUT', '/api/v1/jira/verbindung', a2, {
      basis_url: `${jira.url}/cloud`,
      art: 'cloud',
      benutzer_email: EMAIL,
      token: 'falsches-token-1234',
    });
    const falsch = await senden('POST', '/api/v1/jira/verbindung/pruefen', a2);
    expect(falsch.json()).toMatchObject({ ok: false, konto: null });
    expect(falsch.body).not.toContain('falsches-token');
    expect((await get('/api/v1/jira/verbindung', a2)).json().fehler).toMatch(/lehnt den Zugang ab/);
    expect((await get('/api/v1/jira/projekte', a2)).statusCode).toBe(502);

    // Data Center: Bearer PAT, REST v2, Kontextpfad.
    const dc = await legeMandantAn(db);
    const a3 = await meldeAn(db, dc, 'mandanten_admin');
    await senden('PUT', '/api/v1/jira/verbindung', a3, {
      basis_url: `${jira.url}/dc`,
      art: 'datacenter',
      token: PAT,
    });
    expect((await senden('POST', '/api/v1/jira/verbindung/pruefen', a3)).json()).toMatchObject({
      ok: true,
      konto: 'Dienstkonto',
    });
    expect((await get('/api/v1/jira/projekte', a3)).json().projekte).toEqual([
      { schluessel: 'DCP', name: 'Data Center Projekt' },
    ]);
  });

  it('Zuordnung: Liste aller Projekte, Positivliste mit „nur zugeordnete“, fremde Projekte abgelehnt', async () => {
    const vorher = jiraZuordnungAntwortSchema.parse(
      (await get('/api/v1/jira/zuordnung', admin)).json(),
    );
    expect(vorher.zuordnung.map((zz) => zz.projekt_id).sort()).toEqual([x, y, z].sort());
    const r = await senden('PUT', '/api/v1/jira/zuordnung', admin, {
      zuordnung: [
        { projekt_id: x, jira_projekt_schluessel: 'ABC', jira_projekt_name: 'Alpha' },
        { projekt_id: y, jira_projekt_schluessel: 'XYZ', jira_projekt_name: 'Xylo' },
      ],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ geaendert: 2, issue_praefixe: ['ABC', 'XYZ'] });
    const fremdesProjekt = await legeProjektAn(db, fremd, `f-${randomUUID().slice(0, 6)}`);
    const abgelehnt = await senden('PUT', '/api/v1/jira/zuordnung', admin, {
      zuordnung: [{ projekt_id: fremdesProjekt, jira_projekt_schluessel: 'ABC' }],
    });
    expect(abgelehnt.statusCode).toBe(400);
    expect(
      (
        await senden('PUT', '/api/v1/jira/zuordnung', admin, {
          zuordnung: [{ projekt_id: x, jira_projekt_schluessel: 'abc' }],
        })
      ).statusCode,
    ).toBe(400);
    const nachher = jiraZuordnungAntwortSchema.parse(
      (await get('/api/v1/jira/zuordnung', admin)).json(),
    );
    expect(nachher.issue_praefixe).toEqual(['ABC', 'XYZ']);
    expect(nachher.zuordnung.find((zz) => zz.projekt_id === z)?.jira_projekt_schluessel).toBeNull();
  });

  it('Kosten je Jira-Projekt und Issue, Titel nachgeladen und zwischengespeichert, Fehler nicht blockierend', async () => {
    const controller = await meldeAn(db, m, 'controller');
    const r = await get(`/api/v1/jira/kosten?monat=${MONAT}`, controller);
    expect(r.statusCode).toBe(200);
    const d = jiraKostenAntwortSchema.parse(r.json());
    const je = Object.fromEntries(d.jira_projekte.map((p) => [p.schluessel, p]));
    expect(Object.keys(je)).toEqual(['ABC', 'XYZ', 'QQ']);
    expect(je.ABC?.schatten_usd_micros).toBe(105 * M);
    expect(je.ABC?.ohne_issue.schatten_usd_micros).toBe(50 * M);
    expect(je.ABC?.name).toBe('Alpha');
    expect(je.ABC?.seatmeter_projekte.map((p) => p.id)).toEqual([x]);
    const abc1 = je.ABC?.issues.find((i) => i.schluessel === 'ABC-1');
    expect(abc1).toMatchObject({
      sitzungen: 3,
      titel: 'Login reparieren',
      status: 'In Arbeit',
      gefunden: true,
      schatten_usd_micros: 45 * M,
    });
    expect(je.ABC?.issues.find((i) => i.schluessel === 'ABC-2')).toMatchObject({
      gefunden: false,
      titel: null,
    });
    expect(je.XYZ?.schatten_usd_micros).toBe(15 * M);
    expect(je.QQ).toMatchObject({ name: null, seatmeter_projekte: [] });
    expect(je.QQ?.issues[0]).toMatchObject({ titel: null, gefunden: null });
    expect(d.titel).toMatchObject({ nachgeladen: 3, offen: 1 });
    expect(d.titel.fehler).toMatch(/HTTP 500/);

    // Zweiter Aufruf: nur das fehlerhafte Issue wird erneut angefragt.
    const vorher = jira.anfragen.filter((a) => a.pfad.includes('/issue/')).length;
    await get(`/api/v1/jira/kosten?monat=${MONAT}`, controller);
    const neu = jira.anfragen.filter((a) => a.pfad.includes('/issue/')).slice(vorher);
    expect(neu.map((a) => a.pfad.split('?')[0])).toEqual(['/cloud/rest/api/3/issue/QQ-3']);
    expect(neu[0]?.pfad).toContain('fields=summary,status');

    const c = await get(`/api/v1/jira/kosten?monat=${MONAT}&format=csv`, admin);
    expect(c.headers['content-type']).toContain('text/csv');
    expect(c.body).toContain('ABC-1;Login reparieren;In Arbeit;3;');
    expect(c.body).toContain('ohne Issue');
  });

  it('Rechte: Projektleiter sieht nur eigene Projekte, Betriebsrat und Leser keine Verbindung, RLS', async () => {
    const pl = await meldeAn(db, m, 'projektleiter', [y]);
    const d = jiraKostenAntwortSchema.parse(
      (await get(`/api/v1/jira/kosten?monat=${MONAT}`, pl)).json(),
    );
    const je = Object.fromEntries(d.jira_projekte.map((p) => [p.schluessel, p]));
    expect(Object.keys(je).sort()).toEqual(['ABC', 'XYZ']);
    expect(je.ABC?.schatten_usd_micros).toBe(5 * M);
    expect(je.ABC?.seatmeter_projekte).toEqual([]);
    expect(je.XYZ?.ohne_issue.schatten_usd_micros).toBe(5 * M);
    for (const pfad of [
      '/api/v1/jira/verbindung',
      '/api/v1/jira/zuordnung',
      '/api/v1/jira/projekte',
    ])
      expect((await get(pfad, pl)).statusCode, pfad).toBe(403);
    const br = await meldeAn(db, m, 'betriebsrat');
    expect((await get(`/api/v1/jira/kosten?monat=${MONAT}`, br)).statusCode).toBe(403);

    const f = await meldeAn(db, fremd, 'mandanten_admin');
    const leer = jiraKostenAntwortSchema.parse(
      (await get(`/api/v1/jira/kosten?monat=${MONAT}`, f)).json(),
    );
    expect(leer.jira_projekte).toEqual([]);
    expect((await get('/api/v1/jira/verbindung', f)).json()).toMatchObject({
      eingerichtet: false,
    });
  });

  it('Verbindung löschen: Zwischenspeicher weg, Positivliste zurück auf alle', async () => {
    const r = await senden('DELETE', '/api/v1/jira/verbindung', admin);
    expect(r.statusCode).toBe(204);
    const rest = await withMandant(db, m, async (trx) => ({
      cache: (await sql`SELECT 1 FROM jira_issue_cache`.execute(trx)).rows.length,
      praefixe: (await trx.selectFrom('mandant').select('issue_praefixe').executeTakeFirstOrThrow())
        .issue_praefixe,
    }));
    expect(rest).toEqual({ cache: 0, praefixe: null });
  });

  it('läuft im Kern ohne Plugin und ohne Lizenz; der alte ee-Pfad ist weg', async () => {
    expect((await get('/api/v1/jira/verbindung', admin)).statusCode).toBe(200);
    expect((await get('/api/v1/ee/jira/verbindung', admin)).statusCode).toBe(404);
    expect(app.seatmeter.plugins).toEqual([]);
  });
});
