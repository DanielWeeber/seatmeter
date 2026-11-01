// Dashboard-API `/api/v1` (Architektur §2.3, §2.4): Eingabe-Schemas und Antworttypen, die Server und
// Web teilen. Beträge in Mikro-USD (ganzzahlig), Tage als `YYYY-MM-DD` in der Mandanten-Zeitzone.
import { z } from 'zod';
import { preisZeileSchema } from './preise/typen.js';

/**
 * Rollen laut Architektur §6 (Tabelle `rolle`). Plattform-Admin gehört zu ee. `entwickler` darf nur die
 * Projektwahl (Modul projektkatalog) und sieht keine Auswertung.
 */
export const ROLLEN = [
  'mandanten_admin',
  'projektleiter',
  'controller',
  'betriebsrat',
  'entwickler',
] as const;
export const rolleSchema = z.enum(ROLLEN);
export type Rolle = z.infer<typeof rolleSchema>;

/** Hat das Konto im Mandanten ausschließlich die Rolle `entwickler` (keine Auswertungen)? */
export function nurEntwickler(rollen: readonly Rolle[]): boolean {
  return rollen.length > 0 && rollen.every((r) => r === 'entwickler');
}

/**
 * Sitztypen (Tabellen `person_sitz`, `sitzkosten`). `max5` = Claude Max 5x, `max20` = Claude Max 20x
 * (Entscheidung Daniel 2026-10-22; ersetzen den früheren Platzhalter `max`, Migration 0017).
 */
export const SITZ_TYPEN = ['standard', 'premium', 'enterprise', 'max5', 'max20'] as const;
export const sitzTypSchema = z.enum(SITZ_TYPEN);
export type SitzTyp = z.infer<typeof sitzTypSchema>;
export const ABRECHNUNGEN = ['monatlich', 'jaehrlich'] as const;

/** Deutsche Anzeigenamen der Sitztypen (Dashboard, Doku). */
export const SITZ_TYP_NAMEN: Record<SitzTyp, string> = {
  standard: 'Standard',
  premium: 'Premium',
  enterprise: 'Enterprise',
  max5: 'Max 5x',
  max20: 'Max 20x',
};

/**
 * Standard-Sitzkosten jedes Mandanten (legt die Datenbank beim Anlegen eines Mandanten an, Trigger
 * aus Migration 0017; vorhandene Zeilen eines Typs bleiben unberührt). Listenpreise Claude Max,
 * monatlich, gültig ab 2025-01-01; abweichende Preise trägt der Admin als neue Zeile ein.
 */
export const SITZ_STANDARDKOSTEN = [
  {
    sitz_typ: 'max5',
    gueltig_ab: '2025-01-01',
    preis_monat: 100,
    waehrung: 'USD',
    abrechnung: 'monatlich',
  },
  {
    sitz_typ: 'max20',
    gueltig_ab: '2025-01-01',
    preis_monat: 200,
    waehrung: 'USD',
    abrechnung: 'monatlich',
  },
] as const satisfies readonly {
  sitz_typ: SitzTyp;
  gueltig_ab: string;
  preis_monat: number;
  waehrung: string;
  abrechnung: (typeof ABRECHNUNGEN)[number];
}[];

/** Monat als `JJJJ-MM`. */
export const monatSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Monat als JJJJ-MM');
export const monatAbfrageSchema = z.object({ monat: monatSchema.optional() });

export const zeitraumAbfrageSchema = z.object({
  von: z.iso.date().optional(),
  bis: z.iso.date().optional(),
});

const benutzername = z.string().trim().min(3).max(200);

/** Eingabe-Aliasse des Web-Clients: `login` = `benutzername`, `token` = `setup_token`. */
export function anmeldeAliasse(koerper: unknown): unknown {
  if (typeof koerper !== 'object' || koerper === null || Array.isArray(koerper)) return koerper;
  const { login, token, ...rest } = koerper as Record<string, unknown>;
  return {
    ...rest,
    ...(login !== undefined && rest.benutzername === undefined ? { benutzername: login } : {}),
    ...(token !== undefined && rest.setup_token === undefined ? { setup_token: token } : {}),
  };
}

