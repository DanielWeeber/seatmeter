// Ordner ohne Git-Remote: Der Hook meldet `local-<Pfad relativ zum Home-Ordner>`, daraus wird ein gewöhnliches Projekt.
// Prüf-Route (auch bei Stufe aus), Zurechnung im Ingest, Nachtrag früherer Anfragen (nie im abgeschlossenen Monat),
// Wahl einmal je Ordner, Zuordnung und Katalog-Kosten, und dass sich kein Ordner über eine Remote-URL einschleusen lässt.
import { randomUUID } from 'node:crypto';
import {
  katalogKostenAntwortSchema,
  katalogListeSchema,
  katalogZuordnungAntwortSchema,
  projektwahlAntwortSchema,
  PROJEKTWAHL_PFAD_PRAEFIX,
  PROJEKTWAHL_PRUEF_PFAD,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aggregiereTage } from '../src/aggregation/job.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { schliesseMonat } from '../src/kalkulation/abschluss.js';
import { ordnerNeuaufbauAbwarten } from '../src/projektkatalog/ordner.js';
import { kernApp, MASTER_KEY_B64, meldeAn } from './api-hilfen.js';
import { fixture, TEST_ORG } from './ingest-hilfen.js';

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
    orgs: [TEST_ORG],
  });
  if (!e.token) throw new Error('Token fehlt');
  const admin = await meldeAn(db, e.mandantId, 'mandanten_admin');
  return { mandantId: e.mandantId, token: e.token, admin: admin.headers };
}

