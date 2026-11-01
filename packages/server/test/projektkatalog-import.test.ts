// Katalog-Import aus CSV: Parser, Upsert, Deaktivieren und Schutz abgelehnter Zeilen, Trockenlauf, Upload-Route mit
// eigenem Token, CLI, Trennung der Mandanten. Nur erfundene Daten.
import { randomUUID } from 'node:crypto';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  KATALOG_DATEI_MAX_BYTES,
  katalogEinstellungSchema,
  katalogImportErgebnisSchema,
  katalogListeSchema,
  katalogTokenListeSchema,
  katalogTokenNeuSchema,
  katalogTrennzeichenLesen,
  type KatalogImportErgebnis,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parseCsv, parseCsvMitNummern } from '../src/abgleich/csv.js';
import { katalogCli } from '../src/projektkatalog/cli-import.js';
import { katalogCsvDekodieren, leseKatalogCsv, QuelleFehler } from '../src/projektkatalog/index.js';
import { erstelleDb, withMandant, type Db } from '../src/index.js';
import { mandantAnlegen } from '../src/enrollment/mandant-anlegen.js';
import { kernApp, legeProjektAn, MASTER_KEY_B64, meldeAn } from './api-hilfen.js';

const MASTER = Buffer.from(MASTER_KEY_B64, 'base64');
const PFAD = '/api/v1/projektkatalog/import/datei';

let db: Db;
let app: FastifyInstance;

interface Umgebung {
  mandantId: string;
  slug: string;
  ingestToken: string;
  admin: Record<string, string>;
}

async function umgebung(): Promise<Umgebung> {
  const slug = `t-${randomUUID()}`;
  const e = await mandantAnlegen(db, MASTER, { slug, name: 'Testmandant', orgs: [] });
  if (!e.token) throw new Error('Token fehlt');
  const admin = await meldeAn(db, e.mandantId, 'mandanten_admin');
  return { mandantId: e.mandantId, slug, ingestToken: e.token, admin: admin.headers };
}

async function tokenAnlegen(u: Umgebung, bezeichnung = 'Nachtlauf') {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/projektkatalog/tokens',
    headers: u.admin,
    payload: { bezeichnung },
  });
  expect(r.statusCode).toBe(201);
  return katalogTokenNeuSchema.parse(r.json());
}

