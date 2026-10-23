// Fixture-Antworten der API für Komponententests. Nur erfundene Werte (example.org, Pseudonyme).
//
// Alle Vertrags-Fixtures sind mit `satisfies <Typ aus @seatmeter/shared>` geschrieben: Ändert der
// Server-Vertrag ein Feld, schlägt `tsc` hier fehl (zusätzlich prüft fixtures.test.ts sie zur Laufzeit
// gegen die Antwort-Schemas des Clients).
import type {
  AusrollenKonfiguration,
  AuthMe,
  BetriebsratBericht,
  Datenqualitaet,
  KalkulationAntwort,
  Kurs,
  KurseAntwort,
  MandantEinstellungen,
  Monatsabschluss,
  ProjektpreisZeile,
  Kennzahlen,
  ModellZeile,
  PersonenAntwort,
  PersonZeile,
  PreisDto,
  ProjektDetail,
  ProjektIssuesAntwort,
  ProjektZeile,
  TagZeile,
  Uebersicht,
} from '@seatmeter/shared';
import type { FetchFunktion } from '../api/client';
import type { PreiseAntwort, ProjekteAntwort, RechnerListe, SitzkostenAntwort } from '../api/typen';

export const MONAT = '2026-10';

export type Antwort = { status: number; body?: unknown } | ((init?: RequestInit) => Response);

/** Routen: `"/pfad?query"` für GET, `"POST /pfad"` für andere Methoden. Unbekannt → 404. */
export type Routen = Record<string, Antwort>;

export interface Aufruf {
  methode: string;
  pfad: string;
  body: unknown;
  /** Header der Anfrage, Namen klein geschrieben. */
  headers: Record<string, string>;
}

export function json(body: unknown, status = 200): { status: number; body: unknown } {
  return { status, body };
}