function pruefen(u: Umgebung, sitzung: string, ordner: string, repo = '') {
  return app.inject({
    method: 'POST',
    url: PROJEKTWAHL_PRUEF_PFAD,
    headers: {
      authorization: `Bearer ${u.token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: new URLSearchParams({ sitzung, repo, ordner }).toString(),
  });
}

/** Eine `api_request` über OTLP, ohne Repo (oder mit `repo` als `vcs.repository.url.full`). */
async function nutzung(u: Umgebung, sitzung: string, repo?: string) {
  const f = fixture('logs-api-request.json', { requestId: `req_${randomUUID()}` });
  const text = JSON.stringify(f).replaceAll('5d7f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b', sitzung);
  const koerper = JSON.parse(text) as {
    resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string }[] }[] }[] }[];
  };
  for (const rl of koerper.resourceLogs)
    for (const sl of rl.scopeLogs)
      for (const lr of sl.logRecords) {
        lr.attributes = lr.attributes.filter((a) => !a.key.startsWith('vcs.'));
        if (repo) {
          lr.attributes.push({
            key: 'vcs.repository.url.full',
            value: { stringValue: repo },
          } as { key: string });
        }
      }
  const r = await app.inject({
    method: 'POST',
    url: '/otlp/v1/logs',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(koerper),
  });
  expect(r.statusCode).toBe(200);
}

async function anfragen(u: Umgebung, sitzung: string) {
  return withMandant(db, u.mandantId, (t) =>
    t
      .selectFrom('anfrage')
      .leftJoin('projekt', 'projekt.id', 'anfrage.projekt_id')
      .select(['anfrage.projekt_id', 'projekt.url_norm', 'anfrage.tag'])
      .where('anfrage.session_id', '=', sitzung)
      .execute(),
  );
}

async function ordnerProjekte(u: Umgebung) {
  return withMandant(db, u.mandantId, (t) =>
    t
      .selectFrom('projekt')
      .select(['id', 'url_norm', 'anzeigename', 'provider'])
      .where('url_norm', 'like', 'local-%')
      .execute(),
  );
}

async function katalog(u: Umgebung) {
  const imp = await app.inject({
    method: 'POST',
    url: '/api/v1/projektkatalog/import',
    headers: u.admin,
    payload: {
      projekte: [
        { nummer: 'P-100', name: 'Webshop', kunde: 'Muster AG' },
        { nummer: 'P-200', name: 'Portal' },
      ],
      vollstaendig: true,
    },
  });
  expect(imp.statusCode).toBe(200);
  const r = await app.inject({ url: '/api/v1/projektkatalog/projekte', headers: u.admin });
  const l = katalogListeSchema.parse(r.json());
  return Object.fromEntries(l.projekte.map((p) => [p.nummer, p.id])) as Record<string, string>;
}

async function stufe(u: Umgebung, wert: 'aus' | 'warnen' | 'blockieren') {
  const r = await app.inject({
    method: 'PUT',
    url: '/api/v1/projektkatalog/einstellung',
    headers: u.admin,
    payload: { stufe: wert },
  });
  expect(r.statusCode).toBe(200);
}

function tokenAusLink(text: string): string {
  const link = text.trim().replace(/^(waehlen|warnen) /, '');
  return link.slice(link.indexOf(PROJEKTWAHL_PFAD_PRAEFIX) + PROJEKTWAHL_PFAD_PRAEFIX.length);
}

beforeAll(async () => {
  const url = inject('testDatenbankUrl');
  db = erstelleDb(url, 4);
  app = await kernApp(db, url);
});

afterAll(async () => {
  await ordnerNeuaufbauAbwarten();
  await app.close();
  await db.destroy();
});

describe('Ordner ohne Git-Remote', () => {
  it('Stufe aus: Prüf-Route meldet frei, legt Ordner-Projekt und Sitzung einmal an; ungültige Schlüssel nie', async () => {
    const u = await umgebung();
    for (let i = 0; i < 2; i += 1) {
      const r = await pruefen(u, 'sitzung-a', 'local-Claude/arbeit/code/angebot-2026');
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe('frei\n');
    }
    expect(await ordnerProjekte(u)).toEqual([
      {
        id: expect.any(String) as string,
        url_norm: 'local-Claude/arbeit/code/angebot-2026',
        anzeigename: 'Ordner Claude/arbeit/code/angebot-2026',
        provider: 'pfad',
      },
    ]);
    for (const k of ['local-/Users/alice/x', 'local-C:/x', 'local-a/../b', 'lokal-x', 'x']) {
      const r = await pruefen(u, `sitzung-${k.length}`, k);
      expect(r.statusCode, k).toBe(200);
    }
    expect(await ordnerProjekte(u)).toHaveLength(1);
    const z = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('sitzung_ordner').select('session_id').execute(),
    );
    expect(z).toEqual([{ session_id: 'sitzung-a' }]);
    // Mit Repo zählt das Repo, der Ordner wird ignoriert (der Hook schickt ihn dann ohnehin nicht).
    await pruefen(u, 'sitzung-r', 'local-anders', 'https://git.example.org/o/r.git');
    expect(await ordnerProjekte(u)).toHaveLength(1);
  });

  it('Ingest rechnet Anfragen ohne Repo der gemeldeten Sitzung zu, ein Repo geht vor', async () => {
    const u = await umgebung();
    await pruefen(u, 'sitzung-b', 'local-notizen');
    await nutzung(u, 'sitzung-b');
    await nutzung(u, 'sitzung-b', 'https://git.example.org/o/r');
    await nutzung(u, 'sitzung-fremd');
    const b = await anfragen(u, 'sitzung-b');
    expect(b.map((a) => a.url_norm).sort()).toEqual([
      'https://git.example.org/o/r',
      'local-notizen',
    ]);
    expect((await anfragen(u, 'sitzung-fremd'))[0]?.projekt_id).toBeNull();
    const s = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('sitzung')
        .innerJoin('projekt', 'projekt.id', 'sitzung.projekt_id')
        .select('projekt.url_norm')
        .where('session_id', '=', 'sitzung-b')
        .executeTakeFirst(),
    );
    expect(s?.url_norm).toBe('local-notizen');
  });

  it('Nachtrag: frühere Anfragen der Sitzung bekommen den Ordner, das Tagesaggregat folgt; erste Meldung gilt', async () => {
    const u = await umgebung();
    await nutzung(u, 'sitzung-c');
    await nutzung(u, 'sitzung-c', 'https://git.example.org/o/r');
    expect((await anfragen(u, 'sitzung-c')).filter((a) => a.projekt_id === null)).toHaveLength(1);
    await pruefen(u, 'sitzung-c', 'local-kunde/skripte');
    await ordnerNeuaufbauAbwarten();
    const c = await anfragen(u, 'sitzung-c');
    expect(c.map((a) => a.url_norm).sort()).toEqual([
      'https://git.example.org/o/r',
      'local-kunde/skripte',
    ]);
    const [projekt] = await ordnerProjekte(u);
    const agg = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('tag_aggregat')
        .select(({ fn }) => fn.sum<string>('anfragen').as('n'))
        .where('projekt_id', '=', projekt?.id ?? '')
        .executeTakeFirst(),
    );
    expect(Number(agg?.n)).toBe(1);
    // Ein anderer Ordner in derselben Sitzung ändert nichts.
    await pruefen(u, 'sitzung-c', 'local-anderer');
    expect((await anfragen(u, 'sitzung-c')).map((a) => a.url_norm).sort()).toEqual([
      'https://git.example.org/o/r',
      'local-kunde/skripte',
    ]);
  });

  it('Nachtrag lässt einen abgeschlossenen Monat unverändert', async () => {
    const u = await umgebung();
    await nutzung(u, 'sitzung-d');
    const [a] = await anfragen(u, 'sitzung-d');
    const tag = String(a?.tag);
    await aggregiereTage(db, u.mandantId, tag, tag);
    await schliesseMonat(db, u.mandantId, tag.slice(0, 7));
    const geschlossen = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('monatsabschluss').select('monat').limit(1).execute(),
    );
    expect(geschlossen).toHaveLength(1);
    await pruefen(u, 'sitzung-d', 'local-alt');
    await ordnerNeuaufbauAbwarten();
    expect((await anfragen(u, 'sitzung-d'))[0]?.projekt_id).toBeNull();
  });

  it('Stufe blockieren: Wahl einmal je Ordner, gilt für alle Sitzungen darin; Zuordnung und Kosten wie ein Repo', async () => {
    const u = await umgebung();
    const ids = await katalog(u);
    await stufe(u, 'blockieren');
    const erste = await pruefen(u, 'sitzung-e1', 'local-angebote');
    expect(erste.body).toMatch(/^waehlen /);
    const token = tokenAusLink(erste.body);
    const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
    const seite = projektwahlAntwortSchema.parse(
      (
        await app.inject({ url: `/api/v1/projektwahl?token=${token}`, headers: entwickler.headers })
      ).json(),
    );
    expect(seite.ziel).toEqual({ art: 'ordner', name: 'Ordner angebote' });
    const wahl = await app.inject({
      method: 'POST',
      url: '/api/v1/projektwahl',
      headers: entwickler.headers,
      payload: { token, katalog_projekt_id: ids['P-100'] },
    });
    expect(wahl.statusCode).toBe(200);
    // Neue Sitzung im selben Ordner: schon zugeordnet. Ein anderer Ordner fragt.
    expect((await pruefen(u, 'sitzung-e2', 'local-angebote')).body).toBe('zugeordnet\n');
    const link3 = (await pruefen(u, 'sitzung-e3', 'local-anderes')).body;
    const link4 = (await pruefen(u, 'sitzung-e4', 'local-anderes')).body;
    expect(link3).toMatch(/^waehlen /);
    // Erste Wahl je Ordner gilt; eine zweite aus einer anderen Sitzung ändert nichts.
    const waehle = (link: string, katalogId: string | undefined) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/projektwahl',
        headers: entwickler.headers,
        payload: { token: tokenAusLink(link), katalog_projekt_id: katalogId },
      });
    expect((await waehle(link3, ids['P-200'])).statusCode).toBe(200);
    expect((await waehle(link4, ids['P-100'])).statusCode).toBe(409);

    // Nutzung der zweiten Sitzung: Kosten beim gewählten Katalog-Projekt, nicht bei einer alten Wahl je Sitzung.
    await withMandant(db, u.mandantId, (t) =>
      t
        .insertInto('sitzung_katalog')
        .values({
          mandant_id: u.mandantId,
          session_id: 'sitzung-e2',
          katalog_projekt_id: ids['P-200'] ?? '',
        })
        .execute(),
    );
    await nutzung(u, 'sitzung-e2');
    const [a] = await anfragen(u, 'sitzung-e2');
    const tag = String(a?.tag);
    await aggregiereTage(db, u.mandantId, tag, tag);
    const k = katalogKostenAntwortSchema.parse(
      (
        await app.inject({
          url: `/api/v1/projektkatalog/kosten?monat=${tag.slice(0, 7)}`,
          headers: u.admin,
        })
      ).json(),
    );
    expect(k.projekte.find((p) => p.nummer === 'P-100')?.anfragen).toBe(1);
    expect(k.projekte.find((p) => p.nummer === 'P-200')?.sitzungen_ohne_repo ?? 0).toBe(0);
  });

  it('eine frühere Wahl je Sitzung wird die Wahl des Ordners, statt mit dem Nachtrag verloren zu gehen', async () => {
    const u = await umgebung();
    const ids = await katalog(u);
    await stufe(u, 'blockieren');
    await nutzung(u, 'sitzung-h');
    await withMandant(db, u.mandantId, (t) =>
      t
        .insertInto('sitzung_katalog')
        .values({
          mandant_id: u.mandantId,
          session_id: 'sitzung-h',
          katalog_projekt_id: ids['P-200'] ?? '',
        })
        .execute(),
    );
    expect((await pruefen(u, 'sitzung-h', 'local-alt-gewaehlt')).body).toBe('zugeordnet\n');
    await ordnerNeuaufbauAbwarten();
    const [a] = await anfragen(u, 'sitzung-h');
    expect(a?.url_norm).toBe('local-alt-gewaehlt');
    // Andere Sitzungen im Ordner: schon zugeordnet.
    expect((await pruefen(u, 'sitzung-h2', 'local-alt-gewaehlt')).body).toBe('zugeordnet\n');
    const k = katalogKostenAntwortSchema.parse(
      (
        await app.inject({
          url: `/api/v1/projektkatalog/kosten?monat=${String(a?.tag).slice(0, 7)}`,
          headers: u.admin,
        })
      ).json(),
    );
    expect(k.projekte.find((p) => p.nummer === 'P-200')?.anfragen).toBe(1);
  });

  it('Zuordnung: Ordner erscheint schon vor der ersten Nutzung und lässt sich verknüpfen', async () => {
    const u = await umgebung();
    const ids = await katalog(u);
    await pruefen(u, 'sitzung-f', 'local-intern/tools');
    const liste = async () =>
      katalogZuordnungAntwortSchema.parse(
        (await app.inject({ url: '/api/v1/projektkatalog/zuordnung', headers: u.admin })).json(),
      ).zuordnung;
    const [z] = await liste();
    expect(z?.projekt_name).toBe('Ordner intern/tools');
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: { zuordnung: [{ projekt_id: z?.projekt_id, katalog_projekt_id: ids['P-200'] }] },
    });
    expect(r.statusCode).toBe(200);
    expect((await liste())[0]?.katalog?.nummer).toBe('P-200');
  });

  it('kein Ordner über eine Remote-URL: weder Prüf-Route noch Ingest legen `local-…` an', async () => {
    const u = await umgebung();
    await pruefen(u, 'sitzung-g', '', 'local-geheim/pfad');
    await nutzung(u, 'sitzung-g', 'local-geheim/pfad');
    await nutzung(u, 'sitzung-g', 'https://local-geheim/pfad');
    expect(await ordnerProjekte(u)).toEqual([]);
    const alle = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('projekt').select('url_norm').execute(),
    );
    expect(alle.every((p) => !p.url_norm?.startsWith('local-'))).toBe(true);
  });
});