function hochladen(token: string, csv: string | Buffer, abfrage = '') {
  return app.inject({
    method: 'POST',
    url: `${PFAD}${abfrage}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv; charset=utf-8' },
    payload: csv,
  });
}

async function ergebnis(token: string, csv: string, abfrage = ''): Promise<KatalogImportErgebnis> {
  const r = await hochladen(token, csv, abfrage);
  expect(r.statusCode, r.body).toBe(200);
  return katalogImportErgebnisSchema.parse(r.json());
}

async function projekte(u: Umgebung, nurAktive = false) {
  const r = await app.inject({
    url: `/api/v1/projektkatalog/projekte?aktiv=${nurAktive ? '1' : '0'}`,
    headers: u.admin,
  });
  expect(r.statusCode).toBe(200);
  return katalogListeSchema.parse(r.json()).projekte;
}

const stand = async (u: Umgebung) =>
  Object.fromEntries(
    (await projekte(u)).map((p) => [p.nummer, { name: p.name, kunde: p.kunde, aktiv: p.aktiv }]),
  );

async function auditEintraege(mandantId: string) {
  return withMandant(db, mandantId, (trx) =>
    trx
      .selectFrom('audit')
      .select(['aktion', 'objekt', 'benutzer_id'])
      .where('aktion', 'like', '%atalog%')
      .execute(),
  );
}

async function einstellung(u: Umgebung) {
  const r = await app.inject({ url: '/api/v1/projektkatalog/einstellung', headers: u.admin });
  return katalogEinstellungSchema.parse(r.json());
}

const ANFANG = 'Nummer;Name;Kunde\nP-1;Eins;Muster AG\nP-2;Zwei;Beispiel GmbH\nP-3;Drei;\n';

beforeAll(async () => {
  const url = inject('testDatenbankUrl');
  db = erstelleDb(url, 4);
  app = await kernApp(db, url);
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

describe('CSV lesen', () => {
  it('parseCsv: BOM, CRLF, Trennzeichen und Zeilenumbrüche in Anführungszeichen, verdoppelte ""', () => {
    expect(parseCsv('\uFEFFa;b\r\n"x;y";"z\r\nw"\r\n"s""t";u\n', ';')).toEqual([
      ['a', 'b'],
      ['x;y', 'z\r\nw'],
      ['s"t', 'u'],
    ]);
  });

  it('Zeilennummern stimmen mit Leerzeilen und Umbrüchen in Feldern', () => {
    const z = parseCsvMitNummern('a;b\n\n"x\ny";2\r\n\r\nc;3\n', ';');
    expect(z.map((e) => e.nummer)).toEqual([1, 3, 6]);
  });

  it('Abgleich-CSV bleibt wie bisher: Anführungszeichen schalten überall um', () => {
    expect(parseCsv('a;b"c;d"e;f\n', ';')).toEqual([['a', 'bc;de', 'f']]);
    expect(parseCsv('a;"b"c\n', ';')).toEqual([['a', 'bc']]);
    expect(parseCsv('a;"b\nc', ';')).toEqual([['a', 'b\nc']]);
  });

  it('Katalog-CSV: Anführungszeichen mitten im Feld ist ein Zeichen, kein Beginn', () => {
    expect(parseCsvMitNummern('a;5" x;c\nd;e;7" y\n', ';').map((z) => z.felder)).toEqual([
      ['a', '5" x', 'c'],
      ['d', 'e', '7" y'],
    ]);
    const z = leseKatalogCsv(
      'Nummer;Name;Beschreibung\nP-1;Monitor 24";5" Monitor\nP-2;Zwei;x\nP-3;Drei;7" Monitor\nP-4;Vier;d\n',
    );
    expect(z.abgelehnt).toBe(0);
    expect(z.nummerUnlesbar).toBe(false);
    expect(z.eintraege.map((e) => [e.nummer, e.name])).toEqual([
      ['P-1', 'Monitor 24"'],
      ['P-2', 'Zwei'],
      ['P-3', 'Drei'],
      ['P-4', 'Vier'],
    ]);
  });

  it('Katalog-CSV: Text nach dem schließenden Anführungszeichen und offenes Ende lehnen die Datei ab', () => {
    expect(() => leseKatalogCsv('Nummer;Name\nP-1;"Eins"x\n')).toThrow(
      /Zeile 2.*Anführungszeichen/,
    );
    expect(() => leseKatalogCsv('Nummer;Name\nP-1;"Eins" \nP-2;Zwei\n')).toThrow(QuelleFehler);
    expect(() => leseKatalogCsv('Nummer;Name\nP-1;"Eins\nP-2;Zwei\n')).toThrow(/nicht geschlossen/);
    // Verdoppelte Anführungszeichen und ein leeres Feld in Anführungszeichen sind in Ordnung.
    const z = leseKatalogCsv('Nummer;Name;Kunde\nP-1;"Ein ""Projekt""";""\n');
    expect(z.eintraege).toEqual([
      { externe_id: 'P-1', nummer: 'P-1', name: 'Ein "Projekt"', kunde: null, aktiv: true },
    ]);
  });

  it('Umbruch im Aktiv-Feld, in der Nummer oder am Ende eines Felds: abgelehnt, nichts deaktiviert', () => {
    const aktiv = leseKatalogCsv('Nummer;Name;Aktiv\nP-1;Eins;"ja\nP-2;Zwei;ja"\nP-3;Drei;ja\n');
    expect(aktiv.eintraege.map((e) => e.nummer)).toEqual(['P-3']);
    expect(aktiv.abgelehnt).toBe(1);
    expect(aktiv.nummerUnlesbar).toBe(true);
    expect(aktiv.geschuetzt).toEqual(['P-1']);
    const nummer = leseKatalogCsv('Nummer;Name\n"P-1\n";Eins\nP-3;Drei\n');
    expect(nummer.abgelehnt).toBe(1);
    expect(nummer.nummerUnlesbar).toBe(true);
    const name = leseKatalogCsv('Nummer;Name\nP-1;"Eins\n"\nP-3;Drei\n');
    expect(name.abgelehnt).toBe(1);
    expect(name.nummerUnlesbar).toBe(true);
  });

  it('Mehrzeiliger Text in einer Spalte, die nicht zählt: erlaubt; mit Trennzeichen darin verdächtig', () => {
    const frei = leseKatalogCsv(
      'Nummer;Name;Beschreibung\nP-1;Eins;"Erste Zeile; mit Trenner\nZweite Zeile"\nP-2;Zwei;x\n',
    );
    expect(frei.abgelehnt).toBe(0);
    expect(frei.nummerUnlesbar).toBe(false);
    expect(frei.hinweise).toEqual([]);
    expect(frei.eintraege.map((e) => e.nummer)).toEqual(['P-1', 'P-2']);

    const verdaechtig = leseKatalogCsv(
      'Nummer;Name;Beschreibung\nP-1;Eins;"5 Monitor\nP-2;Zwei;GEHEIM\nP-3;Drei;7"\nP-4;Vier;d\n',
    );
    expect(verdaechtig.abgelehnt).toBe(0);
    expect(verdaechtig.nummerUnlesbar).toBe(true);
    expect(verdaechtig.eintraege.map((e) => e.nummer)).toEqual(['P-1', 'P-4']);
    expect(verdaechtig.hinweise).toHaveLength(1);
    expect(verdaechtig.hinweise[0]).toContain('Zeile 2');
    expect(verdaechtig.hinweise[0]).not.toContain('GEHEIM');
  });

  it('Trennzeichen: Standard Semikolon, nie geraten', () => {
    expect(leseKatalogCsv('Nummer;Name\nP-1;Eins, mit Komma\n').eintraege).toEqual([
      { externe_id: 'P-1', nummer: 'P-1', name: 'Eins, mit Komma', aktiv: true },
    ]);
    // Komma-Datei mit Standard: ganze Datei abgelehnt, mit Hinweis statt Vermutung.
    expect(() => leseKatalogCsv('Nummer,Name\nP-1,Eins\n')).toThrow(/sieht nach Komma/);
    for (const [trennzeichen, text] of [
      [',', 'Nummer,Name\nP-1,"Eins; zwei"\n'],
      ['\t', 'Nummer\tName\nP-1\tEins; zwei\n'],
      ['|', 'Nummer|Name\nP-1|Eins; zwei\n'],
    ] as const) {
      expect(leseKatalogCsv(text, { trennzeichen }).eintraege[0]?.name).toBe('Eins; zwei');
    }
    expect(katalogTrennzeichenLesen('tab')).toBe('\t');
    expect(katalogTrennzeichenLesen(';')).toBe(';');
    expect(katalogTrennzeichenLesen('?')).toBeNull();
  });

  it('Spaltenzuordnung: externe ID und Name, nicht zugeordnete Spalten zählen nicht', () => {
    const csv =
      'Kennung;Projekt-Titel;Kostenstelle;Status;Kunde\nA-1;Eins;4711;laufend;Muster AG\n';
    const z = leseKatalogCsv(csv, { spalten: { id: 'Kennung', name: 'projekt titel' } });
    expect(z.eintraege).toEqual([{ externe_id: 'A-1', name: 'Eins', aktiv: true }]);
    expect(
      leseKatalogCsv(csv, { spalten: { id: 'Kennung', name: 'Projekt-Titel', kunde: 'Kunde' } })
        .eintraege[0]?.kunde,
    ).toBe('Muster AG');
    expect(() => leseKatalogCsv(csv, { spalten: { id: 'Fehlt', name: 'Kunde' } })).toThrow(
      /„Fehlt“ fehlt/,
    );
    // Normalisiert gleich und nicht wörtlich getroffen: nicht raten.
    expect(() =>
      leseKatalogCsv('Nr (alt);Nr (neu);Name\n1;2;x\n', { spalten: { id: 'Nr', name: 'Name' } }),
    ).toThrow(/nicht eindeutig/);
  });

  it('Aktiv-Spalte: dieselben Wörter wie beim Push, leer heißt aktiv', () => {
    const z = leseKatalogCsv(
      'ID;Name;Aktiv\na;A;on\nb;B;OFF\nc;C;f\nd;D;t\ne;E;\nf;F;vielleicht\n',
    );
    expect(z.eintraege.map((e) => [e.externe_id, e.aktiv])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
      ['d', true],
      ['e', true],
    ]);
    expect(z.geschuetzt).toEqual(['f']);
  });

  it('externe ID und Nummer sind getrennt; nur eine Nummer ist auch die ID', () => {
    const beide = leseKatalogCsv('ID;Nummer;Name;Parent\nx-1;P-1;Eins;x-0\n').eintraege[0];
    expect(beide).toMatchObject({ externe_id: 'x-1', nummer: 'P-1', parent: 'x-0' });
    const zuordnung = leseKatalogCsv('Schluessel;Nr;Titel;Ober\nx-1;P-1;Eins;\n', {
      spalten: { id: 'Schluessel', nummer: 'Nr', name: 'Titel', parent: 'Ober' },
    }).eintraege[0];
    expect(zuordnung).toMatchObject({ externe_id: 'x-1', nummer: 'P-1', parent: null });
    expect(leseKatalogCsv('Nummer;Name\nP-1;Eins\n').eintraege[0]).toMatchObject({
      externe_id: 'P-1',
      nummer: 'P-1',
    });
  });

  it('ohne Zuordnung gelten die üblichen Spaltennamen', () => {
    const z = leseKatalogCsv(
      '\uFEFFProjektnummer;Projektname;Kunde;Status\nP-1;Eins;Muster;aktiv\nP-2;"Zwei; mit Trenner";;abgeschlossen\n',
    );
    expect(z.eintraege).toEqual([
      {
        externe_id: 'P-1',
        nummer: 'P-1',
        name: 'Eins',
        kunde: 'Muster',
        aktiv: true,
        status: 'aktiv',
      },
      {
        externe_id: 'P-2',
        nummer: 'P-2',
        name: 'Zwei; mit Trenner',
        kunde: null,
        aktiv: false,
        status: 'abgeschlossen',
      },
    ]);
  });

  it('Probleme der ganzen Datei lehnen sie ab', () => {
    for (const falsch of [
      '',
      '\n\n',
      'Titel;Kunde\nA;B\n',
      'Nummer;Name\n',
      'Nummer;Name\nP-1;"offen\nP-2;Zwei\n',
      'Nummer;Name\nP-1;Stra\uFFFDe\n',
      'Nummer;Name\nP-1;Ein\0s\n',
    ]) {
      expect(() => leseKatalogCsv(falsch), falsch).toThrow(QuelleFehler);
    }
    const zuViele = `Nummer;Name\n${Array.from({ length: 20_001 }, (_, i) => `P-${i};x`).join('\n')}`;
    expect(() => leseKatalogCsv(zuViele)).toThrow(/Höchstens/);
  });

  it('UTF-8 mit oder ohne BOM; Windows-1252 und UTF-16 werden abgelehnt statt verfälscht', () => {
    const text = 'Nummer;Name\nP-1;Straße\n';
    expect(katalogCsvDekodieren(Buffer.from(text))).toBe(text);
    expect(katalogCsvDekodieren(Buffer.from(`\uFEFF${text}`))).toBe(text);
    expect(() => katalogCsvDekodieren(Buffer.from(text, 'latin1'))).toThrow(/nicht UTF-8/);
    expect(() =>
      katalogCsvDekodieren(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
      ),
    ).toThrow(/nicht UTF-8/);
    // UTF-16 ohne BOM ist gültiges UTF-8 mit Nullbytes.
    expect(() => leseKatalogCsv(katalogCsvDekodieren(Buffer.from(text, 'utf16le')))).toThrow(
      /nicht UTF-8/,
    );
  });

  it('schlechte Zeilen: Zeilennummer ohne Zellinhalt, erste Zeile gewinnt, Schutz je Nummer', () => {
    const z = leseKatalogCsv(
      [
        'Nummer;Name;Aktiv',
        'P-1;Eins;ja',
        'P-1;GEHEIM-DOPPELT;ja',
        'P-2;;ja',
        'P-2;Später gültig;ja',
        'P-3;Drei;GEHEIM-STATUS',
        '',
      ].join('\n'),
    );
    expect(z.eintraege.map((e) => [e.externe_id, e.name])).toEqual([['P-1', 'Eins']]);
    expect(z.abgelehnt).toBe(4);
    expect(z.geschuetzt).toEqual(['P-2', 'P-3']);
    expect(z.nummerUnlesbar).toBe(false);
    expect(z.meldungen.map((m) => m.split(':')[0])).toEqual([
      'Zeile 3',
      'Zeile 4',
      'Zeile 5',
      'Zeile 6',
    ]);
    expect(z.meldungen.join(' ')).not.toContain('GEHEIM');
  });

  it('keine lesbare Nummer: fehlend, zu lang, Steuerzeichen oder abweichende Spaltenzahl', () => {
    for (const zeile of [
      ';Name',
      `${'x'.repeat(201)};Name`,
      'P\u0001-1;Name',
      'P-1;Name;mit;Trenner',
      'P-1;Name;',
      'P-1',
    ]) {
      const z = leseKatalogCsv(`Nummer;Name\nP-9;Neun\n${zeile}\n`);
      expect(z.nummerUnlesbar, zeile).toBe(true);
      expect(z.abgelehnt, zeile).toBe(1);
      expect(z.eintraege).toHaveLength(1);
    }
  });

  it('verschluckte Zeilen: Umbruch in Name oder Kunde lehnt ab und verhindert das Deaktivieren', () => {
    // Zwei verirrte Anführungszeichen: gerade Zahl, also nicht „offen“, aber P-2 steckt im Feld von P-1.
    const z = leseKatalogCsv('Nummer;Name;Kunde\nP-1;"Eins;\nP-2;Zwei";Muster\nP-3;Drei;\n');
    expect(z.eintraege.map((e) => e.externe_id)).toEqual(['P-3']);
    expect(z.geschuetzt).toEqual(['P-1']);
    expect(z.nummerUnlesbar).toBe(true);
    expect(z.meldungen[0]).toContain('Zeile 2');
    expect(leseKatalogCsv('Nummer;Name;Kunde\nP-1;Eins;"a\nb"\n').nummerUnlesbar).toBe(true);
    // Umbruch in einer Spalte, die nicht zählt: Beschreibungen dürfen mehrzeilig sein.
    const frei = leseKatalogCsv('Nummer;Name;Beschreibung\nP-1;Eins;"a\nb"\n');
    expect(frei.abgelehnt).toBe(0);
    expect(frei.eintraege[0]?.name).toBe('Eins');
  });

  it('das Schema lehnt Steuerzeichen und Ersetzungszeichen auch im JSON-Import ab', async () => {
    const u = await umgebung();
    for (const name of ['mit\nUmbruch', 'mit\u0007Glocke', 'Stra\uFFFDe']) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/projektkatalog/import',
        headers: u.admin,
        payload: { projekte: [{ nummer: 'P-1', name }] },
      });
      expect(r.statusCode, name).toBe(400);
    }
    const csv = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv: 'Nummer;Name\nP-1;Stra\uFFFDe\n' },
    });
    expect(csv.statusCode).toBe(400);
    expect(csv.json<{ fehler: string }>().fehler).toContain('UTF-8');
  });

  it('höchstens 20 Meldungen, gezählt werden alle', () => {
    const zeilen = Array.from({ length: 30 }, (_, i) => `P-${i};`).join('\n');
    const z = leseKatalogCsv(`Nummer;Name\n${zeilen}\n`);
    expect(z.abgelehnt).toBe(30);
    expect(z.meldungen).toHaveLength(20);
  });
});

describe('Abgleich', () => {
  it('zählt neu, aktualisiert, unverändert und deaktiviert; löscht nichts; reaktiviert', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    expect(await ergebnis(token, ANFANG)).toEqual({
      neu: 3,
      aktualisiert: 0,
      unveraendert: 0,
      deaktiviert: 0,
      abgelehnt: 0,
      aktiv_gesamt: 3,
      abgelehnte_zeilen: [],
      hinweise: [],
      deaktivierung_uebersprungen: false,
      trockenlauf: false,
    });
    // Unverändert heißt wirklich unverändert; P-3 fehlt; P-4 ist neu; P-2 ändert den Kunden.
    expect(
      await ergebnis(
        token,
        'Nummer;Name;Kunde\nP-1;Eins;Muster AG\nP-2;Zwei;Andere GmbH\nP-4;Vier;\n',
      ),
    ).toMatchObject({ neu: 1, aktualisiert: 1, unveraendert: 1, deaktiviert: 1, aktiv_gesamt: 3 });
    expect(await stand(u)).toEqual({
      'P-1': { name: 'Eins', kunde: 'Muster AG', aktiv: true },
      'P-2': { name: 'Zwei', kunde: 'Andere GmbH', aktiv: true },
      'P-3': { name: 'Drei', kunde: null, aktiv: false },
      'P-4': { name: 'Vier', kunde: null, aktiv: true },
    });
    // Reaktivierung zählt als aktualisiert; fehlende werden deaktiviert.
    expect(await ergebnis(token, 'Nummer;Name;Kunde\nP-3;Drei;\n')).toMatchObject({
      neu: 0,
      aktualisiert: 1,
      unveraendert: 0,
      deaktiviert: 3,
      aktiv_gesamt: 1,
    });
    // Teilliste deaktiviert nichts.
    expect(
      await ergebnis(token, 'Nummer;Name;Kunde\nP-1;Eins;Muster AG\n', '?vollstaendig=0'),
    ).toMatchObject({ aktualisiert: 1, deaktiviert: 0, aktiv_gesamt: 2 });
  });

  it('Datei ohne Kunden-Spalte lässt vorhandene Kunden stehen', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    expect(await ergebnis(token, 'Nummer;Name\nP-1;Eins\nP-2;Zwei\nP-3;Drei\n')).toMatchObject({
      aktualisiert: 0,
      unveraendert: 3,
    });
    expect((await stand(u))['P-1']?.kunde).toBe('Muster AG');
    // Mit Spalte und leerem Feld wird der Kunde bewusst geleert.
    expect(
      await ergebnis(token, 'Nummer;Name;Kunde\nP-1;Eins;\n', '?vollstaendig=0'),
    ).toMatchObject({
      aktualisiert: 1,
    });
    expect((await stand(u))['P-1']?.kunde).toBeNull();
  });

  it('abgelehnte Zeile mit lesbarer Nummer: dieses Projekt bleibt, andere fehlende werden inaktiv', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    const e = await ergebnis(token, 'Nummer;Name;Kunde\nP-1;Eins neu;Muster AG\nP-2;;\n');
    expect(e).toMatchObject({
      aktualisiert: 1,
      abgelehnt: 1,
      deaktiviert: 1,
      deaktivierung_uebersprungen: false,
    });
    expect(e.abgelehnte_zeilen).toEqual(['Zeile 3: Name fehlt oder ein Feld ist zu lang.']);
    expect(await stand(u)).toEqual({
      'P-1': { name: 'Eins neu', kunde: 'Muster AG', aktiv: true },
      'P-2': { name: 'Zwei', kunde: 'Beispiel GmbH', aktiv: true },
      'P-3': { name: 'Drei', kunde: null, aktiv: false },
    });
  });

  it('abgelehnte Zeile ohne lesbare Nummer: im ganzen Lauf wird nichts deaktiviert', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    const e = await ergebnis(token, 'Nummer;Name;Kunde\nP-1;Eins;Muster AG\n;Ohne Nummer;\n');
    expect(e).toMatchObject({
      unveraendert: 1,
      abgelehnt: 1,
      deaktiviert: 0,
      aktiv_gesamt: 3,
      deaktivierung_uebersprungen: true,
    });
    expect((await einstellung(u)).projekte_aktiv).toBe(3);
  });

  it('verirrte Anführungszeichen deaktivieren nichts: alle Fälle über die Upload-Route', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, 'Nummer;Name\nP-1;Eins\nP-2;Zwei\nP-3;Drei\nP-4;Vier\n');
    const aktiv = async () => (await projekte(u, true)).map((p) => p.nummer).sort();
    const alle = ['P-1', 'P-2', 'P-3', 'P-4'];

    // In einer Spalte, die nicht zählt: Das Zeichen ist wörtlich, alle Zeilen kommen an.
    const woertlich = await ergebnis(
      token,
      'Nummer;Name;Info\nP-1;Eins;5" Monitor\nP-2;Zwei;x\nP-3;Drei;7" Monitor\nP-4;Vier;d\n',
    );
    expect(woertlich).toMatchObject({
      abgelehnt: 0,
      deaktiviert: 0,
      deaktivierung_uebersprungen: false,
    });
    expect(await aktiv()).toEqual(alle);

    // Im Aktiv-Feld: Zeile abgelehnt, P-2 steckt darin und wird nicht deaktiviert.
    const imAktiv = await ergebnis(
      token,
      'Nummer;Name;Aktiv\nP-1;Eins;"ja\nP-2;Zwei;ja"\nP-3;Drei;ja\nP-4;Vier;ja\n',
    );
    expect(imAktiv).toMatchObject({
      abgelehnt: 1,
      deaktiviert: 0,
      deaktivierung_uebersprungen: true,
    });
    expect(await aktiv()).toEqual(alle);

    // Feldbeginn in einer Spalte, die nicht zählt: P-2 und P-3 stecken im Text von P-1.
    const verschluckt = await ergebnis(
      token,
      'Nummer;Name;Info\nP-1;Eins;"5 Monitor\nP-2;Zwei;x\nP-3;Drei;7"\nP-4;Vier;d\n',
    );
    expect(verschluckt).toMatchObject({
      abgelehnt: 0,
      deaktiviert: 0,
      deaktivierung_uebersprungen: true,
    });
    expect(verschluckt.hinweise).toHaveLength(1);
    expect(await aktiv()).toEqual(alle);

    // Ohne Trennzeichen im Text fehlt P-2 wirklich: Dann wird deaktiviert.
    const mehrzeilig = await ergebnis(
      token,
      'Nummer;Name;Info\nP-1;Eins;"Zeile eins\nZeile zwei"\nP-3;Drei;x\nP-4;Vier;y\n',
    );
    expect(mehrzeilig).toMatchObject({
      abgelehnt: 0,
      deaktiviert: 1,
      deaktivierung_uebersprungen: false,
    });
    expect(await aktiv()).toEqual(['P-1', 'P-3', 'P-4']);
  });

  it('CLI: verdächtiger Text meldet Exit 2, obwohl keine Zeile abgelehnt ist', async () => {
    const u = await umgebung();
    const ausgabe: string[] = [];
    const lauf = (csv: string) =>
      katalogCli(['--mandant', u.slug, '--datei', '-'], {
        db,
        eingabe: Readable.from([Buffer.from(csv)]),
        ausgabe: (z) => ausgabe.push(z),
        fehler: () => undefined,
      });
    expect(await lauf('Nummer;Name\nP-1;Eins\nP-2;Zwei\n')).toBe(0);
    expect(await lauf('Nummer;Name;Info\nP-1;Eins;"a\nP-2;Zwei;x"\n')).toBe(2);
    const e = katalogImportErgebnisSchema.parse(JSON.parse(ausgabe.at(-1) ?? '{}'));
    expect(e).toMatchObject({ abgelehnt: 0, deaktiviert: 0, deaktivierung_uebersprungen: true });
  });

  it('Dashboard-Import nimmt große Dateien bis zur Grenze der Upload-Route', async () => {
    const u = await umgebung();
    const fuellung = 'x'.repeat(900);
    const zeilen = Array.from({ length: 6000 }, (_, i) => `P-${i};Name ${i};${fuellung}`);
    const csv = `Nummer;Name;Info\n${zeilen.join('\n')}\n`;
    expect(Buffer.byteLength(csv)).toBeGreaterThan(5 * 1024 * 1024);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv },
    });
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(katalogImportErgebnisSchema.parse(r.json()).neu).toBe(6000);

    const zuGross = await app.inject({
      method: 'POST',
      url: '/api/v1/projektkatalog/import/csv',
      headers: u.admin,
      payload: { csv: `Nummer;Name\n${'x'.repeat(KATALOG_DATEI_MAX_BYTES)}` },
    });
    expect(zuGross.statusCode).toBe(413);
    expect((await einstellung(u)).projekte_aktiv).toBe(6000);
  });

  it('keine einzige gültige Zeile: nichts wird deaktiviert', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    const e = await ergebnis(token, 'Nummer;Name;Kunde\nP-1;;\n');
    expect(e).toMatchObject({ abgelehnt: 1, deaktiviert: 0, deaktivierung_uebersprungen: true });
    expect((await einstellung(u)).projekte_aktiv).toBe(3);
  });

  it('Teilliste meldet kein Überspringen', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    const e = await ergebnis(token, 'Nummer;Name\nP-1;Eins\n;x\n', '?vollstaendig=0');
    expect(e).toMatchObject({ neu: 1, abgelehnt: 1, deaktivierung_uebersprungen: false });
  });

  it('Zuordnungen bleiben bestehen; inaktive Projekte verlassen die Auswahl', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    const repo = await legeProjektAn(db, u.mandantId, 'firma/shop');
    const ziel = (await projekte(u)).find((p) => p.nummer === 'P-3');
    const z = await app.inject({
      method: 'PUT',
      url: '/api/v1/projektkatalog/zuordnung',
      headers: u.admin,
      payload: { zuordnung: [{ projekt_id: repo, katalog_projekt_id: ziel?.id }] },
    });
    expect(z.statusCode).toBe(200);

    await ergebnis(token, 'Nummer;Name;Kunde\nP-1;Eins;\n');
    const bestand = await withMandant(db, u.mandantId, (trx) =>
      trx.selectFrom('projekt_katalog').select('katalog_projekt_id').execute(),
    );
    expect(bestand).toEqual([{ katalog_projekt_id: ziel?.id }]);
    expect((await projekte(u, true)).map((p) => p.nummer)).toEqual(['P-1']);
  });

  it('legt nie einen Eintrag „Kein Projekt“ an: Der Katalog enthält genau die Zeilen der Datei', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    expect((await projekte(u)).map((p) => p.nummer).sort()).toEqual(['P-1', 'P-2', 'P-3']);
    expect((await projekte(u)).some((p) => /kein projekt/i.test(p.name))).toBe(false);
    // Auch ein Lauf, der nichts übernimmt, legt nichts an.
    const leer = await umgebung();
    const t2 = await tokenAnlegen(leer);
    await ergebnis(t2.token, 'Nummer;Name\n;x\n');
    expect(await projekte(leer)).toEqual([]);
  });
});

describe('Trockenlauf', () => {
  it('dieselben Zahlen wie der folgende echte Lauf, ohne jeden Schreibzugriff auf den Katalog', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    const vorher = await projekte(u);
    const vorherEinstellung = await einstellung(u);
    const vorherAudit = await auditEintraege(u.mandantId);
    const csv =
      'Nummer;Name;Kunde\nP-1;Eins;Muster AG\nP-2;Neu;Beispiel GmbH\nP-4;Vier;\nP-2;doppelt;\nP-5;;\n';

    const trocken = await ergebnis(token, csv, '?trockenlauf=1');
    expect(trocken.trockenlauf).toBe(true);
    expect(trocken).toMatchObject({
      neu: 1,
      aktualisiert: 1,
      unveraendert: 1,
      deaktiviert: 1,
      abgelehnt: 2,
      aktiv_gesamt: 3,
    });
    expect(await projekte(u)).toEqual(vorher);
    expect(await einstellung(u)).toEqual(vorherEinstellung);
    expect(await auditEintraege(u.mandantId)).toEqual(vorherAudit);

    const echt = await ergebnis(token, csv);
    expect({ ...trocken, trockenlauf: false }).toEqual(echt);
    expect((await einstellung(u)).projekte_aktiv).toBe(echt.aktiv_gesamt);
  });

  it('gilt auch für die JSON-Routen', async () => {
    const u = await umgebung();
    for (const [url, payload] of [
      ['/api/v1/projektkatalog/import', { projekte: [{ nummer: 'P-1', name: 'Eins' }] }],
      ['/api/v1/projektkatalog/import/csv', { csv: 'Nummer;Name\nP-1;Eins\n' }],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url,
        headers: u.admin,
        payload: { ...payload, trockenlauf: true },
      });
      expect(r.statusCode, url).toBe(200);
      expect(katalogImportErgebnisSchema.parse(r.json())).toMatchObject({
        neu: 1,
        trockenlauf: true,
      });
    }
    expect(await projekte(u)).toEqual([]);
    expect(await auditEintraege(u.mandantId)).toEqual([]);
  });
});

describe('Upload-Route', () => {
  it('Parameter: Trennzeichen, Spalten, Tippfehler führen nie zu einem echten Import', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    expect(
      await ergebnis(
        token,
        'Kennung,Titel,Egal\nA-1,Eins,x\n',
        '?trennzeichen=komma&spalte_id=Kennung&spalte_name=Titel',
      ),
    ).toMatchObject({ neu: 1 });
    expect(
      await ergebnis(token, 'Nummer\tName\nA-2\tZwei\n', '?trennzeichen=%09&vollstaendig=0'),
    ).toMatchObject({ neu: 1 });
    for (const falsch of [
      '?trockenLauf=1',
      '?trockenlauf=vielleicht',
      '?trennzeichen=x',
      '?spalte_id=Kennung',
    ]) {
      expect((await hochladen(token, 'Nummer;Name\nZ-1;Z\n', falsch)).statusCode, falsch).toBe(400);
    }
    expect((await projekte(u)).map((p) => p.nummer).sort()).toEqual(['A-1', 'A-2']);
  });

  it('ganze Datei falsch: 400, nichts geschrieben; Kodierung, Größe, Art', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    await ergebnis(token, ANFANG);
    const vorher = await projekte(u);
    const kaputt = [
      Buffer.from('Nummer;Name\nP-1;Straße\n', 'latin1'),
      'Nummer,Name\nP-1,Eins\n',
      'Titel;Kunde\nA;B\n',
      'Nummer;Name\n',
      '',
    ];
    for (const k of kaputt) {
      const r = await hochladen(token, k);
      expect(r.statusCode, String(k)).toBe(400);
      expect(r.json<{ fehler: string }>().fehler.length).toBeGreaterThan(0);
    }
    expect(
      (await hochladen(token, Buffer.from('Nummer;Name\nP-1;Straße\n', 'latin1'))).json<{
        fehler: string;
      }>().fehler,
    ).toMatch(/UTF-8/);
    expect(await projekte(u)).toEqual(vorher);

    const zuGross = await hochladen(token, Buffer.alloc(KATALOG_DATEI_MAX_BYTES + 1, 0x41));
    expect(zuGross.statusCode).toBe(413);
    const art = await app.inject({
      method: 'POST',
      url: PFAD,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(art.statusCode).toBe(415);
    expect(await projekte(u)).toEqual(vorher);
  });

  it('Ratenlimit je Token', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    let status = 200;
    let versuche = 0;
    while (status === 200 && versuche < 40) {
      status = (await hochladen(token, 'Nummer;Name\nP-1;Eins\n', '?trockenlauf=1')).statusCode;
      versuche += 1;
    }
    expect(status).toBe(429);
    expect(versuche).toBeGreaterThan(20);
    // Ein anderes Token desselben Mandanten hat seinen eigenen Vorrat.
    const zweites = await tokenAnlegen(u, 'Zweiter Lauf');
    expect(
      (await hochladen(zweites.token, 'Nummer;Name\nP-1;Eins\n', '?trockenlauf=1')).statusCode,
    ).toBe(200);
  });

  it('Fehlversuche von derselben Adresse treffen ein gültiges Token nicht', async () => {
    const eigene = await kernApp(db, inject('testDatenbankUrl'));
    try {
      const u = await umgebung();
      const { token } = await tokenAnlegen(u);
      const senden = (t: string) =>
        eigene.inject({
          method: 'POST',
          url: `${PFAD}?trockenlauf=1`,
          headers: { authorization: `Bearer ${t}`, 'content-type': 'text/csv' },
          payload: ANFANG,
        });
      for (let i = 0; i < 25; i += 1) await senden(`smk_${'f'.repeat(43)}`);
      expect((await senden(`smk_${'f'.repeat(43)}`)).statusCode).toBe(429);
      expect((await senden(token)).statusCode).toBe(200);
    } finally {
      await eigene.close();
    }
  });

  it('angemeldeter Admin darf mit CSRF, andere Rollen und ohne CSRF nicht', async () => {
    const u = await umgebung();
    const kopf = { ...u.admin, 'content-type': 'text/csv' };
    const ok = await app.inject({ method: 'POST', url: PFAD, headers: kopf, payload: ANFANG });
    expect(ok.statusCode, ok.body).toBe(200);
    const audit = await auditEintraege(u.mandantId);
    expect(audit.find((a) => a.aktion === 'Projektkatalog importiert')?.objekt).toContain(
      'ausloeser:konto',
    );
    const ohneCsrf = Object.fromEntries(
      Object.entries(kopf).filter(([k]) => k !== 'x-seatmeter-csrf'),
    );
    expect(
      (await app.inject({ method: 'POST', url: PFAD, headers: ohneCsrf, payload: ANFANG }))
        .statusCode,
    ).toBe(403);
    for (const rolle of ['controller', 'projektleiter', 'entwickler'] as const) {
      const k = await meldeAn(db, u.mandantId, rolle);
      const r = await app.inject({
        method: 'POST',
        url: PFAD,
        headers: { ...k.headers, 'content-type': 'text/csv' },
        payload: ANFANG,
      });
      expect(r.statusCode, rolle).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: PFAD,
          headers: { 'content-type': 'text/csv' },
          payload: ANFANG,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('Import-Token', () => {
  it('Klartext nur beim Anlegen, nur der SHA-256 gespeichert, Protokoll ohne Klartext', async () => {
    const u = await umgebung();
    const neu = await tokenAnlegen(u);
    expect(neu.token.startsWith('smk_')).toBe(true);
    const liste = await app.inject({ url: '/api/v1/projektkatalog/tokens', headers: u.admin });
    expect(liste.body).not.toContain(neu.token);
    expect(liste.body).not.toContain('sha256');
    const l = katalogTokenListeSchema.parse(liste.json());
    expect(l.tokens[0]).toMatchObject({ bezeichnung: 'Nachtlauf', zuletzt_genutzt: null });
    const zeile = await withMandant(db, u.mandantId, (trx) =>
      trx.selectFrom('katalog_import_token').selectAll().executeTakeFirstOrThrow(),
    );
    expect(zeile.token_sha256.toString()).not.toContain(neu.token);
    expect(neu.token.startsWith(zeile.praefix)).toBe(true);
    const audit = await auditEintraege(u.mandantId);
    expect(audit.map((a) => a.aktion)).toContain('Katalog-Import-Token erzeugt');
    expect(JSON.stringify(audit)).not.toContain(neu.token);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projektkatalog/tokens',
          headers: u.admin,
          payload: { bezeichnung: '  ' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('merkt die letzte Nutzung und protokolliert den Präfix, nie das Token', async () => {
    const u = await umgebung();
    const neu = await tokenAnlegen(u);
    await ergebnis(neu.token, ANFANG);
    const l = katalogTokenListeSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/tokens', headers: u.admin })).json(),
    );
    expect(l.tokens[0]?.zuletzt_genutzt).not.toBeNull();
    const audit = await auditEintraege(u.mandantId);
    const eintrag = audit.find((a) => a.aktion === 'Projektkatalog importiert');
    expect(eintrag?.benutzer_id).toBeNull();
    expect(eintrag?.objekt).toContain(`ausloeser:token:${neu.praefix}`);
    expect(JSON.stringify(audit)).not.toContain(neu.token);
  });

  it('Widerruf wirkt sofort; zweiter Widerruf und fremder Mandant 404', async () => {
    const u = await umgebung();
    const andere = await umgebung();
    const neu = await tokenAnlegen(u);
    expect((await hochladen(neu.token, ANFANG, '?trockenlauf=1')).statusCode).toBe(200);
    const url = `/api/v1/projektkatalog/tokens/${neu.id}`;
    expect((await app.inject({ method: 'DELETE', url, headers: andere.admin })).statusCode).toBe(
      404,
    );
    expect((await hochladen(neu.token, ANFANG, '?trockenlauf=1')).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url, headers: u.admin })).statusCode).toBe(204);
    expect((await hochladen(neu.token, ANFANG)).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url, headers: u.admin })).statusCode).toBe(404);
    expect(await projekte(u)).toEqual([]);
    expect((await auditEintraege(u.mandantId)).map((a) => a.aktion)).toContain(
      'Katalog-Import-Token widerrufen',
    );
  });

  it('nur Mandanten-Admin verwaltet Tokens', async () => {
    const u = await umgebung();
    for (const rolle of ['controller', 'projektleiter', 'entwickler'] as const) {
      const k = await meldeAn(db, u.mandantId, rolle);
      for (const [method, url] of [
        ['GET', '/api/v1/projektkatalog/tokens'],
        ['POST', '/api/v1/projektkatalog/tokens'],
        ['DELETE', `/api/v1/projektkatalog/tokens/${randomUUID()}`],
      ] as const) {
        const r = await app.inject({
          method,
          url,
          headers: k.headers,
          ...(method === 'POST' ? { payload: { bezeichnung: 'x' } } : {}),
        });
        expect(r.statusCode, `${rolle} ${method}`).toBe(403);
      }
    }
  });

  it('Mandanten-, Rechner- und Fremd-Tokens gelten auf der Upload-Route nicht', async () => {
    const u = await umgebung();
    for (const t of [u.ingestToken, `smr_${'a'.repeat(43)}`, `smk_${'a'.repeat(43)}`, 'Unsinn']) {
      const r = await hochladen(t, ANFANG);
      expect(r.statusCode, t.slice(0, 4)).toBe(401);
    }
    expect(await projekte(u)).toEqual([]);
    // Ein Authorization-Kopf schließt die Anmeldung per Cookie aus.
    const r = await app.inject({
      method: 'POST',
      url: PFAD,
      headers: { ...u.admin, 'content-type': 'text/csv', authorization: `Bearer ${u.ingestToken}` },
      payload: ANFANG,
    });
    expect(r.statusCode).toBe(401);
    expect(await projekte(u)).toEqual([]);
  });

  it('wirkt nur im eigenen Mandanten: RLS auf der Token-Tabelle, Katalog des anderen unberührt', async () => {
    const a = await umgebung();
    const b = await umgebung();
    const ta = await tokenAnlegen(a);
    await tokenAnlegen(b);
    await ergebnis((await tokenAnlegen(b, 'B')).token, 'Nummer;Name\nB-1;Fremd\n');
    await ergebnis(ta.token, 'Nummer;Name\nA-1;Eigen\n');
    expect((await projekte(a)).map((p) => p.nummer)).toEqual(['A-1']);
    expect((await projekte(b)).map((p) => p.nummer)).toEqual(['B-1']);
    const sichtbar = await withMandant(db, a.mandantId, (trx) =>
      trx.selectFrom('katalog_import_token').select('mandant_id').execute(),
    );
    expect(new Set(sichtbar.map((z) => z.mandant_id))).toEqual(new Set([a.mandantId]));
    const rls = await sql<{ relrowsecurity: boolean }>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'katalog_import_token'`.execute(db);
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const listeB = katalogTokenListeSchema.parse(
      (await app.inject({ url: '/api/v1/projektkatalog/tokens', headers: b.admin })).json(),
    );
    expect(listeB.tokens.map((t) => t.id)).not.toContain(ta.id);
  });

  it('das Token öffnet keine andere Route: gleiche Antwort wie ganz ohne Anmeldung', async () => {
    const u = await umgebung();
    const { token } = await tokenAnlegen(u);
    const routen = routenAus(app.printRoutes({ commonPrefix: false }));
    expect(routen.length).toBeGreaterThan(50);
    expect(routen.some((r) => r.url.startsWith('/otlp/'))).toBe(true);
    const abweichend: string[] = [];
    for (const { method, url } of routen) {
      if (url === PFAD) continue;
      const anfrage = {
        method,
        url,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { payload: '{}' }),
      } as const;
      const ohne = await app.inject(anfrage);
      const mit = await app.inject({
        ...anfrage,
        headers: { ...anfrage.headers, authorization: `Bearer ${token}` },
      });
      if (ohne.statusCode !== mit.statusCode) {
        abweichend.push(`${method} ${url}: ${ohne.statusCode} / ${mit.statusCode}`);
      }
    }
    expect(abweichend).toEqual([]);
    expect(await projekte(u)).toEqual([]);
  });
});

