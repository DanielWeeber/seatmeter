// Projektkosten als Baum: Summen mit Nachfahren, nichts doppelt, Sicht der Projektleitung, abgeschlossene Monate und CSV.
// Nur erfundene Daten.
import { randomUUID } from 'node:crypto';
import {
  katalogKostenAntwortSchema,
  katalogListeSchema,
  katalogPushAntwortSchema,
  katalogTokenNeuSchema,
  type KatalogKostenAntwort,
  type KatalogKostenProjekt,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aggregiereTage } from '../src/aggregation/job.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { schliesseMonat } from '../src/kalkulation/abschluss.js';
import { mitSummen } from '../src/projektkatalog/kosten.js';
import { kernApp, legePersonAn, legeProjektAn, MASTER_KEY_B64, meldeAn } from './api-hilfen.js';
import { tagAggregat } from './modul-hilfen.js';

const MASTER = Buffer.from(MASTER_KEY_B64, 'base64');
const PFAD = '/api/v1/projektkatalog/projekte';
const MONAT = new Date().toISOString().slice(0, 7);
const TAG = `${MONAT}-15`;
const USD = 1_000_000;
const FOLGEMONAT = new Date(Date.UTC(Number(MONAT.slice(0, 4)), Number(MONAT.slice(5, 7)), 1))
  .toISOString()
  .slice(0, 7);

let db: Db;
let app: FastifyInstance;

interface Umgebung {
  mandantId: string;
  admin: Record<string, string>;
  token: string;
  person: string;
}

async function umgebung(): Promise<Umgebung> {
  const e = await mandantAnlegen(db, MASTER, {
    slug: `t-${randomUUID()}`,
    name: 'Testmandant',
    orgs: [],
  });
  const { headers: admin } = await meldeAn(db, e.mandantId, 'mandanten_admin');
  const t = await app.inject({
    method: 'POST',
    url: '/api/v1/projektkatalog/tokens',
    headers: admin,
    payload: { bezeichnung: 'Lauf', scope: 'katalog_api' },
  });
  expect(t.statusCode).toBe(201);
  return {
    mandantId: e.mandantId,
    admin,
    token: katalogTokenNeuSchema.parse(t.json()).token,
    person: await legePersonAn(db, e.mandantId),
  };
}

async function senden(u: Umgebung, id: string, koerper: Record<string, unknown>) {
  const r = await app.inject({
    method: 'PUT',
    url: `${PFAD}/${id}`,
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(koerper),
  });
  expect(r.statusCode, r.body).toBe(200);
  return katalogPushAntwortSchema.parse(r.json());
}

async function katalogId(u: Umgebung, externeId: string): Promise<string> {
  const r = await app.inject({ url: `${PFAD}?aktiv=0`, headers: u.admin });
  const p = katalogListeSchema.parse(r.json()).projekte.find((x) => x.externe_id === externeId);
  if (!p) throw new Error(`Katalog-Projekt ${externeId} fehlt`);
  return p.id;
}