/** Baut eine `fetch`-Funktion aus einer Routen-Tabelle und protokolliert alle Aufrufe. */
export function fixtureFetch(routen: Routen): { fetch: FetchFunktion; aufrufe: Aufruf[] } {
  const aufrufe: Aufruf[] = [];
  const fetch: FetchFunktion = async (pfad, init) => {
    const methode = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    // happy-dom behält die Schreibweise der Header-Namen bei, daher selbst klein schreiben.
    const headers = Object.fromEntries(
      [...new Headers(init?.headers).entries()].map(([k, v]) => [k.toLowerCase(), v]),
    );
    aufrufe.push({ methode, pfad, body, headers });
    const eintrag = routen[methode === 'GET' ? pfad : `${methode} ${pfad}`];
    if (!eintrag)
      return new Response(JSON.stringify({ fehler: 'nicht gefunden' }), { status: 404 });
    if (typeof eintrag === 'function') return eintrag(init);
    if (eintrag.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(eintrag.body ?? {}), {
      status: eintrag.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, aufrufe };
}

/** Kennzahlen aus Token-Anteilen; `gesamt` wie auf dem Server (input + output + cache_read + cache_write). */
export function kennzahlen(
  t: { input: number; output: number; cache_read: number; cache_write: number },
  anfragen: number,
  schatten_usd_micros: number,
): Kennzahlen {
  return {
    tokens: {
      ...t,
      cache_write_1h: 0,
      web_search: 0,
      gesamt: t.input + t.output + t.cache_read + t.cache_write,
    },
    anfragen,
    schatten_usd_micros,
  };
}

export const CSRF = 'csrf-aus-me';

export const ME_ADMIN = {
  benutzer: { id: 'b-1', benutzername: 'admin', login: 'admin' },
  mandant_id: 'm-1',
  mandant: { id: 'm-1', name: 'Beispiel GmbH', slug: 'beispiel' },
  provider: 'lokal',
  rollen: ['mandanten_admin'],
  mandanten: [{ id: 'm-1', name: 'Beispiel GmbH', slug: 'beispiel', rollen: ['mandanten_admin'] }],
  csrf: CSRF,
} satisfies AuthMe;

/** Leser hinter Authelia (Header-Modus): Sitzung samt CSRF legt der Server beim ersten GET an. */
export const ME_LESER = {
  benutzer: { id: 'b-2', benutzername: 'leser@example.org', login: 'leser@example.org' },
  mandant_id: 'm-1',
  mandant: { id: 'm-1', name: 'Beispiel GmbH', slug: 'beispiel' },
  provider: 'remote_user',
  rollen: ['controller'],
  mandanten: [{ id: 'm-1', name: 'Beispiel GmbH', slug: 'beispiel', rollen: ['controller'] }],
  csrf: 'csrf-leser',
} satisfies AuthMe;

const OPUS = {
  model: 'claude-opus-5-5',
  ...kennzahlen(
    { input: 2_000_000, output: 1_500_000, cache_read: 300_000_000, cache_write: 20_000_000 },
    1000,
    258_000_000,
  ),
} satisfies ModellZeile;

const SONNET = {
  model: 'claude-sonnet-5-5',
  ...kennzahlen(
    { input: 1_000_000, output: 500_000, cache_read: 150_000_000, cache_write: 10_000_000 },
    234,
    161_500_000,
  ),
} satisfies ModellZeile;

export const UEBERSICHT = {
  monat: MONAT,
  ...kennzahlen(
    { input: 3_000_000, output: 2_000_000, cache_read: 450_000_000, cache_write: 30_000_000 },
    1234,
    419_500_000,
  ),
  nach_modell: [OPUS, SONNET],
  abdeckung: { anfragen: 1200, nur_a: 0, nur_b: 30, beide: 1170, a_prozent: 97.5, b_prozent: 100 },
  gefiltert: { api: 12, fremd_org: 3, inhalt_verworfen: 0 },
} satisfies Uebersicht;

export const UEBERSICHT_LEER = {
  ...UEBERSICHT,
  ...kennzahlen({ input: 0, output: 0, cache_read: 0, cache_write: 0 }, 0, 0),
  nach_modell: [],
} satisfies Uebersicht;

const PROJEKT_X_SHOP = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'x-shop',
  kunde: 'Kunde A',
  url_norm: 'git.example.org/beispiel/x-shop',
  personen: 3,
  personen_hinweis: null,
  ...kennzahlen(
    { input: 2_000_000, output: 1_500_000, cache_read: 300_000_000, cache_write: 30_000_000 },
    900,
    367_000_000,
  ),
} satisfies ProjektZeile;

/** Topf ohne Projekt: `id: null`, Name vom Server. */
export const PROJEKT_UNZUGEORDNET = {
  id: null,
  name: 'unzugeordnet',
  kunde: null,
  url_norm: null,
  personen: null,
  personen_hinweis: 'zu wenige Personen',
  ...kennzahlen({ input: 500, output: 400, cache_read: 100, cache_write: 0 }, 10, 1_000_000),
} satisfies ProjektZeile;

export const PROJEKTE = {
  monat: MONAT,
  auswertungsstufe: 1,
  projekte: [PROJEKT_X_SHOP, PROJEKT_UNZUGEORDNET],
} satisfies ProjekteAntwort;

export const PROJEKT_ID = PROJEKT_X_SHOP.id;

const TAGE = [
  {
    tag: '2026-10-01',
    ...kennzahlen(
      { input: 1_000_000, output: 500_000, cache_read: 140_000_000, cache_write: 8_500_000 },
      400,
      120_000_000,
    ),
  },
  {
    tag: '2026-10-02',
    ...kennzahlen(
      { input: 1_000_000, output: 1_000_000, cache_read: 160_000_000, cache_write: 21_500_000 },
      500,
      138_000_000,
    ),
  },
] satisfies TagZeile[];

const PERSON = {
  id: '00000000-0000-4000-8000-0000000000a1',
  pseudonym: 'P-K7Q2MX',
  klarname: null,
  ...kennzahlen({ input: 600, output: 300, cache_read: 100, cache_write: 0 }, 3, 1_500_000),
} satisfies PersonZeile;

const { tokens: _t, anfragen: _a, schatten_usd_micros: _s, ...PROJEKT_KOPF } = PROJEKT_X_SHOP;

export const PROJEKT_DETAIL = {
  monat: MONAT,
  projekt: PROJEKT_KOPF,
  ...kennzahlen(
    { input: 2_000_000, output: 1_500_000, cache_read: 300_000_000, cache_write: 30_000_000 },
    900,
    258_000_000,
  ),
  nach_modell: [OPUS],
  nach_tag: TAGE,
  auswertungsstufe: 1,
  personen: [PERSON],
  personen_hinweis: null,
} satisfies ProjektDetail;

/** Issues des Projekts x-shop: zwei Schlüssel und der Rest ohne Schlüssel. */
export const PROJEKT_ISSUES = {
  monat: MONAT,
  projekt: { id: PROJEKT_X_SHOP.id, name: 'x-shop' },
  issues: [
    {
      schluessel: 'ABC-123',
      projekt_schluessel: 'ABC',
      sitzungen: 4,
      ...kennzahlen(
        { input: 1_000_000, output: 500_000, cache_read: 0, cache_write: 0 },
        300,
        129_000_000,
      ),
    },
    {
      schluessel: 'ABC-124',
      projekt_schluessel: 'ABC',
      sitzungen: 1,
      ...kennzahlen({ input: 500_000, output: 0, cache_read: 0, cache_write: 0 }, 100, 64_500_000),
    },
  ],
  ohne_schluessel: kennzahlen(
    { input: 500_000, output: 1_000_000, cache_read: 300_000_000, cache_write: 30_000_000 },
    500,
    64_500_000,
  ),
  gesamt: kennzahlen(
    { input: 2_000_000, output: 1_500_000, cache_read: 300_000_000, cache_write: 30_000_000 },
    900,
    258_000_000,
  ),
} satisfies ProjektIssuesAntwort;

/** Projektleiter-Sicht ohne Personenrecht: Server schickt `personen: null` mit Hinweis. */
export const PROJEKT_DETAIL_OHNE_PERSONEN = {
  ...PROJEKT_DETAIL,
  projekt: { ...PROJEKT_KOPF, personen_hinweis: 'Rolle ohne Personensicht' },
  personen: null,
  personen_hinweis: 'Rolle ohne Personensicht',
} satisfies ProjektDetail;

export const PROJEKT_DETAIL_UNZUGEORDNET = {
  monat: MONAT,
  projekt: {
    id: null,
    name: 'unzugeordnet',
    kunde: null,
    url_norm: null,
    personen: null,
    personen_hinweis: 'zu wenige Personen',
  },
  ...kennzahlen({ input: 500, output: 400, cache_read: 100, cache_write: 0 }, 10, 1_000_000),
  nach_modell: [
    {
      model: 'claude-haiku-5',
      ...kennzahlen({ input: 500, output: 400, cache_read: 100, cache_write: 0 }, 10, 1_000_000),
    },
  ],
  nach_tag: [],
  auswertungsstufe: 1,
  personen: null,
  personen_hinweis: 'zu wenige Personen',
} satisfies ProjektDetail;

export const PERSONEN = {
  monat: MONAT,
  auswertungsstufe: 1,
  klarnamen_aktiv: false,
  personen: [PERSON],
  personen_hinweis: null,
} satisfies PersonenAntwort;

export const PERSONEN_ZU_WENIGE = {
  monat: MONAT,
  auswertungsstufe: 1,
  klarnamen_aktiv: false,
  personen: null,
  personen_hinweis: 'zu wenige Personen',
} satisfies PersonenAntwort;

export const DATENQUALITAET = {
  monat: MONAT,
  abdeckung: {
    anfragen: 125,
    nur_a: 5,
    nur_b: 20,
    beide: 100,
    a_prozent: 84,
    b_prozent: 96,
    heuristisch: 3,
    abweichung_ab: 6,
  },
  unzugeordnet: { tokens: 1000, anfragen: 4, tokens_prozent: 0.5 },
  modelle_ohne_preis: ['claude-neu-1'],
  ingest: [
    {
      quelle: 'a',
      angenommen: 105,
      verworfen_inhalt: 1,
      verworfen_api: 2,
      verworfen_fremd_org: 0,
      unzugeordnet: 4,
    },
    {
      quelle: 'b',
      angenommen: 120,
      verworfen_inhalt: 0,
      verworfen_api: 0,
      verworfen_fremd_org: 7,
      unzugeordnet: 0,
    },
  ],
  kontrollsumme: {
    sitzungen: 12,
    sitzungen_abweichend: 1,
    tokens_kontrolle: 2_000_000,
    tokens_gezaehlt: 1_990_000,
    prozent: 99.5,
  },
} satisfies Datenqualitaet;

const PREIS_OPUS = {
  id: '00000000-0000-4000-8000-0000000000b1',
  mandant_id: null,
  herkunft: 'global',
  aktiv: true,
  modell_praefix: 'claude-opus-5-5',
  gueltig_ab: '2026-10-01',
  saetze: { input: 4, output: 20, cache_read: 0.2, cache_write_5m: 5, cache_write_1h: 8 },
  fast_input: null,
  fast_output: null,
  prompt_schwelle_tokens: null,
  lang: null,
  geo_us_faktor: 1,
  quelle_url: 'https://example.org/preise',
  geprueft_am: '2026-10-22',
} satisfies PreisDto;

export const PREISE = {
  zeilen: [
    PREIS_OPUS,
    {
      ...PREIS_OPUS,
      id: '00000000-0000-4000-8000-0000000000b2',
      mandant_id: '00000000-0000-4000-8000-0000000000c1',
      herkunft: 'mandant',
      modell_praefix: 'claude-sonnet-5-5',
    },
  ],
} satisfies PreiseAntwort;

export const SITZKOSTEN = {
  zeilen: [
    {
      sitz_typ: 'premium',
      gueltig_ab: '2026-01-01',
      preis_monat: 100,
      waehrung: 'USD',
      abrechnung: 'jaehrlich',
    },
  ],
} satisfies SitzkostenAntwort;

/** Standard-Sitzkosten eines neuen Mandanten (Migration 0017): Max 5x und Max 20x. */
export const SITZKOSTEN_MAX = {
  zeilen: [
    {
      sitz_typ: 'max20',
      gueltig_ab: '2025-01-01',
      preis_monat: 200,
      waehrung: 'USD',
      abrechnung: 'monatlich',
    },
    {
      sitz_typ: 'max5',
      gueltig_ab: '2025-01-01',
      preis_monat: 100,
      waehrung: 'USD',
      abrechnung: 'monatlich',
    },
  ],
} satisfies SitzkostenAntwort;

// GET /api/v1/rechner (Vertrag `rechnerListeSchema` in shared).
export const RECHNER = {
  rechner: [
    {
      id: 'r-1',
      bezeichnung: 'Notebook 1',
      os: 'macos',
      agent_version: '0.1.0',
      registriert: '2026-10-20T08:00:00.000Z',
      zuletzt_gesehen: '2026-10-22T09:30:00.000Z',
      widerrufen: null,
      person_id: null,
      person_pseudonym: 'P-K7Q2MX',
    },
  ],
} satisfies RechnerListe;

// ---------------------------------------------------------------------------------------------
// Phase 3: Kalkulation (Rechenbeispiel Architektur §5), Kurs, Einstellungen, Berichte.

/** Betriebsrat: sieht Berichte, aber keine Kalkulation (403). */
export const ME_BETRIEBSRAT = {
  ...ME_LESER,
  benutzer: { id: 'b-3', benutzername: 'br@example.org', login: 'br@example.org' },
  rollen: ['betriebsrat'],
  mandanten: [{ id: 'm-1', name: 'Beispiel GmbH', slug: 'beispiel', rollen: ['betriebsrat'] }],
  csrf: 'csrf-br',
} satisfies AuthMe;

export const KURS_OKTOBER = {
  monat: MONAT,
  usd_eur: 0.86,
  quelle: 'ezb',
  vorlaeufig: true,
  aktualisiert: '2026-10-22T03:00:00.000Z',
} satisfies Kurs;

export const KURSE = {
  zeilen: [
    KURS_OKTOBER,
    {
      monat: '2026-09',
      usd_eur: 0.868565,
      quelle: 'manuell',
      vorlaeufig: false,
      aktualisiert: '2026-10-01T08:00:00.000Z',
    },
  ],
} satisfies KurseAntwort;

const tokens = (input: number, output: number, cache_read: number, cache_write: number) => ({
  input,
  output,
  cache_read,
  cache_write,
  cache_write_1h: cache_write,
  web_search: 0,
  gesamt: input + output + cache_read + cache_write,
});

const ZEILE_X_SHOP = {
  topf: 'projekt',
  projekt_id: '00000000-0000-4000-8000-000000000001',
  name: 'x-shop',
  kunde: 'Kunde A',
  tokens: tokens(3_000_000, 2_000_000, 450_000_000, 30_000_000),
  anfragen: 900,
  schatten_usd_micros: 367_000_000,
  sitzanteil_usd_micros: 187_457_627,
  ueberschreitung_usd_micros: 15_000_000,
  projektpreis_usd_micros: 569_457_627,
  projektpreis_usd_cent: 56_946,
  projektpreis_eur_cent: 48_974,
  preis_version: 'global:claude-opus-5-5@2026-01-01',
} satisfies ProjektpreisZeile;

const ZEILE_Y_PORTAL = {
  ...ZEILE_X_SHOP,
  projekt_id: '00000000-0000-4000-8000-000000000002',
  name: 'y-portal',
  kunde: null,
  tokens: tokens(1_000_000, 500_000, 100_000_000, 5_000_000),
  anfragen: 120,
  schatten_usd_micros: 37_000_000,
  sitzanteil_usd_micros: 12_542_373,
  ueberschreitung_usd_micros: 0,
  projektpreis_usd_micros: 49_542_373,
  projektpreis_usd_cent: 4_954,
  projektpreis_eur_cent: 4_260,
  preis_version: 'global:claude-sonnet-5-5@2026-01-01',
} satisfies ProjektpreisZeile;

const ZEILE_UNGENUTZT = {
  ...ZEILE_X_SHOP,
  topf: 'ungenutzt',
  projekt_id: null,
  name: 'ungenutzt',
  kunde: null,
  tokens: tokens(0, 0, 0, 0),
  anfragen: 0,
  schatten_usd_micros: 0,
  sitzanteil_usd_micros: 20_000_000,
  ueberschreitung_usd_micros: 0,
  projektpreis_usd_micros: 20_000_000,
  projektpreis_usd_cent: 2_000,
  projektpreis_eur_cent: 1_720,
  preis_version: '',
} satisfies ProjektpreisZeile;

/** §5: x-shop 569,46 $ ≈ 489,74 €, y-portal 49,54 $ ≈ 42,60 €, ungenutzt 20 $ ≈ 17,20 €. */
export const KALKULATION = {
  monat: MONAT,
  quelle: 'live',
  eingefroren_am: null,
  abgeschlossen: false,
  einstellungen: {
    sitzkosten_verteilung: 'person',
    code_anteil_sitz: 1,
    schatten_faktor: 1,
    cache_write_annahme: '1h',
  },
  kurs: KURS_OKTOBER,
  ueberschreitung_abgezogen: true,
  sitzkosten_usd_micros: 220_000_000,
  zeilen: [ZEILE_X_SHOP, ZEILE_Y_PORTAL, ZEILE_UNGENUTZT],
  summe: {
    schatten_usd_micros: 404_000_000,
    sitzanteil_usd_micros: 220_000_000,
    ueberschreitung_usd_micros: 15_000_000,
    projektpreis_usd_micros: 639_000_000,
    projektpreis_usd_cent: 63_900,
    projektpreis_eur_cent: 54_954,
  },
  hinweise: [],
} satisfies KalkulationAntwort;

export const KALKULATION_OHNE_UEBERSCHREITUNG = {
  ...KALKULATION,
  ueberschreitung_abgezogen: false,
  hinweise: ['Personen mit Nutzung ohne Sitz: 1'],
} satisfies KalkulationAntwort;

export const KALKULATION_OHNE_KURS = {
  ...KALKULATION,
  kurs: { monat: MONAT, usd_eur: null, quelle: null, vorlaeufig: false, aktualisiert: null },
  zeilen: KALKULATION.zeilen.map((z) => ({ ...z, projektpreis_eur_cent: null })),
  summe: { ...KALKULATION.summe, projektpreis_eur_cent: null },
} satisfies KalkulationAntwort;

/** Vergangener Monat (Abschluss möglich). */
export const MONAT_ALT = '2026-09';

export const MONATSABSCHLUSS_OFFEN = {
  monat: MONAT_ALT,
  abgeschlossen: false,
  abschluss: null,
} satisfies Monatsabschluss;

export const MONATSABSCHLUSS = {
  monat: MONAT_ALT,
  abgeschlossen: true,
  abschluss: {
    ...KALKULATION,
    monat: MONAT_ALT,
    quelle: 'monatsabschluss',
    eingefroren_am: '2026-10-01T03:30:00.000Z',
    abgeschlossen: true,
    sitzkosten_usd_micros: null,
  },
} satisfies Monatsabschluss;

export const MANDANT_EINSTELLUNGEN = {
  zeitzone: 'Europe/Berlin',
  waehrung: 'EUR',
  sitzkosten_verteilung: 'person',
  code_anteil_sitz: 1,
  schatten_faktor: 1,
  cache_write_annahme: '1h',
  auswertungsstufe: 1,
  klarnamen_aktiv: false,
} satisfies MandantEinstellungen;

export const BETRIEBSRAT = {
  monat: MONAT,
  zeitraum: { von: '2026-10-01', bis: '2026-10-31' },
  erstellt: '2026-10-22T10:00:00.000Z',
  zweck: 'Projektkalkulation und Kostensteuerung; keine Leistungs- oder Verhaltenskontrolle.',
  konfiguration: {
    auswertungsstufe: 1,
    auswertungsstufe_text: '1 – Pseudonym, Monat',
    klarnamen_aktiv: false,
    mindestgruppe: 3,
    aufbewahrung: {
      anfrage_tage: 90,
      aggregat_monate: 13,
      abschluss_monate: 24,
      kontrollsumme_tage: 30,
      statistik_monate: 13,
      audit_monate: 24,
    },
    quellen: { a: true, b: false, c: false },
    aenderungen: [
      {
        ts: '2026-10-05T09:00:00.000Z',
        aktion: 'Einstellungen geändert',
        objekt: 'schatten_faktor',
      },
    ],
  },
  datenkategorien: {
    erfasst: ['Token-Zähler', 'Modell', 'Datum', 'Projekt (Repo)', 'Pseudonym'],
    nicht_erfasst: ['Inhalte', 'Prompts', 'Dateinamen', 'Uhrzeiten je Person'],
  },
  zugriffe: {
    konten: [
      { rolle: 'mandanten_admin', anzahl: 1 },
      { rolle: 'betriebsrat', anzahl: 2 },
    ],
    personensichten: 4,
    exporte: 7,
    ansichten: 3,
    protokoll: [
      { aktion: 'Personensicht geöffnet', anzahl: 4 },
      { aktion: 'Export Betriebsrat', anzahl: 7 },
      { aktion: 'Ansicht Betriebsrat', anzahl: 3 },
    ],
  },
  mengen: { personen: 5, rechner: 2, projekte: 3, anfragen: 1234, tokens: 485_000_000 },
  datenschutz: {
    angenommen: 1234,
    verworfen_inhalt: 17,
    verworfen_api: 2,
    verworfen_fremd_org: 1,
    unzugeordnet: 3,
    loeschlaeufe: [
      { ts: '2026-10-21T02:45:00.000Z', tabelle: 'anfrage', bis: '2026-07-23', anzahl: 512 },
    ],
  },
  version: { seatmeter: '0.3.0', agenten: ['0.2.0'] },
  hinweis: 'Grundlage ist die Betriebsvereinbarung vom 01.10.2026.',
} satisfies BetriebsratBericht;

/** GET /api/v1/ausrollen: zwei Orgs, Ingest-URL aus der Konfiguration, Release-URL gesetzt. */
export const AUSROLLEN = {
  mandant: { slug: 'beispiel', name: 'Beispiel GmbH', plan: 'team' },
  ingest_url: 'https://ingest.example.org',
  ingest_url_quelle: 'konfiguration',
  otlp_endpoint: 'https://ingest.example.org/otlp',
  orgs: [
    { org_uuid: '11111111-1111-4111-8111-111111111111', bezeichnung: 'Entwicklung', plan: 'team' },
    { org_uuid: '22222222-2222-4222-8222-222222222222', bezeichnung: null, plan: null },
  ],
  agent: {
    release_url: 'https://git.example.org/beispiel/seatmeter/releases/download/v0.1.0',
    server_version: '0.5.0',
  },
} satisfies AusrollenKonfiguration;