/** Liest die Routen aus `printRoutes` (Baum mit Einrückung), Parameter werden zu einer UUID. */
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

describe('CLI', () => {
  const zeilen = () => {
    const ausgabe: string[] = [];
    const fehler: string[] = [];
    return {
      ausgabe,
      fehler,
      u: {
        db,
        eingabe: Readable.from([] as Buffer[]),
        ausgabe: (z: string) => ausgabe.push(z),
        fehler: (z: string) => fehler.push(z),
      },
    };
  };
  const ordner = mkdtempSync(join(tmpdir(), 'katalog-cli-'));
  afterAll(() => rmSync(ordner, { recursive: true, force: true }));
  const datei = (name: string, inhalt: string | Buffer) => {
    const p = join(ordner, name);
    writeFileSync(p, inhalt);
    return p;
  };

  it('liest aus Datei und Standardeingabe, gibt JSON aus, Exit 0; im Protokoll als CLI-Lauf', async () => {
    const u = await umgebung();
    const a = zeilen();
    expect(await katalogCli(['--mandant', u.slug, '--datei', datei('a.csv', ANFANG)], a.u)).toBe(0);
    expect(katalogImportErgebnisSchema.parse(JSON.parse(a.ausgabe[0] ?? ''))).toMatchObject({
      neu: 3,
    });
    const audit = await auditEintraege(u.mandantId);
    expect(audit[0]?.objekt).toContain('ausloeser:cli');
    expect(audit[0]?.benutzer_id).toBeNull();

    const b = zeilen();
    expect(
      await katalogCli(['--mandant', u.slug, '--datei', '-', '--teilliste'], {
        ...b.u,
        eingabe: Readable.from([Buffer.from('Nummer;Name;Kunde\nP-4;Vier;\n')]),
      }),
    ).toBe(0);
    expect(JSON.parse(b.ausgabe[0] ?? '')).toMatchObject({ neu: 1, deaktiviert: 0 });
    expect((await einstellung(u)).projekte_aktiv).toBe(4);
  });

  it('Spalten und Trennzeichen; Exit 2 bei abgelehnten Zeilen, Daten trotzdem übernommen', async () => {
    const u = await umgebung();
    const a = zeilen();
    const pfad = datei('b.csv', 'Kennung,Titel,Egal\nA-1,Eins,x\nA-2,,y\n');
    expect(
      await katalogCli(
        [
          '--mandant',
          u.slug,
          '--datei',
          pfad,
          '--trennzeichen',
          'komma',
          '--spalte-id',
          'Kennung',
          '--spalte-name',
          'Titel',
        ],
        a.u,
      ),
    ).toBe(2);
    expect(JSON.parse(a.ausgabe[0] ?? '')).toMatchObject({ neu: 1, abgelehnt: 1 });
    expect((await projekte(u)).map((p) => p.nummer)).toEqual(['A-1']);
  });

  it('Trockenlauf: dieselben Zahlen, nichts geschrieben, kein Protokoll', async () => {
    const u = await umgebung();
    const a = zeilen();
    expect(
      await katalogCli(
        ['--mandant', u.slug, '--datei', datei('c.csv', ANFANG), '--trockenlauf'],
        a.u,
      ),
    ).toBe(0);
    expect(JSON.parse(a.ausgabe[0] ?? '')).toMatchObject({ neu: 3, trockenlauf: true });
    expect(await projekte(u)).toEqual([]);
    expect(await auditEintraege(u.mandantId)).toEqual([]);
  });

  it('Exit 1 ohne Änderung bei jedem Fehler, Meldung als JSON auf stderr', async () => {
    const u = await umgebung();
    const gut = datei('d.csv', ANFANG);
    for (const argumente of [
      [],
      ['--mandant', u.slug],
      ['--datei', gut],
      ['--mandant', 'gibt-es-nicht', '--datei', gut],
      ['--mandant', u.slug, '--datei', join(ordner, 'fehlt.csv')],
      ['--mandant', u.slug, '--datei', gut, '--unbekannt'],
      ['--mandant', u.slug, '--datei', gut, '--trennzeichen', 'x'],
      ['--mandant', u.slug, '--datei', gut, '--spalte-id', 'Nummer'],
      [
        '--mandant',
        u.slug,
        '--datei',
        datei('e.csv', Buffer.from('Nummer;Name\nP-1;Straße\n', 'latin1')),
      ],
      ['--mandant', u.slug, '--datei', datei('f.csv', 'Nummer,Name\nP-1,Eins\n')],
    ]) {
      const a = zeilen();
      expect(await katalogCli(argumente, a.u), argumente.join(' ')).toBe(1);
      expect(a.ausgabe).toEqual([]);
      expect(JSON.parse(a.fehler[0] ?? '')).toHaveProperty('fehler');
    }
    const zuGross = zeilen();
    expect(
      await katalogCli(['--mandant', u.slug, '--datei', '-'], {
        ...zuGross.u,
        eingabe: Readable.from([Buffer.alloc(KATALOG_DATEI_MAX_BYTES + 1, 0x41)]),
      }),
    ).toBe(1);
    expect(await projekte(u)).toEqual([]);
  });
});