/** Ersteinrichtung: nur solange kein Benutzer existiert, mit Einrichtungs-Token aus dem Server-Log. */
export const einrichtungSchema = z.strictObject({
  setup_token: z.string().min(16).max(200),
  benutzername,
  passwort: z.string().min(12).max(1024),
  /** Legt den (einzigen) Mandanten an, falls noch keiner existiert. */
  mandant: z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'slug: a-z, 0-9, Bindestrich'),
    })
    .optional(),
});
export type Einrichtung = z.infer<typeof einrichtungSchema>;

export const anmeldungSchema = z.strictObject({
  benutzername,
  passwort: z.string().min(1).max(1024),
});

export const mandantWahlSchema = z.strictObject({ mandant_id: z.uuid() });

/** Mandanten-eigene Preiszeile (globale Zeilen kommen nur aus dem Seed). */
export const preisEingabeSchema = preisZeileSchema.omit({ mandant_id: true });
export type PreisEingabe = z.input<typeof preisEingabeSchema>;

export const sitzkostenEingabeSchema = z.strictObject({
  sitz_typ: sitzTypSchema,
  gueltig_ab: z.iso.date(),
  preis_monat: z.number().nonnegative().max(1_000_000),
  waehrung: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  abrechnung: z.enum(ABRECHNUNGEN).default('jaehrlich'),
});
export type SitzkostenEingabe = z.input<typeof sitzkostenEingabeSchema>;

export const personSitzEingabeSchema = z.strictObject({
  sitz_typ: sitzTypSchema,
  gueltig_ab: z.iso.date(),
  gueltig_bis: z.iso.date().nullable().default(null),
});

export const auditAbfrageSchema = z.object({
  von: z.iso.date().optional(),
  bis: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Blättern: nur Einträge mit kleinerer ID. */
  vor_id: z.coerce.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------------------------
// Antworttypen

export const tokenSummenSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
  /** Anteil 1h an `cache_write` (nur, wo Quelle B die Aufteilung kennt). */
  cache_write_1h: z.number(),
  web_search: z.number(),
  /** input + output + cache_read + cache_write */
  gesamt: z.number(),
});
export type TokenSummen = z.infer<typeof tokenSummenSchema>;

export const kennzahlenSchema = z.object({
  tokens: tokenSummenSchema,
  anfragen: z.number(),
  schatten_usd_micros: z.number(),
});
export type Kennzahlen = z.infer<typeof kennzahlenSchema>;

export interface ModellZeile extends Kennzahlen {
  model: string;
}

export interface TagZeile extends Kennzahlen {
  tag: string;
}

export interface AuthMe {
  /** `login` = Anmeldename (gleich `benutzername`, für den Web-Client). */
  benutzer: { id: string; benutzername: string; login: string };
  /** Aktiver Mandant der Sitzung oder `null`, wenn der Benutzer keine Rolle hat. */
  mandant_id: string | null;
  mandant: { id: string; name: string; slug: string } | null;
  /** Anmeldeweg: `lokal`, `remote_user` (Header-Modus) oder der Name eines Plugin-Providers. */
  provider: string;
  rollen: Rolle[];
  mandanten: { id: string; name: string; slug: string; rollen: Rolle[] }[];
  /** Wert für den Header `X-Seatmeter-CSRF` (steht auch im Cookie `seatmeter_csrf`). */
  csrf: string | null;
  /** Nur mit ee-Plugin: Lizenzstatus für Navigation und Warnhinweis (Architektur §8). */
  ee?: EeStatus;
  /** Nur mit ee-Plugin: Plattform-Admin (darf Mandanten anlegen, sieht alle Mandanten). */
  plattform_admin?: boolean;
}

/** Lizenzstatus der ee-Erweiterung, wie ihn `/api/v1/auth/me` meldet. */
export interface EeStatus {
  /** ee-Funktionen freigeschaltet (gültige Lizenz oder Kulanzzeit nach Ablauf). */
  aktiv: boolean;
  /** Freigeschaltete Module, z. B. `mandanten`, `oidc`, `budgets`, `abgleich`. */
  module: string[];
  /** Letzter Gültigkeitstag (`YYYY-MM-DD`) oder `null` ohne Lizenz. */
  gueltig_bis: string | null;
  /** Deutscher Warnhinweis (Kulanzzeit, baldiger Ablauf, ungültige Lizenz) oder `null`. */
  warnung: string | null;
}