/** Repo mit Nutzung, optional einem Katalog-Projekt zugeordnet. */
async function repo(u: Umgebung, name: string, usd: number, externeId?: string): Promise<string> {
  const id = await legeProjektAn(db, u.mandantId, name);
  await tagAggregat(db, u.mandantId, [{ tag: TAG, person: u.person, projekt: id, usd }]);
  if (externeId) {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: {
        zuordnung: [{ projekt_id: id, katalog_projekt_id: await katalogId(u, externeId) }],
      },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
  return id;
}

async function kosten(u: Umgebung, kopf = u.admin, monat = MONAT): Promise<KatalogKostenAntwort> {
  const r = await app.inject({
    url: `/api/v1/projektkatalog/kosten?monat=${monat}`,
    headers: kopf,
  });
  expect(r.statusCode, r.body).toBe(200);
  return katalogKostenAntwortSchema.parse(r.json());
}

const je = (k: KatalogKostenAntwort, id: string): KatalogKostenProjekt => {
  const p = k.projekte.find((x) => x.externe_id === id);
  if (!p) throw new Error(`Projekt ${id} fehlt in ${k.projekte.map((x) => x.externe_id).join()}`);
  return p;
};
const form = (k: KatalogKostenAntwort) =>
  k.projekte.map((p) => [p.externe_id, p.eltern_externe_id, p.tiefe]);
const usd = (p: KatalogKostenProjekt) => [
  p.schatten_usd_micros / USD,
  p.summe.schatten_usd_micros / USD,
];

/** Was immer gelten muss: Summe aus Eigenem und Kindern, je Projekt einmal, Eltern vor Kindern, Gesamt unverändert. */
function pruefeSummen(k: KatalogKostenAntwort) {
  const ids = k.projekte.map((p) => p.externe_id);
  expect(new Set(ids).size).toBe(ids.length);
  const felder = (x: {
    schatten_usd_micros: number;
    anfragen: number;
    tokens: { gesamt: number };
  }) => [x.schatten_usd_micros, x.anfragen, x.tokens.gesamt];
  const addiere = (a: number[], b: number[]) => a.map((w, i) => w + (b[i] ?? 0));
  k.projekte.forEach((p, i) => {
    const kinder = k.projekte.filter((x) => x.eltern_externe_id === p.externe_id);
    const erwartet = kinder.reduce((s, c) => addiere(s, felder(c.summe)), felder(p));
    expect(felder(p.summe), p.externe_id).toEqual(erwartet);
    if (p.eltern_externe_id !== null) {
      expect(ids.indexOf(p.eltern_externe_id), p.externe_id).toBeLessThan(i);
    }
  });
  const eigene = k.projekte.reduce((s, p) => addiere(s, felder(p)), [0, 0, 0]);
  const wurzeln = k.projekte
    .filter((p) => p.eltern_externe_id === null)
    .reduce((s, p) => addiere(s, felder(p.summe)), [0, 0, 0]);
  expect(wurzeln).toEqual(eigene);
  const offen = k.offen.repos.reduce((s, r) => addiere(s, felder(r)), felder(k.offen.ohne_repo));
  expect(felder(k.gesamt)).toEqual(addiere(eigene, offen));
}

/** Nur das Gesamt: `pruefeSummen` vergleicht je Projekt alle Kinder und ist für große Stände zu teuer. */
function pruefeGesamt(k: KatalogKostenAntwort) {
  const eigene = k.projekte.reduce((s, p) => s + p.schatten_usd_micros, 0);
  const wurzeln = k.projekte
    .filter((p) => p.eltern_externe_id === null)
    .reduce((s, p) => s + p.summe.schatten_usd_micros, 0);
  expect(wurzeln).toBe(eigene);
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

describe('Summen im Baum', () => {
  it('Elternprojekt mit eigener Nutzung und Kindern, mehrere Ebenen, Geschwister, Offenes: nichts doppelt', async () => {
    const u = await umgebung();
    await senden(u, 'w', { name: 'Webshop', number: 'W' });
    await senden(u, 'w-2', { name: 'AP Bezahlen', number: 'W.2', parentId: 'w' });
    await senden(u, 'w-1', { name: 'AP Login', number: 'W.1', parentId: 'w' });
    await senden(u, 'w-1-1', { name: 'Passwort', number: 'W.1.1', parentId: 'w-1' });
    await senden(u, 'x', { name: 'Anderes', number: 'X' });
    await repo(u, 'eltern', 10, 'w');
    await repo(u, 'login', 4, 'w-1');
    await repo(u, 'passwort-a', 2, 'w-1-1');
    await repo(u, 'passwort-b', 1, 'w-1-1');
    await repo(u, 'bezahlen', 8, 'w-2');
    await repo(u, 'anderes', 16, 'x');
    await repo(u, 'ohne-projekt', 32);
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person: u.person, projekt: null, usd: 64 }]);

    const k = await kosten(u);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['x', null, 0],
      ['w', null, 0],
      ['w-1', 'w', 1],
      ['w-1-1', 'w-1', 2],
      ['w-2', 'w', 1],
    ]);
    expect(usd(je(k, 'w'))).toEqual([10, 25]);
    expect(usd(je(k, 'w-1'))).toEqual([4, 7]);
    expect(usd(je(k, 'w-1-1'))).toEqual([3, 3]);
    expect(usd(je(k, 'w-2'))).toEqual([8, 8]);
    expect(usd(je(k, 'x'))).toEqual([16, 16]);
    // Die Summe der Seite: alles einmal, auch das Offene.
    expect(k.gesamt.schatten_usd_micros / USD).toBe(10 + 4 + 3 + 8 + 16 + 32 + 64);
    expect(je(k, 'w').repos.map((r) => r.name)).toEqual(['test/eltern']);
  });

  it('Elternprojekt ohne eigene Nutzung erscheint, wenn ein Nachfahre welche hat; sonst nicht', async () => {
    const u = await umgebung();
    await senden(u, 'oben', { name: 'Oben' });
    await senden(u, 'mitte', { name: 'Mitte', parentId: 'oben' });
    await senden(u, 'unten', { name: 'Unten', parentId: 'mitte' });
    await senden(u, 'leer', { name: 'Leer' });
    await senden(u, 'leer-kind', { name: 'Leeres Kind', parentId: 'leer' });
    await repo(u, 'unten', 5, 'unten');
    const k = await kosten(u);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['oben', null, 0],
      ['mitte', 'oben', 1],
      ['unten', 'mitte', 2],
    ]);
    expect(usd(je(k, 'oben'))).toEqual([0, 5]);
    expect(je(k, 'oben').repos).toEqual([]);
    expect(je(k, 'unten').pfad).toBe('Oben › Mitte › Unten');
  });

  it('inaktives Elternprojekt steht mit seinen Kosten da', async () => {
    const u = await umgebung();
    await senden(u, 'zu', { name: 'Geschlossen' });
    await senden(u, 'zu-kind', { name: 'Offen darunter', parentId: 'zu' });
    await senden(u, 'zu-leer', { name: 'Inaktiv ohne alles', status: 'closed' });
    await repo(u, 'alt', 7, 'zu');
    await repo(u, 'neu', 3, 'zu-kind');
    // Erst zugeordnet, dann geschlossen: Inaktive lassen sich nicht neu wählen.
    await senden(u, 'zu', { name: 'Geschlossen', status: 'closed' });
    const k = await kosten(u);
    pruefeSummen(k);
    expect(usd(je(k, 'zu'))).toEqual([7, 10]);
    expect(k.projekte.map((p) => p.externe_id)).not.toContain('zu-leer');
  });

  it('nie gesendetes Elternprojekt: keine Zeile, die Kinder stehen oben', async () => {
    const u = await umgebung();
    await senden(u, 'a', { name: 'A', parentId: 'nie-gesendet' });
    await senden(u, 'b', { name: 'B', parentId: 'nie-gesendet' });
    await repo(u, 'a', 1, 'a');
    await repo(u, 'b', 2, 'b');
    const k = await kosten(u);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['a', null, 0],
      ['b', null, 0],
    ]);
    expect(JSON.stringify(k)).not.toContain('nie-gesendet');
  });

  it('Zyklus und Selbstbezug: Es hängt nichts, nichts geht verloren, nichts zählt doppelt', async () => {
    const u = await umgebung();
    await senden(u, 'z1', { name: 'Z1', parentId: 'z2' });
    await senden(u, 'z2', { name: 'Z2', parentId: 'z3' });
    await senden(u, 'z3', { name: 'Z3', parentId: 'z1' });
    await senden(u, 'z3-kind', { name: 'Kind am Zyklus', parentId: 'z3' });
    await senden(u, 'selbst', { name: 'Selbst', parentId: 'selbst' });
    await repo(u, 'z1', 1, 'z1');
    await repo(u, 'z2', 2, 'z2');
    await repo(u, 'z3', 4, 'z3');
    await repo(u, 'kind', 8, 'z3-kind');
    await repo(u, 'selbst', 16, 'selbst');
    const k = await kosten(u);
    pruefeSummen(k);
    expect(k.projekte.map((p) => p.externe_id).sort()).toEqual(
      ['selbst', 'z1', 'z2', 'z3', 'z3-kind'].sort(),
    );
    expect(usd(je(k, 'z1'))).toEqual([1, 1]);
    expect(usd(je(k, 'z2'))).toEqual([2, 2]);
    expect(usd(je(k, 'z3'))).toEqual([4, 12]);
    expect(usd(je(k, 'selbst'))).toEqual([16, 16]);
    expect(k.gesamt.schatten_usd_micros / USD).toBe(31);
  });

  it('Tiefengrenze: Die Kette bricht um, aber jedes Projekt zählt einmal', async () => {
    const u = await umgebung();
    let vor: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const id = `k-${String(i).padStart(2, '0')}`;
      ids.push(id);
      await senden(u, id, { name: `Kette ${i}`, ...(vor ? { parentId: vor } : {}) });
      vor = id;
    }
    await repo(u, 'oben', 1, 'k-00');
    await repo(u, 'mitte', 4, 'k-20');
    await repo(u, 'unten', 2, 'k-24');
    const k = await kosten(u);
    pruefeSummen(k);
    expect(k.projekte.map((p) => p.externe_id)).toEqual(ids);
    expect(k.projekte.filter((p) => p.eltern_externe_id === null).map((p) => p.externe_id)).toEqual(
      ['k-00', 'k-21'],
    );
    expect(usd(je(k, 'k-00'))).toEqual([1, 5]);
    expect(usd(je(k, 'k-21'))).toEqual([0, 2]);
    expect(k.gesamt.schatten_usd_micros / USD).toBe(7);
  });
});

