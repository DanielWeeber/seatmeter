// Fixture-Antworten der Module Budgets, Hinweise und Abgleich (Kern seit 2026-10-24, vorher ee/web).
// Nur erfundene Werte (example.com, Pseudonyme). Alle Vertrags-Fixtures sind mit `satisfies <Typ aus
// @seatmeter/shared>` geschrieben; fixtures-module.test.ts prüft sie zusätzlich zur Laufzeit.
import type {
  AbgleichLaeufe,
  AbgleichLauf,
  AbgleichStatus,
  Alarm,
  AlarmListe,
  Budget,
  BudgetListe,
  CsvVorschau,
  Hinweis,
  HinweisListe,
  HinweisRegeln,
  Kanal,
  KanalListe,
  KanalTestErgebnis,
} from '@seatmeter/shared';
import { MONAT, PROJEKT_ID } from './fixtures';

/** Gültige UUID (Version 4) mit laufender Nummer. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------------------------------------
// Budgets und Alarme

/** Mandantenweites Budget: 570 € Prognose von 600 € (95 % zum Monatsende). */
export const BUDGET_GESAMT = {
  id: uuid(1),
  projekt_id: null,
  projekt_name: null,
  bezeichnung: 'Gesamtbudget',
  betrag: 600,
  waehrung: 'EUR',
  basis: 'projektpreis',
  schwellen: [50, 80, 100],
  ausloeser: 'prognose',
  aktiv: true,
  erstellt: '2026-10-01T08:00:00.000Z',
  stand: {
    monat: MONAT,
    verbrauch: 300,
    prognose: 570,
    prozent: 50,
    prognose_prozent: 95,
    arbeitstage_bisher: 11,
    arbeitstage_monat: 21,
    hinweis: null,
  },
} satisfies Budget;

/** Projektbudget über Prognose: 480 € von 400 € (120 %). */
export const BUDGET_PROJEKT = {
  id: uuid(2),
  projekt_id: PROJEKT_ID,
  projekt_name: 'x-shop',
  bezeichnung: null,
  betrag: 400,
  waehrung: 'EUR',
  basis: 'projektpreis',
  schwellen: [50, 80, 100],
  ausloeser: 'verbrauch',
  aktiv: true,
  erstellt: '2026-10-01T08:05:00.000Z',
  stand: {
    monat: MONAT,
    verbrauch: 360,
    prognose: 480,
    prozent: 90,
    prognose_prozent: 120,
    arbeitstage_bisher: 11,
    arbeitstage_monat: 21,
    hinweis: null,
  },
} satisfies Budget;

/** Token-Budget (Basis tokens): Betrag in Tokens. */
export const BUDGET_TOKENS = {
  id: uuid(3),
  projekt_id: PROJEKT_ID,
  projekt_name: 'x-shop',
  bezeichnung: 'Token-Grenze',
  betrag: 2_000_000,
  waehrung: 'EUR',
  basis: 'tokens',
  schwellen: [80, 100],
  ausloeser: 'prognose',
  aktiv: true,
  erstellt: '2026-10-01T08:10:00.000Z',
  stand: {
    monat: MONAT,
    verbrauch: 1_200_000,
    prognose: 1_800_000,
    prozent: 60,
    prognose_prozent: 90,
    arbeitstage_bisher: 11,
    arbeitstage_monat: 21,
    hinweis: null,
  },
} satisfies Budget;

export const BUDGETS = {
  monat: MONAT,
  budgets: [BUDGET_GESAMT, BUDGET_PROJEKT, BUDGET_TOKENS],
} satisfies BudgetListe;

/** Ohne mandantenweites Budget: die Kachel zählt die Budgets über Prognose (1 von 2). */
export const BUDGETS_OHNE_GESAMT = {
  monat: MONAT,
  budgets: [BUDGET_PROJEKT, BUDGET_TOKENS],
} satisfies BudgetListe;

export const BUDGETS_LEER = { monat: MONAT, budgets: [] } satisfies BudgetListe;

export const ALARM_OFFEN = {
  id: uuid(11),
  budget_id: BUDGET_PROJEKT.id,
  budget_name: 'x-shop',
  projekt_id: PROJEKT_ID,
  monat: MONAT,
  schwelle: 80,
  prozent: 90,
  wert: 360,
  betrag: 400,
  einheit: 'EUR',
  ausgeloest: '2026-10-14T06:30:00.000Z',
  quittiert: null,
  zustellung: 'fehler',
  zustellfehler: 'Webhook antwortete mit Status 500',
} satisfies Alarm;