/** Anmeldewege für die Anmeldeseite (`GET /api/v1/auth/anbieter`). */
export interface AuthAnbieter {
  anbieter: {
    /** `lokal` oder Name eines Plugin-Providers (z. B. `oidc`). */
    name: string;
    /** Deutscher Knopftext, z. B. „Mit weeberwrk SSO anmelden“. */
    titel: string;
    /** Start-URL der Anmeldung (Weiterleitung) oder `null` für das Formular. */
    start: string | null;
  }[];
  /**
   * Nur bei `?email=` bzw. `?mandant=` (SSO je Mandant): Anmeldedienst des Mandanten, wenn die
   * Domain der Adresse verifiziert ist bzw. der Mandant (Kürzel) eine aktive OIDC-Konfiguration hat,
   * sonst `null`. Verrät nie, ob ein Konto existiert (nur Domain → Mandant).
   */
  oidc?: { bezeichnung: string; start_url: string } | null;
}

export interface Uebersicht extends Kennzahlen {
  monat: string;
  nach_modell: ModellZeile[];
  abdeckung: AbdeckungQuellen;
  gefiltert: { api: number; fremd_org: number; inhalt_verworfen: number };
}

export interface AbdeckungQuellen {
  /** Einzelanfragen im Monat (nur solange `anfrage` noch vorliegt, Standard 90 Tage). */
  anfragen: number;
  nur_a: number;
  nur_b: number;
  beide: number;
  /** Anteil der Anfragen mit Quelle A bzw. B in Prozent (eine Nachkommastelle), `null` ohne Daten. */
  a_prozent: number | null;
  b_prozent: number | null;
}

/**
 * Hinweis statt Personenwerten (Auswertungsstufe, Mindestgruppe k = 3, Rolle). Linie für fehlende
 * Personensicht: Ist die ganze Ressource personenbezogen (`/api/v1/personen`), antwortet der Server
 * mit 403 `{ code: 'rolle_fehlt' }`; eingebettete Personenfelder einer erlaubten Ressource
 * (`/api/v1/projekte/:id`) kommen als `personen: null` mit `personen_hinweis`.
 */
export const personenHinweisSchema = z.enum([
  'Auswertungsstufe 0',
  'zu wenige Personen',
  'Rolle ohne Personensicht',
]);
export type PersonenHinweis = z.infer<typeof personenHinweisSchema>;

export const projektZeileSchema = kennzahlenSchema.extend({
  /** `null` = Topf „unzugeordnet“. */
  id: z.string().nullable(),
  name: z.string(),
  kunde: z.string().nullable(),
  url_norm: z.string().nullable(),
  personen: z.number().nullable(),
  personen_hinweis: personenHinweisSchema.nullable(),
});
export type ProjektZeile = z.infer<typeof projektZeileSchema>;

/** `GET /api/v1/projekte?monat=` */
export const projekteAntwortSchema = z.object({
  monat: monatSchema,
  auswertungsstufe: z.number(),
  projekte: z.array(projektZeileSchema),
});
export type ProjekteAntwort = z.infer<typeof projekteAntwortSchema>;

export interface PersonZeile extends Kennzahlen {
  id: string;
  pseudonym: string;
  /** Nur bei `klarnamen_aktiv` und vorhandenem `person_klar`. */
  klarname: { email: string | null; name: string | null } | null;
  /** Nur ab Auswertungsstufe 2. */
  nach_tag?: TagZeile[];
}

export interface ProjektDetail extends Kennzahlen {
  monat: string;
  projekt: Omit<ProjektZeile, keyof Kennzahlen>;
  nach_modell: ModellZeile[];
  nach_tag: TagZeile[];
  auswertungsstufe: number;
  personen: PersonZeile[] | null;
  personen_hinweis: PersonenHinweis | null;
}

export interface PersonenAntwort {
  monat: string;
  auswertungsstufe: number;
  klarnamen_aktiv: boolean;
  personen: PersonZeile[] | null;
  personen_hinweis: PersonenHinweis | null;
}