describe('Summen als reine Funktion', () => {
  it('ein Projekt, das erst nach dem Laden des Katalogs entstand, geht nicht verloren', () => {
    const NULL = {
      tokens: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cache_write_1h: 0,
        web_search: 0,
        gesamt: 0,
      },
      anfragen: 0,
      schatten_usd_micros: 0,
    };
    const eigene = {
      externe_id: 'spaet',
      nummer: 'S',
      name: 'Spät',
      pfad: 'Spät',
      kunde: null,
      repos: [],
      ohne_repo: NULL,
      sitzungen_ohne_repo: 1,
      ...NULL,
      schatten_usd_micros: 5,
    };
    const p = mitSummen(new Map([['spaet', eigene]]), []);
    expect(p.map((x) => [x.externe_id, x.eltern_externe_id, x.summe.schatten_usd_micros])).toEqual([
      ['spaet', null, 5],
    ]);
  });
});

describe('Projektleitung', () => {
  /** Eltern und zwei Kinder, die Person leitet nur die genannten Repos. */
  async function aufbau() {
    const u = await umgebung();
    await senden(u, 'p', { name: 'Eltern', number: 'P' });
    await senden(u, 'p-1', { name: 'Kind eins', number: 'P.1', parentId: 'p' });
    await senden(u, 'p-2', { name: 'Kind zwei', number: 'P.2', parentId: 'p' });
    await senden(u, 'p-1-1', { name: 'Enkel', number: 'P.1.1', parentId: 'p-1' });
    const eltern = await repo(u, 'eltern', 100, 'p');
    const eins = await repo(u, 'eins', 20, 'p-1');
    const zwei = await repo(u, 'zwei', 3, 'p-2');
    const enkel = await repo(u, 'enkel', 4, 'p-1-1');
    const offen = await repo(u, 'offen', 50);
    return { u, eltern, eins, zwei, enkel, offen };
  }

  it('Kind ohne sichtbares Elternprojekt steht oben; versteckte Kosten kommen in keiner Summe an', async () => {
    const { u, zwei } = await aufbau();
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [zwei]);
    const k = await kosten(u, leitung.headers);
    pruefeSummen(k);
    expect(form(k)).toEqual([['p-2', null, 0]]);
    expect(usd(je(k, 'p-2'))).toEqual([3, 3]);
    expect(k.gesamt.schatten_usd_micros / USD).toBe(3);
    expect(k.eingeschraenkt).toBe(true);
    expect((await kosten(u)).eingeschraenkt).toBe(false);
    // Zeilen, Repos und Beträge der verborgenen Projekte stehen nirgends in der Antwort.
    const roh = JSON.stringify(k);
    for (const versteckt of ['"p"', 'p-1', 'test/eltern', 'test/eins', 'test/offen']) {
      expect(roh).not.toContain(versteckt);
    }
    for (const betrag of [100, 20, 4, 50, 120, 123, 127, 177]) {
      expect(roh, String(betrag)).not.toContain(String(betrag * USD));
    }
  });

  it('Projektnamen sind nicht geheim: Der Pfad nennt das fremde Elternprojekt, die Katalogliste auch, Beträge bleiben verborgen', async () => {
    const { u, zwei } = await aufbau();
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [zwei]);
    const k = await kosten(u, leitung.headers);
    expect(je(k, 'p-2').pfad).toBe('Eltern › Kind zwei');
    expect(k.projekte.map((p) => p.externe_id)).toEqual(['p-2']);

    const liste = await app.inject({ url: `${PFAD}?aktiv=0`, headers: leitung.headers });
    expect(liste.statusCode).toBe(200);
    const namen = katalogListeSchema.parse(liste.json()).projekte.map((p) => p.name);
    expect(namen).toEqual(expect.arrayContaining(['Eltern', 'Kind eins', 'Enkel']));
    expect(liste.body).not.toContain('schatten_usd_micros');

    // Auch im abgeschlossenen Monat: Name ja, Beträge nein.
    await schliesseMonat(db, u.mandantId, MONAT);
    const zu = await kosten(u, leitung.headers);
    expect(zu.quelle).toBe('monatsabschluss');
    expect(je(zu, 'p-2').pfad).toBe('Eltern › Kind zwei');
    expect(zu.projekte.map((p) => p.externe_id)).toEqual(['p-2']);
    expect(zu.gesamt.schatten_usd_micros).toBe(3 * USD);
    expect(JSON.stringify(zu)).not.toContain(String(100 * USD));
  });

  it('sichtbares Elternprojekt: Die Summe enthält nur sichtbare Kinder', async () => {
    const { u, eltern, eins } = await aufbau();
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [eltern, eins]);
    const k = await kosten(u, leitung.headers);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['p', null, 0],
      ['p-1', 'p', 1],
    ]);
    expect(usd(je(k, 'p'))).toEqual([100, 120]);
    expect(usd(je(k, 'p-1'))).toEqual([20, 20]);
    // Der Admin sieht zum Vergleich alles.
    const alles = await kosten(u);
    expect(usd(je(alles, 'p'))).toEqual([100, 127]);
    expect(alles.gesamt.schatten_usd_micros / USD).toBe(177);
  });

  it('versteckte Mitte: Der Enkel steht oben und zählt beim Großelternprojekt nicht', async () => {
    const { u, eltern, enkel } = await aufbau();
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [eltern, enkel]);
    const k = await kosten(u, leitung.headers);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['p', null, 0],
      ['p-1-1', null, 0],
    ]);
    expect(usd(je(k, 'p'))).toEqual([100, 100]);
    expect(usd(je(k, 'p-1-1'))).toEqual([4, 4]);
  });

  it('keine eigenen Repos: leere Antwort', async () => {
    const { u } = await aufbau();
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', []);
    const k = await kosten(u, leitung.headers);
    expect(k.projekte).toEqual([]);
    expect(k.gesamt.schatten_usd_micros).toBe(0);
    expect(k.eingeschraenkt).toBe(true);
  });
});