export const ALARM_QUITTIERT = {
  id: uuid(12),
  budget_id: BUDGET_PROJEKT.id,
  budget_name: 'x-shop',
  projekt_id: PROJEKT_ID,
  monat: MONAT,
  schwelle: 50,
  prozent: 50,
  wert: 200,
  betrag: 400,
  einheit: 'EUR',
  ausgeloest: '2026-10-08T06:30:00.000Z',
  quittiert: '2026-10-09T07:00:00.000Z',
  zustellung: 'zugestellt',
  zustellfehler: null,
} satisfies Alarm;

/** Antwort mit `offen=1`. */
export const ALARME_OFFEN = { alarme: [ALARM_OFFEN] } satisfies AlarmListe;
/** Antwort ohne Filter. */
export const ALARME_ALLE = { alarme: [ALARM_OFFEN, ALARM_QUITTIERT] } satisfies AlarmListe;
export const ALARME_LEER = { alarme: [] } satisfies AlarmListe;

export const KANAL_WEBHOOK = {
  id: uuid(21),
  typ: 'webhook',
  bezeichnung: 'Team-Webhook',
  aktiv: true,
  konfig: { url: 'https://hooks.example.com/alarm' },
  geheimnis_gesetzt: true,
  erstellt: '2026-10-01T08:00:00.000Z',
  geaendert: '2026-10-02T08:00:00.000Z',
} satisfies Kanal;

export const KANAL_SMTP = {
  id: uuid(22),
  typ: 'smtp',
  bezeichnung: 'Alarm-Mail',
  aktiv: true,
  konfig: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    benutzer: 'alarm@example.com',
    von: 'seatmeter@example.com',
    an: ['team@example.com'],
  },
  geheimnis_gesetzt: false,
  erstellt: '2026-10-01T09:00:00.000Z',
  geaendert: '2026-10-01T09:00:00.000Z',
} satisfies Kanal;

export const KANAELE = { kanaele: [KANAL_WEBHOOK, KANAL_SMTP] } satisfies KanalListe;
export const KANAL_TEST_OK = {
  ok: true,
  meldung: 'Testnachricht zugestellt',
} satisfies KanalTestErgebnis;

// ---------------------------------------------------------------------------------------------
// Projekt-Hinweise

export const REGELN = {
  cache_write_prozent: 60,
  fast_prozent: 20,
  opus_prozent: 80,
  unzugeordnet_prozent: 5,
  mindest_usd: 5,
} satisfies HinweisRegeln;

export const HINWEIS_CACHE = {
  id: uuid(31),
  monat: MONAT,
  projekt_id: PROJEKT_ID,
  projekt_name: 'x-shop',
  typ: 'cache_write',
  text: 'Cache-Schreibkosten machen 72 % des Schattenpreises aus.',
  wert: 72,
  erstellt: '2026-10-15T03:00:00.000Z',
  aktualisiert: '2026-10-15T03:00:00.000Z',
  erledigt: null,
} satisfies Hinweis;

export const HINWEIS_OPUS = {
  id: uuid(32),
  monat: MONAT,
  projekt_id: PROJEKT_ID,
  projekt_name: 'x-shop',
  typ: 'opus_anteil',
  text: 'Opus verursacht 85 % des Schattenpreises.',
  wert: 85,
  erstellt: '2026-10-15T03:00:00.000Z',
  aktualisiert: '2026-10-15T03:00:00.000Z',
  erledigt: '2026-10-16T09:00:00.000Z',
} satisfies Hinweis;

export const HINWEIS_UNZUGEORDNET = {
  id: uuid(33),
  monat: MONAT,
  projekt_id: null,
  projekt_name: null,
  typ: 'unzugeordnet',
  text: 'Sitzungen ohne Git-Remote: 8 % des Schattenpreises.',
  wert: 8,
  erstellt: '2026-10-15T03:00:00.000Z',
  aktualisiert: '2026-10-15T03:00:00.000Z',
  erledigt: null,
} satisfies Hinweis;

export const HINWEISE = {
  monat: MONAT,
  hinweise: [HINWEIS_CACHE, HINWEIS_OPUS, HINWEIS_UNZUGEORDNET],
  regeln: REGELN,
} satisfies HinweisListe;

// ---------------------------------------------------------------------------------------------
// Abgleich