export interface Datenqualitaet {
  monat: string;
  abdeckung: AbdeckungQuellen & { heuristisch: number; abweichung_ab: number };
  unzugeordnet: {
    tokens: number;
    anfragen: number;
    /** Anteil an allen Tokens in Prozent, `null` ohne Daten. */
    tokens_prozent: number | null;
  };
  /** Modelle ohne passende Preiszeile (Schattenpreis 0). */
  modelle_ohne_preis: string[];
  ingest: {
    quelle: 'a' | 'b' | 'c';
    angenommen: number;
    verworfen_inhalt: number;
    verworfen_api: number;
    verworfen_fremd_org: number;
    unzugeordnet: number;
  }[];
  /** OTel-Kontrollsummen gegen gezählte Anfragen je Sitzung (Architektur §3.4 Punkt 4). */
  kontrollsumme: {
    sitzungen: number;
    /** Sitzungen mit mehr als 1 % Abweichung. */
    sitzungen_abweichend: number;
    tokens_kontrolle: number;
    tokens_gezaehlt: number;
    prozent: number | null;
  };
}

/** Zeile von `GET /api/v1/preise`: Preiszeile plus Verwaltungsfelder. */
export const preisDtoSchema = z.object({
  ...preisEingabeSchema.shape,
  id: z.string(),
  mandant_id: z.string().nullable(),
  herkunft: z.enum(['global', 'mandant']),
  /** `false`: globale Zeile, deren Präfix der Mandant mit eigenen Zeilen überschreibt. */
  aktiv: z.boolean(),
});
export type PreisDto = z.infer<typeof preisDtoSchema>;

/** `GET /api/v1/preise` */
export const preiseAntwortSchema = z.object({ zeilen: z.array(preisDtoSchema) });
export type PreiseAntwort = z.infer<typeof preiseAntwortSchema>;

/** Zeile von `GET /api/v1/sitzkosten` (Spalten der Tabelle `sitzkosten`, wie die Eingabe). */
export const sitzkostenZeileSchema = z.object({
  sitz_typ: sitzTypSchema,
  gueltig_ab: z.iso.date(),
  preis_monat: z.number(),
  waehrung: z.string(),
  abrechnung: z.enum(ABRECHNUNGEN),
});
export type SitzkostenZeile = z.infer<typeof sitzkostenZeileSchema>;

/** `GET /api/v1/sitzkosten` */
export const sitzkostenAntwortSchema = z.object({ zeilen: z.array(sitzkostenZeileSchema) });
export type SitzkostenAntwort = z.infer<typeof sitzkostenAntwortSchema>;

/** Zeile von `GET /api/v1/rechner` (Modul enrollment); Zeitpunkte als ISO-Text. */
export const rechnerZeileSchema = z.object({
  id: z.string(),
  bezeichnung: z.string().nullable(),
  os: z.string().nullable(),
  agent_version: z.string().nullable(),
  registriert: z.string(),
  zuletzt_gesehen: z.string().nullable(),
  /** Zeitpunkt des Widerrufs oder `null` = aktiv. */
  widerrufen: z.string().nullable(),
  person_id: z.string().nullable(),
  person_pseudonym: z.string().nullable(),
});
export type RechnerZeile = z.infer<typeof rechnerZeileSchema>;

/** `GET /api/v1/rechner` */
export const rechnerListeSchema = z.object({ rechner: z.array(rechnerZeileSchema) });
export type RechnerListe = z.infer<typeof rechnerListeSchema>;

export interface AuditEintrag {
  id: number;
  ts: string;
  benutzer_id: string | null;
  benutzername: string | null;
  aktion: string;
  objekt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Phase 3: Kalkulation, Monatsabschluss, Kurs, Mandanten-Einstellungen und Berichte
// (Architektur §5, §7). Antworten als zod-Schemas, damit das Dashboard sie direkt prüfen kann.
// Beträge: `*_usd_micros` in Mikro-USD, `*_cent` in Cent; Kurs `usd_eur` = EUR je 1 USD.

export const SITZKOSTEN_VERTEILUNGEN = ['person', 'gleich', 'pool'] as const;
export const sitzkostenVerteilungSchema = z.enum(SITZKOSTEN_VERTEILUNGEN, {
  error: 'Verteilung: person, gleich oder pool',
});
export type SitzkostenVerteilung = z.infer<typeof sitzkostenVerteilungSchema>;

export const WAEHRUNGEN = ['EUR', 'USD'] as const;
export const CACHE_WRITE_ANNAHMEN = ['5m', '1h'] as const;

/** Gültiger IANA-Zeitzonenname (z. B. `Europe/Berlin`). */
export function istZeitzone(wert: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: wert });
    return true;
  } catch {
    return false;
  }
}