describe('Wer welche Repos sieht, wie in der Betriebsrats-Vorlage und der Architektur beschrieben', () => {
  it('Admin, Controller und Betriebsrat alle mit URL und Betrag, Projektleitung die zugewiesenen, entwickler keine', async () => {
    const u = await umgebung();
    const a = await repo(u, 'repo-a', 2);
    await repo(u, 'repo-b', 3);
    const projekte = (kopf: Record<string, string>) =>
      app.inject({ url: `/api/v1/projekte?monat=${MONAT}`, headers: kopf });
    const zeilen = async (kopf: Record<string, string>) => {
      const r = await projekte(kopf);
      expect(r.statusCode, r.body).toBe(200);
      return r
        .json<{ projekte: { url_norm: string | null; schatten_usd_micros: number }[] }>()
        .projekte.map((p) => [p.url_norm, p.schatten_usd_micros / USD])
        .sort();
    };
    const alle = [
      ['https://git.example.org/test/repo-a', 2],
      ['https://git.example.org/test/repo-b', 3],
    ];
    for (const rolle of ['mandanten_admin', 'controller', 'betriebsrat'] as const) {
      expect(await zeilen((await meldeAn(db, u.mandantId, rolle)).headers), rolle).toEqual(alle);
    }
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [a]);
    expect(await zeilen(leitung.headers)).toEqual([alle[0]]);
    const entwickler = await meldeAn(db, u.mandantId, 'entwickler');
    expect((await projekte(entwickler.headers)).statusCode).toBe(403);
    // Projektpreise mit Sitzkosten-Anteil: nicht für den Betriebsrat.
    const rat = await meldeAn(db, u.mandantId, 'betriebsrat');
    const preise = await app.inject({
      url: `/api/v1/kalkulation?monat=${MONAT}`,
      headers: rat.headers,
    });
    expect(preise.statusCode).toBe(403);
    // Keine Personensicht für den Betriebsrat.
    const personen = await app.inject({
      url: `/api/v1/personen?monat=${MONAT}`,
      headers: rat.headers,
    });
    expect(personen.statusCode).toBe(403);
  });
});