export const LAUF_API = {
  id: uuid(41),
  quelle: 'api',
  von: '2026-10-01',
  bis: '2026-10-14',
  status: 'abweichung',
  ausloeser: 'plan',
  gestartet: '2026-10-15T02:00:00.000Z',
  beendet: '2026-10-15T02:00:20.000Z',
  zeilen: 420,
  fehler: null,
  zusammenfassung: {
    schwelle_prozent: 5,
    personentage_quelle: 60,
    zugeordnet: 55,
    ohne_zuordnung: 5,
    abweichend: 4,
    innerhalb: 51,
    nur_seatmeter: 2,
    tokens_quelle: 120_000_000,
    tokens_seatmeter: 116_000_000,
    abdeckung_prozent: 96.7,
    ueberschreitung_zeilen: 3,
    ueberschreitung_usd_micros: 42_500_000,
    tage: [
      {
        tag: '2026-10-01',
        tokens_quelle: 8_000_000,
        tokens_seatmeter: 7_600_000,
        abweichung_prozent: -5,
      },
      {
        tag: '2026-10-02',
        tokens_quelle: 9_000_000,
        tokens_seatmeter: 9_000_000,
        abweichung_prozent: 0,
      },
    ],
  },
} satisfies AbgleichLauf;

export const LAUF_CSV = {
  id: uuid(42),
  quelle: 'csv',
  von: '2026-09-01',
  bis: '2026-09-30',
  status: 'ok',
  ausloeser: 'einmal',
  gestartet: '2026-10-02T10:00:00.000Z',
  beendet: '2026-10-02T10:00:05.000Z',
  zeilen: 118,
  fehler: null,
  zusammenfassung: {
    schwelle_prozent: 5,
    personentage_quelle: 100,
    zugeordnet: 100,
    ohne_zuordnung: 0,
    abweichend: 0,
    innerhalb: 100,
    nur_seatmeter: 0,
    tokens_quelle: 90_000_000,
    tokens_seatmeter: 90_000_000,
    abdeckung_prozent: 100,
    ueberschreitung_zeilen: 0,
    ueberschreitung_usd_micros: 0,
    tage: [],
  },
} satisfies AbgleichLauf;

export const LAUF_FEHLER = {
  id: uuid(43),
  quelle: 'api',
  von: '2026-09-01',
  bis: '2026-09-07',
  status: 'fehler',
  ausloeser: 'api',
  gestartet: '2026-09-08T02:00:00.000Z',
  beendet: '2026-09-08T02:00:01.000Z',
  zeilen: 0,
  fehler: 'Analytics-API antwortete mit Status 401',
  zusammenfassung: null,
} satisfies AbgleichLauf;

export const ABGLEICH_LAEUFE = {
  laeufe: [LAUF_API, LAUF_CSV, LAUF_FEHLER],
} satisfies AbgleichLaeufe;

export const ABGLEICH_STATUS = {
  plan: 'enterprise',
  key_gesetzt: true,
  key_geaendert: '2026-10-10T09:00:00.000Z',
  letzter_lauf: LAUF_API,
} satisfies AbgleichStatus;

export const ABGLEICH_STATUS_TEAM = {
  plan: 'team',
  key_gesetzt: false,
  key_geaendert: null,
  letzter_lauf: null,
} satisfies AbgleichStatus;

/** Erkannte Zuordnung ohne Modell-Spalte: der Test korrigiert sie. */
export const CSV_VORSCHAU = {
  trennzeichen: ';',
  spalten: ['E-Mail', 'Datum', 'Modell', 'Betrag (USD)', 'Tokens Eingabe'],
  zuordnung: {
    email: 'E-Mail',
    tag: 'Datum',
    modell: null,
    amount: 'Betrag (USD)',
    list_amount: null,
    input: 'Tokens Eingabe',
    output: null,
    cache_read: null,
    cache_write: null,
  },
  betrag_einheit: 'usd',
  zeilen: 120,
  gueltig: 118,
  zugeordnet: 100,
  ohne_zuordnung: 18,
  tage: { von: '2026-10-01', bis: '2026-10-14' },
  summe_usd: 345.67,
  beispiel: [
    {
      'E-Mail': 'a***@example.com',
      Datum: '2026-10-01',
      Modell: 'claude-sonnet-5-5',
      'Betrag (USD)': '1.23',
    },
  ],
  fehler: ['Zeile 17: ungültiges Datum'],
} satisfies CsvVorschau;

export const CSV_TEXT =
  'E-Mail;Datum;Modell;Betrag (USD);Tokens Eingabe\na@example.com;2026-10-01;claude-sonnet-5-5;1.23;1000\n';