const ratenlimit = z
  .int({ error: 'Ratenlimit als ganze Zahl (Anfragen pro Minute) oder leer für den Standard' })
  .min(10, 'Ratenlimit mindestens 10 Anfragen pro Minute')
  .max(1_000_000, 'Ratenlimit höchstens 1.000.000 Anfragen pro Minute')
  .nullable();

/** Einstellungen des Mandanten (Tabelle `mandant`), lesbar für alle, änderbar nur vom Admin. */
export const mandantEinstellungenSchema = z.strictObject({
  zeitzone: z
    .string({ error: 'Zeitzone fehlt' })
    .trim()
    .min(1, 'Zeitzone fehlt')
    .max(64, 'Zeitzone zu lang')
    .refine(istZeitzone, 'Unbekannte Zeitzone (IANA-Name, z. B. Europe/Berlin)'),
  waehrung: z.enum(WAEHRUNGEN, { error: 'Währung: EUR oder USD' }),
  sitzkosten_verteilung: sitzkostenVerteilungSchema,
  code_anteil_sitz: z
    .number({ error: 'Code-Anteil als Zahl zwischen 0 und 1' })
    .min(0, 'Code-Anteil mindestens 0')
    .max(1, 'Code-Anteil höchstens 1'),
  schatten_faktor: z
    .number({ error: 'Schattenfaktor als Zahl' })
    .min(0, 'Schattenfaktor mindestens 0')
    .max(10, 'Schattenfaktor höchstens 10'),
  cache_write_annahme: z.enum(CACHE_WRITE_ANNAHMEN, { error: 'Cache-Annahme: 5m oder 1h' }),
  auswertungsstufe: z
    .int({ error: 'Auswertungsstufe 0 bis 3' })
    .min(0, 'Auswertungsstufe 0 bis 3')
    .max(3, 'Auswertungsstufe 0 bis 3'),
  klarnamen_aktiv: z.boolean({ error: 'Klarnamen: ja oder nein' }),
  /**
   * Ratenlimit des Ingest je Token auf `/otlp/v1/*` bzw. je Rechner auf `/api/ingest/v1/*` und
   * `/api/agent/v1/*` in Anfragen pro Minute; `null` = Standard des Servers (`SEATMETER_RATE_OTLP`,
   * `SEATMETER_RATE_AGENT`). Optional, damit Formulare ohne diese Felder gültig bleiben.
   */
  ratenlimit_otlp: ratenlimit.optional(),
  ratenlimit_agent: ratenlimit.optional(),
});
export type MandantEinstellungen = z.infer<typeof mandantEinstellungenSchema>;

/** `PUT /api/v1/mandant/einstellungen`: nur die geänderten Felder, mindestens eines. */
export const mandantEinstellungenEingabeSchema = mandantEinstellungenSchema
  .partial()
  .refine((w) => Object.keys(w).length > 0, 'Keine Änderung angegeben');
export type MandantEinstellungenEingabe = z.input<typeof mandantEinstellungenEingabeSchema>;

export const KURS_QUELLEN = ['ezb', 'manuell'] as const;

/** Kurs eines Monats (Tabelle `kurs`): EZB-Monatsmittel oder vom Admin gesetzt. */
export const kursSchema = z.object({
  monat: monatSchema,
  /** EUR je 1 USD; `null` = für den Monat liegt kein Kurs vor. */
  usd_eur: z.number().nullable(),
  quelle: z.enum(KURS_QUELLEN).nullable(),
  /** EZB: Mittel der bisherigen Tageskurse (laufender Monat bzw. Monatsmittel noch nicht veröffentlicht). */
  vorlaeufig: z.boolean(),
  /** Zeitpunkt der letzten Änderung (ISO), `null` ohne Kurs. */
  aktualisiert: z.string().nullable(),
});
export type Kurs = z.infer<typeof kursSchema>;
export const kurseAntwortSchema = z.object({ zeilen: z.array(kursSchema) });
export type KurseAntwort = z.infer<typeof kurseAntwortSchema>;