describe('Abgeschlossene Monate', () => {
  async function aufbau() {
    const u = await umgebung();
    await senden(u, 'alt', { name: 'Alter Name', number: 'A' });
    await senden(u, 'anders', { name: 'Anderes Eltern', number: 'B' });
    await senden(u, 'kind', { name: 'Kind', number: 'A.1', parentId: 'alt' });
    await senden(u, 'enkel', { name: 'Enkel', number: 'A.1.1', parentId: 'kind' });
    const enkel = await repo(u, 'enkel', 3, 'enkel');
    const kind = await repo(u, 'kind', 2, 'kind');
    await repo(u, 'offen', 9);
    return { u, enkel, kind };
  }

  it('Umhängen und Umbenennen ändern den Stand nicht; ein offener Monat zeigt die neue Hierarchie', async () => {
    const { u, kind } = await aufbau();
    expect((await schliesseMonat(db, u.mandantId, MONAT)).status).toBe('angelegt');
    const vorher = await kosten(u);
    expect(vorher.quelle).toBe('monatsabschluss');
    pruefeSummen(vorher);
    expect(form(vorher)).toEqual([
      ['alt', null, 0],
      ['kind', 'alt', 1],
      ['enkel', 'kind', 2],
    ]);
    // Das Elternprojekt ohne eigene Nutzung steht im Stand, mit Summe.
    expect(usd(je(vorher, 'alt'))).toEqual([0, 5]);
    expect(je(vorher, 'enkel').pfad).toBe('Alter Name › Kind › Enkel');

    await senden(u, 'kind', { name: 'Kind umbenannt', number: 'A.1', parentId: 'anders' });
    await senden(u, 'alt', { name: 'Neuer Name', number: 'A' });
    expect(await kosten(u)).toEqual(vorher);

    await tagAggregat(db, u.mandantId, [
      { tag: `${FOLGEMONAT}-15`, person: u.person, projekt: kind, usd: 4 },
    ]);
    const danach = await kosten(u, u.admin, FOLGEMONAT);
    expect(danach.quelle).toBe('live');
    pruefeSummen(danach);
    expect(form(danach)).toEqual([
      ['anders', null, 0],
      ['kind', 'anders', 1],
      ['enkel', 'kind', 2],
    ]);
    expect(je(danach, 'kind').pfad).toBe('Anderes Eltern › Kind umbenannt');
  });

  it('Projektleitung im Stand: nur eigene Zeilen, keine leeren Eltern, keine fremden Beträge', async () => {
    const { u, enkel } = await aufbau();
    await schliesseMonat(db, u.mandantId, MONAT);
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [enkel]);
    const k = await kosten(u, leitung.headers);
    expect(k.quelle).toBe('monatsabschluss');
    pruefeSummen(k);
    expect(form(k)).toEqual([['enkel', null, 0]]);
    expect(usd(je(k, 'enkel'))).toEqual([3, 3]);
    expect(k.gesamt.schatten_usd_micros / USD).toBe(3);
    expect(k.eingeschraenkt).toBe(true);
    expect(JSON.stringify(k)).not.toContain('test/kind');
  });

  it('vor der Migration abgeschlossen: ohne Elternprojekt flach, Summen gleich den eigenen Werten', async () => {
    const { u } = await aufbau();
    await schliesseMonat(db, u.mandantId, MONAT);
    const mitBaum = await kosten(u);
    await withMandant(db, u.mandantId, async (t) => {
      await t.updateTable('katalog_abschluss').set({ parent_externe_id: null }).execute();
      // Damals gab es auch keine leeren Zeilen für Vorfahren.
      await t
        .deleteFrom('katalog_abschluss')
        .where('externe_id', '=', 'alt')
        .where('sitzungen', '=', 0)
        .execute();
    });
    const k = await kosten(u);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['enkel', null, 0],
      ['kind', null, 0],
    ]);
    expect(usd(je(k, 'kind'))).toEqual([2, 2]);
    expect(k.gesamt).toEqual(mitBaum.gesamt);
  });

  it('erzwungener neuer Abschluss nimmt die aktuelle Hierarchie, die Beträge bleiben', async () => {
    const { u } = await aufbau();
    await schliesseMonat(db, u.mandantId, MONAT);
    const vorher = await kosten(u);
    await senden(u, 'kind', { name: 'Kind', number: 'A.1', parentId: 'anders' });
    expect((await schliesseMonat(db, u.mandantId, MONAT)).status).toBe('vorhanden');
    expect(await kosten(u)).toEqual(vorher);
    expect((await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true })).status).toBe(
      'ueberschrieben',
    );
    const k = await kosten(u);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['anders', null, 0],
      ['kind', 'anders', 1],
      ['enkel', 'kind', 2],
    ]);
    expect(k.gesamt).toEqual(vorher.gesamt);
    // Keine leere Zeile bleibt vom alten Stand übrig.
    const alt = await withMandant(db, u.mandantId, (t) =>
      t.selectFrom('katalog_abschluss').select('id').where('externe_id', '=', 'alt').execute(),
    );
    expect(alt).toEqual([]);
  });

  it('erneuter Abschluss nach gelöschten Einzelanfragen: Sitzungen bleiben einmal, Hierarchie aktuell, keine Dubletten', async () => {
    const u = await umgebung();
    await senden(u, 'oben', { name: 'Oben', number: 'O' });
    await senden(u, 'anders', { name: 'Anders', number: 'P' });
    await senden(u, 'nur-sitzung', { name: 'Nur Sitzung', number: 'O.1', parentId: 'oben' });
    await sql`
      INSERT INTO anfrage (mandant_id, anfrage_key, ts, tag, session_id, person_id, projekt_id, model,
        auth_klasse, zaehlt_als_abo, input, output, cache_read, cache_write, quellen)
      VALUES (${u.mandantId}::uuid, ${`msg:${randomUUID()}`}, ${`${TAG}T10:00:00Z`}::timestamptz, ${TAG}::date,
        's-1', ${u.person}::uuid, NULL, 'claude-opus-5-5', 'abo', true, 1000, 500, 0, 0, 1)`.execute(
      db,
    );
    const katalogProjekt = await katalogId(u, 'nur-sitzung');
    await withMandant(db, u.mandantId, (t) =>
      t
        .insertInto('sitzung_katalog')
        .values({
          mandant_id: u.mandantId,
          session_id: 's-1',
          katalog_projekt_id: katalogProjekt,
        })
        .execute(),
    );
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person: u.person, projekt: null, usd: 1 }]);
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    const vorher = await kosten(u);
    pruefeSummen(vorher);
    expect(je(vorher, 'nur-sitzung').sitzungen_ohne_repo).toBe(1);
    expect(je(vorher, 'nur-sitzung').eltern_externe_id).toBe('oben');
    expect(je(vorher, 'oben').summe.schatten_usd_micros).toBe(
      je(vorher, 'nur-sitzung').schatten_usd_micros,
    );

    await sql`DELETE FROM anfrage WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    await sql`DELETE FROM sitzung_katalog WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    await senden(u, 'nur-sitzung', { name: 'Nur Sitzung', number: 'O.1', parentId: 'anders' });
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    const k = await kosten(u);
    pruefeSummen(k);
    expect(form(k)).toEqual([
      ['anders', null, 0],
      ['nur-sitzung', 'anders', 1],
    ]);
    expect(je(k, 'nur-sitzung').ohne_repo).toEqual(je(vorher, 'nur-sitzung').ohne_repo);
    expect(k.gesamt).toEqual(vorher.gesamt);
    const zeilen = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('katalog_abschluss')
        .select('externe_id')
        .where('externe_id', '=', 'nur-sitzung')
        .execute(),
    );
    expect(zeilen).toHaveLength(1);
  });

  it('gleichzeitige Abschlüsse: Die Beträge stehen einmal da, nie doppelt', async () => {
    const { u } = await aufbau();
    const zeilenZahl = () =>
      withMandant(db, u.mandantId, async (t) => ({
        katalog: (await t.selectFrom('katalog_abschluss').select('id').execute()).length,
        monat: (await t.selectFrom('monatsabschluss').select('projekt_id').execute()).length,
      }));
    await schliesseMonat(db, u.mandantId, MONAT);
    const vorher = await kosten(u);
    const zeilen = await zeilenZahl();
    for (let runde = 0; runde < 3; runde += 1) {
      const stati = await Promise.all(
        Array.from({ length: 3 }, () =>
          schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true }),
        ),
      );
      expect(stati.map((s) => s.status)).toEqual(Array(3).fill('ueberschrieben'));
      expect(await kosten(u)).toEqual(vorher);
      expect(await zeilenZahl()).toEqual(zeilen);
    }
    // Ohne Erzwingen gewinnt einer, die anderen melden den vorhandenen Stand.
    const v = await umgebung();
    await senden(v, 'a', { name: 'A', number: 'A' });
    await repo(v, 'r', 10, 'a');
    const erste = await Promise.all(
      Array.from({ length: 3 }, () => schliesseMonat(db, v.mandantId, MONAT)),
    );
    expect(erste.map((s) => s.status).sort()).toEqual(['angelegt', 'vorhanden', 'vorhanden']);
    expect((await kosten(v)).gesamt.schatten_usd_micros).toBe(10 * USD);
  });

  it('Nummer und Name kommen von den Repo-Zeilen, unabhängig von der Reihenfolge im Stand', async () => {
    const u = await umgebung();
    await senden(u, 'a', { name: 'Alter Name', number: 'ALT', customer: 'Alter Kunde' });
    await repo(u, 'r', 2, 'a');
    await sql`
      INSERT INTO anfrage (mandant_id, anfrage_key, ts, tag, session_id, person_id, projekt_id, model,
        auth_klasse, zaehlt_als_abo, input, output, cache_read, cache_write, quellen)
      VALUES (${u.mandantId}::uuid, ${`msg:${randomUUID()}`}, ${`${TAG}T10:00:00Z`}::timestamptz, ${TAG}::date,
        's-1', ${u.person}::uuid, NULL, 'claude-opus-5-5', 'abo', true, 1000, 500, 0, 0, 1)`.execute(
      db,
    );
    const kp = await katalogId(u, 'a');
    await withMandant(db, u.mandantId, (t) =>
      t
        .insertInto('sitzung_katalog')
        .values({ mandant_id: u.mandantId, session_id: 's-1', katalog_projekt_id: kp })
        .execute(),
    );
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person: u.person, projekt: null, usd: 1 }]);
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    expect(je(await kosten(u), 'a').sitzungen_ohne_repo).toBe(1);

    // Einzelanfragen gelöscht, Projekt umbenannt, neuer Abschluss: Die Repo-Zeile hat die neuen Namen, die Sitzungszeile bleibt
    // eingefroren. Beide stehen nun mit verschiedenen Namen im Stand.
    await sql`DELETE FROM anfrage WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    await sql`DELETE FROM sitzung_katalog WHERE mandant_id = ${u.mandantId}::uuid`.execute(db);
    await senden(u, 'a', { name: 'Neuer Name', number: 'NEU', customer: 'Neuer Kunde' });
    await schliesseMonat(db, u.mandantId, MONAT, { erzwingen: true });
    const namen = await withMandant(db, u.mandantId, (t) =>
      t
        .selectFrom('katalog_abschluss')
        .select(['nummer', 'projekt_id'])
        .where('externe_id', '=', 'a')
        .execute(),
    );
    expect(namen.map((z) => z.nummer).sort()).toEqual(['ALT', 'NEU']);

    const erwartet = ['NEU', 'Neuer Name', 'Neuer Kunde'];
    const titel = (p: KatalogKostenProjekt) => [p.nummer, p.name, p.kunde];
    const k = await kosten(u);
    expect(titel(je(k, 'a'))).toEqual(erwartet);
    expect(je(k, 'a').sitzungen_ohne_repo).toBe(1);
    // Jede Reihenfolge im Speicher ergibt dasselbe: Neu eingefügt steht eine Zeile hinter den anderen, auch im Index.
    for (const welche of ['repo', 'sitzung'] as const) {
      await withMandant(db, u.mandantId, async (t) => {
        const zeile = await t
          .selectFrom('katalog_abschluss')
          .selectAll()
          .where('externe_id', '=', 'a')
          .where('projekt_id', welche === 'repo' ? 'is not' : 'is', null)
          .executeTakeFirstOrThrow();
        await t.deleteFrom('katalog_abschluss').where('id', '=', zeile.id).execute();
        const { id: _id, ...rest } = zeile;
        await t.insertInto('katalog_abschluss').values(rest).execute();
      });
      const nochmal = await kosten(u);
      expect(titel(je(nochmal, 'a')), welche).toEqual(erwartet);
      expect(nochmal).toEqual(k);
    }
  });

  it('mehr Zeilen, als ein INSERT Parameter fasst: Der Abschluss gelingt', async () => {
    const u = await umgebung();
    const anzahl = 3_600;
    await withMandant(db, u.mandantId, async (t) => {
      await sql`
        INSERT INTO katalog_projekt (mandant_id, externe_id, name, quelle)
        SELECT ${u.mandantId}::uuid, 'g-' || i, 'Groß ' || i, 'api' FROM generate_series(1, ${anzahl}) i`.execute(
        t,
      );
      await sql`
        INSERT INTO projekt (mandant_id, projekt_key, url_norm, repo_name, owner)
        SELECT ${u.mandantId}::uuid, sha256(('g-' || i)::bytea), 'https://git.example.org/g/' || i, 'r' || i, 'g'
        FROM generate_series(1, ${anzahl}) i`.execute(t);
      await sql`
        INSERT INTO projekt_katalog (mandant_id, projekt_id, katalog_projekt_id)
        SELECT ${u.mandantId}::uuid, p.id, k.id
        FROM projekt p JOIN katalog_projekt k ON k.externe_id = 'g-' || substr(p.url_norm, 27)`.execute(
        t,
      );
      await sql`
        INSERT INTO tag_aggregat (mandant_id, tag, person_id, projekt_id, model, speed, auth_klasse, anfragen,
          schatten_usd_micros, preis_version)
        SELECT ${u.mandantId}::uuid, ${TAG}::date, ${u.person}::uuid, p.id, 'claude-opus-5-5', 'normal', 'abo', 1,
          1000000, 'global:claude-opus-5@2026-01-01' FROM projekt p`.execute(t);
    });
    expect((await schliesseMonat(db, u.mandantId, MONAT)).status).toBe('angelegt');
    const zaehlen = (tabelle: 'katalog_abschluss' | 'monatsabschluss') =>
      withMandant(db, u.mandantId, (t) =>
        t
          .selectFrom(tabelle)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow(),
      );
    expect(Number((await zaehlen('katalog_abschluss')).n)).toBeGreaterThan(anzahl);
    expect(Number((await zaehlen('monatsabschluss')).n)).toBeGreaterThanOrEqual(anzahl);
    const k = await kosten(u);
    expect(k.quelle).toBe('monatsabschluss');
    expect(k.projekte).toHaveLength(anzahl);
    expect(k.gesamt.schatten_usd_micros).toBe(anzahl * USD);
    pruefeGesamt(k);
  }, 60_000);
});

describe('CSV', () => {
  const SUMME = 'Summe mit Unterprojekten USD (nicht addieren)';

  async function datei(u: Umgebung, kopf = u.admin) {
    const r = await app.inject({
      url: `/api/v1/projektkatalog/kosten?monat=${MONAT}&format=csv`,
      headers: kopf,
    });
    expect(r.statusCode, r.body).toBe(200);
    const [titel, ...zeilen] = r.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
      .map((z) => z.split(';').map((f) => f.replace(/^"|"$/g, '')));
    const namen = titel ?? [];
    return {
      roh: r.body,
      namen,
      zeilen: zeilen.map((z) => {
        expect(z).toHaveLength(namen.length);
        return Object.fromEntries(namen.map((n, i) => [n, z[i] ?? '']));
      }),
    };
  }
  const betrag = (t: string | undefined) => Math.round(Number((t ?? '').replace(',', '.')) * USD);
  const summe = (zeilen: Record<string, string>[], spalte: string) =>
    zeilen.reduce((s, z) => s + betrag(z[spalte]), 0);

  async function aufbau() {
    const u = await umgebung();
    await senden(u, 'e', { name: 'Eltern', number: 'E' });
    await senden(u, 'k', { name: 'Kind', number: 'E.1', parentId: 'e' });
    await senden(u, 'n', { name: 'Enkel', number: 'E.1.1', parentId: 'k' });
    await senden(u, 'x', { name: 'Ohne Nutzung oben', number: 'X' });
    await senden(u, 'x-1', { name: 'Nutzung unten', number: 'X.1', parentId: 'x' });
    const e1 = await repo(u, 'e-eins', 10, 'e');
    await repo(u, 'e-zwei', 5, 'e');
    const k1 = await repo(u, 'k-eins', 2.5, 'k');
    await repo(u, 'n-eins', 1, 'n');
    await repo(u, 'x-eins', 4, 'x-1');
    await repo(u, 'offen', 8);
    await tagAggregat(db, u.mandantId, [{ tag: TAG, person: u.person, projekt: null, usd: 16 }]);
    return { u, e1, k1 };
  }

  describe('Preisunterschied nach geänderter Cache-Annahme ist keine Nutzung', () => {
    async function anfrageMitCache(u: Umgebung, sitzung: string) {
      await sql`
        INSERT INTO anfrage (mandant_id, anfrage_key, ts, tag, session_id, person_id, projekt_id, model,
          auth_klasse, zaehlt_als_abo, input, output, cache_read, cache_write, quellen)
        VALUES (${u.mandantId}::uuid, ${`msg:${randomUUID()}`}, ${`${TAG}T10:00:00Z`}::timestamptz, ${TAG}::date,
          ${sitzung}, ${u.person}::uuid, NULL, 'claude-opus-5-5', 'abo', true, 1000, 500, 0, 2000000, 1)`.execute(
        db,
      );
    }
    const annahme = (u: Umgebung, wert: string) =>
      sql`UPDATE mandant SET cache_write_annahme = ${wert} WHERE id = ${u.mandantId}::uuid`.execute(
        db,
      );
    const offenRest = (k: KatalogKostenAntwort) => k.offen.ohne_repo.schatten_usd_micros;

    /** API und Datei müssen dasselbe sagen, jede Zeile der Datei zählt. */
    async function pruefeGleich(u: Umgebung) {
      const k = await kosten(u);
      pruefeSummen(k);
      const { zeilen } = await datei(u);
      expect(summe(zeilen, 'Schattenpreis USD')).toBe(k.gesamt.schatten_usd_micros);
      return k;
    }

    it('Sitzung mit Wahl: vor dem Neuaufbau bleibt kein Rest im Offenen, live und nach dem Abschluss', async () => {
      const u = await umgebung();
      await senden(u, 'a', { name: 'A', number: 'A' });
      await annahme(u, '1h');
      await anfrageMitCache(u, 's-1');
      const kp = await katalogId(u, 'a');
      await withMandant(db, u.mandantId, (t) =>
        t
          .insertInto('sitzung_katalog')
          .values({ mandant_id: u.mandantId, session_id: 's-1', katalog_projekt_id: kp })
          .execute(),
      );
      await aggregiereTage(db, u.mandantId, TAG, TAG);
      const vorher = await pruefeGleich(u);
      expect(offenRest(vorher)).toBe(0);

      await annahme(u, '5m');
      const k = await pruefeGleich(u);
      // Zu 5m ist die Anfrage billiger geworden, das Aggregat steht noch auf 1h.
      expect(je(k, 'a').schatten_usd_micros).toBeLessThan(je(vorher, 'a').schatten_usd_micros);
      expect(k.offen.ohne_repo).toEqual(vorher.offen.ohne_repo);
      expect(k.gesamt.schatten_usd_micros).toBe(je(k, 'a').schatten_usd_micros);

      await schliesseMonat(db, u.mandantId, MONAT);
      const zu = await pruefeGleich(u);
      expect(zu.quelle).toBe('monatsabschluss');
      expect(offenRest(zu)).toBe(0);
      expect(zu.gesamt).toEqual(k.gesamt);
    });

    it('Sitzung ohne Wahl: Offen ist die Anfrage zum aktuellen Preis, ohne Aufschlag', async () => {
      const u = await umgebung();
      await annahme(u, '1h');
      await anfrageMitCache(u, 's-2');
      await aggregiereTage(db, u.mandantId, TAG, TAG);
      const vorher = await pruefeGleich(u);
      await annahme(u, '5m');
      const k = await pruefeGleich(u);
      expect(k.offen.ohne_repo.anfragen).toBe(1);
      expect(offenRest(k)).toBeGreaterThan(0);
      expect(offenRest(k)).toBeLessThan(offenRest(vorher));
      await schliesseMonat(db, u.mandantId, MONAT);
      // Ohne Zuordnung im Monat gibt es keinen Stand, es rechnet weiter live.
      expect(await pruefeGleich(u)).toEqual(k);
    });

    it('mehr Anfragen im Aggregat als in `anfrage`: Das bleibt Nutzung und steht im Offenen', async () => {
      const u = await umgebung();
      await annahme(u, '1h');
      await anfrageMitCache(u, 's-3');
      await anfrageMitCache(u, 's-4');
      await aggregiereTage(db, u.mandantId, TAG, TAG);
      const vorher = await pruefeGleich(u);
      await sql`DELETE FROM anfrage WHERE mandant_id = ${u.mandantId}::uuid AND session_id = 's-3'`.execute(
        db,
      );
      const k = await pruefeGleich(u);
      expect(k.offen.ohne_repo.anfragen).toBe(2);
      expect(offenRest(k)).toBe(offenRest(vorher));
    });

    it('älterer Stand mit Betrag ohne Anfragen: Die Datei zeigt die Zeile, die Summe stimmt', async () => {
      const u = await umgebung();
      await senden(u, 'a', { name: 'A', number: 'A' });
      await repo(u, 'r', 10, 'a');
      await schliesseMonat(db, u.mandantId, MONAT);
      await withMandant(db, u.mandantId, (t) =>
        t
          .updateTable('katalog_abschluss')
          .set({ schatten_usd_micros: 6 * USD, anfragen: 0 })
          .where('nummer', '=', '')
          .where('projekt_id', 'is', null)
          .execute(),
      );
      const k = await pruefeGleich(u);
      expect(k.gesamt.schatten_usd_micros).toBe(16 * USD);
      const { zeilen } = await datei(u);
      const rest = zeilen.filter((z) => z.Repo === 'ohne Repo');
      expect(rest.map((z) => [z.Anfragen, betrag(z['Schattenpreis USD']) / USD])).toEqual([
        ['0', 6],
      ]);
    });
  });

  it('Die Betragsspalte ergibt die Summe der Seite, die neuen Spalten stehen nur auf Projektzeilen', async () => {
    const { u } = await aufbau();
    const { namen, zeilen } = await datei(u);
    expect(namen.slice(0, 10)).toEqual([
      'Monat',
      'Projektnummer',
      'Externe ID',
      'Projektname',
      'Kunde',
      'Repo',
      'Sitzungen ohne Repo',
      'Anfragen',
      'Tokens gesamt',
      'Schattenpreis USD',
    ]);
    expect(namen.slice(10)).toEqual(['Eltern-ID', SUMME]);

    const k = await kosten(u);
    pruefeSummen(k);
    expect(summe(zeilen, 'Schattenpreis USD')).toBe(k.gesamt.schatten_usd_micros);
    expect(summe(zeilen, 'Schattenpreis USD')).toBe(46.5 * USD);

    const projektzeilen = zeilen.filter((z) => z.Repo === 'Projektzeile');
    expect(projektzeilen.map((z) => [z['Externe ID'], z['Eltern-ID']])).toEqual([
      ['e', ''],
      ['k', 'e'],
      ['n', 'k'],
      ['x', ''],
      ['x-1', 'x'],
    ]);
    expect(projektzeilen.map((z) => betrag(z[SUMME]) / USD)).toEqual([18.5, 3.5, 1, 4, 4]);
    // Auf Projektzeilen sind alle Betragsspalten leer, auch für das Elternprojekt ohne eigene Nutzung.
    for (const z of projektzeilen) {
      expect([z['Schattenpreis USD'], z.Anfragen, z['Tokens gesamt']]).toEqual(['', '', '']);
    }
    // Auf allen anderen Zeilen sind die neuen Spalten leer, auch beim Offenen.
    const andere = zeilen.filter((z) => z.Repo !== 'Projektzeile');
    expect(andere).toHaveLength(7);
    for (const z of andere) {
      expect([z['Eltern-ID'], z[SUMME]], z.Repo).toEqual(['', '']);
      expect(z['Schattenpreis USD'], z.Repo).not.toBe('');
    }
    // Die heutigen Zeilen und Beträge bleiben.
    expect(
      andere.map((z) => [z['Externe ID'], z.Repo, betrag(z['Schattenpreis USD']) / USD]),
    ).toEqual([
      ['e', 'test/e-eins', 10],
      ['e', 'test/e-zwei', 5],
      ['k', 'test/k-eins', 2.5],
      ['n', 'test/n-eins', 1],
      ['x-1', 'test/x-eins', 4],
      ['', 'test/offen', 8],
      ['', 'ohne Repo', 16],
    ]);
  });

  it('Projektleitung: Eltern-ID und Summe verraten nichts Verstecktes', async () => {
    const { u, k1 } = await aufbau();
    const leitung = await meldeAn(db, u.mandantId, 'projektleiter', [k1]);
    const { roh, zeilen } = await datei(u, leitung.headers);
    expect(
      zeilen.map((z) => [z['Externe ID'], z.Repo, z['Eltern-ID'], betrag(z[SUMME]) / USD]),
    ).toEqual([
      ['k', 'Projektzeile', '', 2.5],
      ['k', 'test/k-eins', '', 0],
    ]);
    expect(summe(zeilen, 'Schattenpreis USD')).toBe(2.5 * USD);
    // Der Pfad darf das fremde Elternprojekt nennen, Repos und Beträge der fremden Projekte stehen nicht drin.
    expect(zeilen[0]?.Projektname).toBe('Eltern › Kind');
    expect(roh).not.toContain('test/e-eins');
    expect(roh).not.toContain('Enkel');
    expect(roh).not.toContain('10,000000');
    expect(roh).not.toContain('18,500000');
  });

  it('abgeschlossener Monat: gleiche Datei, auch nach Umhängen', async () => {
    const { u } = await aufbau();
    await schliesseMonat(db, u.mandantId, MONAT);
    const vorher = await datei(u);
    await senden(u, 'k', { name: 'Kind', number: 'E.1', parentId: 'x' });
    const nachher = await datei(u);
    expect(nachher.zeilen).toEqual(vorher.zeilen);
    expect(summe(nachher.zeilen, 'Schattenpreis USD')).toBe(46.5 * USD);
  });

  it('eine ID mit Formelzeichen wird auch als Eltern-ID entschärft', async () => {
    const u = await umgebung();
    await senden(u, encodeURIComponent('=SUMME(1)'), { name: 'Formel', number: 'F' });
    await senden(u, 'kind', { name: 'Kind', number: 'F.1', parentId: '=SUMME(1)' });
    await repo(u, 'kind', 1, 'kind');
    const { roh, zeilen } = await datei(u);
    expect(
      zeilen.find((z) => z['Externe ID'] === 'kind' && z.Repo === 'Projektzeile')?.['Eltern-ID'],
    ).toMatch(/^'=/);
    expect(roh).not.toMatch(/;=SUMME/);
  });
});