/** `PUT /api/v1/kurs?monat=`: manueller Kurs (geht dem EZB-Wert vor). */
export const kursEingabeSchema = z.strictObject({
  usd_eur: z
    .number({ error: 'Kurs als Zahl (EUR je USD)' })
    .positive('Kurs muss größer als 0 sein')
    .max(10, 'Kurs höchstens 10'),
});
export type KursEingabe = z.infer<typeof kursEingabeSchema>;

export const TOEPFE = ['projekt', 'unzugeordnet', 'ungenutzt'] as const;
export const topfSchema = z.enum(TOEPFE);
export type Topf = z.infer<typeof topfSchema>;

/** Eine Zeile der Kalkulation: Projekt, Topf „unzugeordnet“ oder Topf „ungenutzt“ (Sitze ohne Nutzung). */
export const projektpreisZeileSchema = z.object({
  topf: topfSchema,
  /** Nur bei `topf = projekt`. */
  projekt_id: z.string().nullable(),
  name: z.string(),
  kunde: z.string().nullable(),
  tokens: tokenSummenSchema,
  anfragen: z.number(),
  /** Schattenpreis nach Abzug der Überschreitung, vor `schatten_faktor`. */
  schatten_usd_micros: z.number(),
  sitzanteil_usd_micros: z.number(),
  /** Zeile „Überschreitung (bezahlt)“; 0, wenn nicht abgezogen. */
  ueberschreitung_usd_micros: z.number(),
  /** `schatten_faktor · Schatten + Sitzanteil + Überschreitung`. */
  projektpreis_usd_micros: z.number(),
  /** Auf US-Cent gerundet, Grundlage der EUR-Umrechnung. */
  projektpreis_usd_cent: z.number(),
  /** `round(usd_cent · kurs)`; `null` ohne Kurs. */
  projektpreis_eur_cent: z.number().nullable(),
  /** Preisversionen des Monats (`global|mandant:<präfix>@<gueltig_ab>`, kommagetrennt). */
  preis_version: z.string(),
});
export type ProjektpreisZeile = z.infer<typeof projektpreisZeileSchema>;

export const kalkulationEinstellungenSchema = z.object({
  sitzkosten_verteilung: sitzkostenVerteilungSchema,
  code_anteil_sitz: z.number(),
  schatten_faktor: z.number(),
  cache_write_annahme: z.enum(CACHE_WRITE_ANNAHMEN),
});
export type KalkulationEinstellungen = z.infer<typeof kalkulationEinstellungenSchema>;

export const kalkulationSummenSchema = z.object({
  schatten_usd_micros: z.number(),
  sitzanteil_usd_micros: z.number(),
  ueberschreitung_usd_micros: z.number(),
  projektpreis_usd_micros: z.number(),
  projektpreis_usd_cent: z.number(),
  projektpreis_eur_cent: z.number().nullable(),
});
export type KalkulationSummen = z.infer<typeof kalkulationSummenSchema>;

/** `GET /api/v1/kalkulation?monat=` (live) bzw. Inhalt eines Monatsabschlusses. */
export const kalkulationAntwortSchema = z.object({
  monat: monatSchema,
  quelle: z.enum(['live', 'monatsabschluss']),
  /** Zeitpunkt des Einfrierens; `null` bei `live`. */
  eingefroren_am: z.string().nullable(),
  /** Für den Monat gibt es einen Monatsabschluss (bei `live` können die Werte davon abweichen). */
  abgeschlossen: z.boolean(),
  einstellungen: kalkulationEinstellungenSchema,
  kurs: kursSchema,
  /** `false` = keine Überschreitungsdaten (Quelle C), Hinweis „Überschreitung nicht abgezogen“. */
  ueberschreitung_abgezogen: z.boolean(),
  /** Σ Sitzkosten K_p des Monats (nach `code_anteil_sitz`); `null` im Monatsabschluss. */
  sitzkosten_usd_micros: z.number().nullable(),
  zeilen: z.array(projektpreisZeileSchema),
  /** Summe der sichtbaren Zeilen (Projektleiter: nur eigene Projekte). */
  summe: kalkulationSummenSchema,
  /** Deutsche Hinweise, z. B. „Kein Kurs für den Monat“. */
  hinweise: z.array(z.string()),
});
export type KalkulationAntwort = z.infer<typeof kalkulationAntwortSchema>;

/** `GET /api/v1/monatsabschluss?monat=`: eingefrorene Werte, falls vorhanden. */
export const monatsabschlussSchema = z.object({
  monat: monatSchema,
  abgeschlossen: z.boolean(),
  abschluss: kalkulationAntwortSchema.nullable(),
});
export type Monatsabschluss = z.infer<typeof monatsabschlussSchema>;

/** `GET /api/v1/berichte/projektabrechnung?monat=&format=json` (CSV hat dieselben Spalten). */
export const projektabrechnungSchema = z.object({
  monat: monatSchema,
  /** `abgeschlossen` = Werte aus dem Monatsabschluss, sonst live berechnet. */
  stand: z.enum(['abgeschlossen', 'vorlaeufig']),
  erstellt: z.string(),
  kurs: kursSchema,
  einstellungen: kalkulationEinstellungenSchema,
  ueberschreitung_abgezogen: z.boolean(),
  zeilen: z.array(projektpreisZeileSchema),
  summe: kalkulationSummenSchema,
});
export type Projektabrechnung = z.infer<typeof projektabrechnungSchema>;

/** `GET /api/v1/berichte/betriebsrat?monat=&format=json|html|csv` (Architektur §7), nur Zähler. */
export const betriebsratBerichtSchema = z.object({
  monat: monatSchema,
  zeitraum: z.object({ von: z.iso.date(), bis: z.iso.date() }),
  erstellt: z.string(),
  zweck: z.string(),
  konfiguration: z.object({
    auswertungsstufe: z.number(),
    auswertungsstufe_text: z.string(),
    klarnamen_aktiv: z.boolean(),
    mindestgruppe: z.number(),
    aufbewahrung: z.object({
      anfrage_tage: z.number(),
      aggregat_monate: z.number(),
      abschluss_monate: z.number(),
      kontrollsumme_tage: z.number(),
      statistik_monate: z.number(),
      audit_monate: z.number(),
    }),
    /** Quellen mit Annahmen im Zeitraum. */
    quellen: z.object({ a: z.boolean(), b: z.boolean(), c: z.boolean() }),
    /** Konfigurationsänderungen im Zeitraum (aus `audit`, ohne Benutzernamen). */
    aenderungen: z.array(
      z.object({ ts: z.string(), aktion: z.string(), objekt: z.string().nullable() }),
    ),
  }),
  datenkategorien: z.object({ erfasst: z.array(z.string()), nicht_erfasst: z.array(z.string()) }),
  zugriffe: z.object({
    /** Dashboard-Konten je Rolle (nur Anzahl). */
    konten: z.array(z.object({ rolle: rolleSchema, anzahl: z.number() })),
    personensichten: z.number(),
    /** Downloads (Audit „Export …“, z. B. CSV). */
    exporte: z.number(),
    /** Berichte im Dashboard oder Browser geöffnet (Audit „Ansicht …“), kein Download. */
    ansichten: z.number(),
    /** Audit-Zusammenfassung je Aktion im Zeitraum. */
    protokoll: z.array(z.object({ aktion: z.string(), anzahl: z.number() })),
  }),
  mengen: z.object({
    /** Gezählte Personen (Pseudonyme mit Nutzung im Zeitraum), nur als Anzahl. */
    personen: z.number(),
    rechner: z.number(),
    projekte: z.number(),
    anfragen: z.number(),
    tokens: z.number(),
  }),
  datenschutz: z.object({
    angenommen: z.number(),
    verworfen_inhalt: z.number(),
    verworfen_api: z.number(),
    verworfen_fremd_org: z.number(),
    unzugeordnet: z.number(),
    loeschlaeufe: z.array(
      z.object({ ts: z.string(), tabelle: z.string(), bis: z.iso.date(), anzahl: z.number() }),
    ),
  }),
  version: z.object({ seatmeter: z.string(), agenten: z.array(z.string()) }),
  hinweis: z.string(),
});
export type BetriebsratBericht = z.infer<typeof betriebsratBerichtSchema>;
