// Kysely-Typen zum Grundschema (Migration 2026_10_22_0001). Bei jeder Migration mitpflegen.
// Typabbildung (siehe db.ts): bigint → number, numeric → string, date → 'YYYY-MM-DD', bytea → Buffer.
import type { ColumnType, Generated } from 'kysely';
import type { AuthKlasse } from '@seatmeter/shared';

type Zeit = ColumnType<Date, Date | string, Date | string>;
type ZeitDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type Tag = ColumnType<string, string, string>;
type Dezimal = ColumnType<string, string | number, string | number>;
type DezimalDefault = ColumnType<string, string | number | undefined, string | number>;
type Zahl = ColumnType<number, number | bigint | undefined, number | bigint>;
type Id = Generated<string>;

/** Sitztypen (Migration 0017: `max5`/`max20` statt `max`); gleiche Liste wie `SITZ_TYPEN` in shared. */
export type SitzTyp = 'standard' | 'premium' | 'enterprise' | 'max5' | 'max20';

export interface MandantTabelle {
  id: Id;
  name: string;
  slug: string;
  plan: Generated<'team' | 'enterprise' | 'max_pilot'>;
  abrechnungsmodell: Generated<'kontingent' | 'nutzungsbasiert'>;
  auswertungsstufe: Generated<number>;
  klarnamen_aktiv: Generated<boolean>;
  zeitzone: Generated<string>;
  waehrung: Generated<string>;
  sitzkosten_verteilung: Generated<'person' | 'gleich' | 'pool'>;
  code_anteil_sitz: DezimalDefault;
  schatten_faktor: DezimalDefault;
  cache_write_annahme: Generated<'5m' | '1h'>;
  aufbewahrung_anfrage_tage: Generated<number>;
  aufbewahrung_aggregat_monate: Generated<number>;
  aufbewahrung_abschluss_monate: Generated<number>;
  aufbewahrung_kontrollsumme_tage: Generated<number>;
  aufbewahrung_statistik_monate: Generated<number>;
  aufbewahrung_audit_monate: Generated<number>;
  erstellt: ZeitDefault;
  /** Migration 0018: Ratenlimit je Token (OTLP) bzw. je Rechner (Agent), Anfragen/Minute; NULL = Standard. */
  ratenlimit_otlp: ColumnType<number | null, number | null | undefined, number | null>;
  ratenlimit_agent: ColumnType<number | null, number | null | undefined, number | null>;
  /** Migration 0019: Kontenkontingent (Konten mit Rolle im Mandanten), `NULL` = unbegrenzt. */
  konten_max: ColumnType<number | null, number | null | undefined, number | null>;
  /** Migration 0020: Positivliste der Projektschlüssel für Issue-Schlüssel (ee); NULL = alle. */
  issue_praefixe: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
}

export interface MandantGeheimnisTabelle {
  mandant_id: string;
  person_salt: Buffer;
  projekt_salt: Buffer;
  analytics_key: Buffer | null;
  erstellt: ZeitDefault;
  /** Migration 0014. */
  analytics_key_geaendert: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export interface AnthropicOrgTabelle {
  mandant_id: string;
  org_uuid: string;
  bezeichnung: string | null;
  plan: string | null;
  gueltig_ab: ColumnType<string, string | undefined, string>;
}

export interface IngestTokenTabelle {
  id: Id;
  mandant_id: string;
  typ: 'mandant' | 'rechner';
  rechner_id: string | null;
  token_sha256: Buffer;
  praefix: string;
  erstellt: ZeitDefault;
  zuletzt_genutzt: Zeit | null;
  widerrufen: Zeit | null;
}

export interface EinmalcodeTabelle {
  code_sha256: Buffer;
  mandant_id: string;
  person_id: string | null;
  erstellt: ZeitDefault;
  laeuft_ab: ZeitDefault;
  genutzt_am: Zeit | null;
  rechner_id: string | null;
  /** Migration 0011: Rechner-Bezeichnung für das Enrollment. */
  bezeichnung: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface RechnerTabelle {
  id: Id;
  mandant_id: string;
  person_id: string | null;
  bezeichnung: string | null;
  os: 'macos' | 'linux' | 'windows' | null;
  agent_version: string | null;
  registriert: ZeitDefault;
  zuletzt_gesehen: Zeit | null;
  widerrufen: Zeit | null;
}

export interface PersonTabelle {
  id: Id;
  mandant_id: string;
  pseudonym: string;
  key_konto: Buffer | null;
  key_email: Buffer | null;
  /** Migration 0014: HMAC(account_id) für den Abgleich (actor.user_id). */
  key_konto_id: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  erste_nutzung: Tag | null;
  letzte_nutzung: Tag | null;
}

export interface PersonKlarTabelle {
  person_id: string;
  mandant_id: string;
  email_enc: Buffer | null;
  name_enc: Buffer | null;
}

export interface PersonSitzTabelle {
  mandant_id: string;
  person_id: string;
  gueltig_ab: Tag;
  sitz_typ: SitzTyp;
  gueltig_bis: Tag | null;
}

export interface SitzkostenTabelle {
  mandant_id: string;
  sitz_typ: SitzTyp;
  gueltig_ab: Tag;
  preis_monat: Dezimal;
  waehrung: Generated<string>;
  abrechnung: Generated<'monatlich' | 'jaehrlich'>;
}

export interface ProjektTabelle {
  id: Id;
  mandant_id: string;
  projekt_key: Buffer;
  url_norm: string | null;
  repo_name: string | null;
  owner: string | null;
  /** `pfad` = Pfad-Projekt des Agenten (ohne `url_norm`, Bezeichnung in `anzeigename`). */
  provider: 'github' | 'gitlab' | 'gitea' | 'unknown' | 'pfad' | null;
  anzeigename: string | null;
  kunde: string | null;
  erstellt: ZeitDefault;
}

export interface ProjektAliasTabelle {
  mandant_id: string;
  projekt_key: Buffer;
  projekt_id: string;
}

export interface SitzungTabelle {
  mandant_id: string;
  session_id: string;
  person_id: string | null;
  rechner_id: string | null;
  projekt_id: string | null;
  org_uuid: string | null;
  auth_klasse: Generated<AuthKlasse>;
  quellen: Generated<number>;
  cc_version: string | null;
  start: Zeit | null;
  ende: Zeit | null;
}

export interface AnfrageTabelle {
  mandant_id: string;
  anfrage_key: string;
  ts: Zeit;
  tag: Tag;
  session_id: string | null;
  person_id: string | null;
  projekt_id: string | null;
  model: string;
  speed: string | null;
  inference_geo: string | null;
  service_tier: string | null;
  query_source: string | null;
  ist_subagent: boolean | null;
  input: Zahl;
  output: Zahl;
  cache_read: Zahl;
  cache_write: Zahl;
  cache_write_1h: ColumnType<
    number | null,
    number | bigint | null | undefined,
    number | bigint | null
  >;
  web_search: Generated<number>;
  quellen: Generated<number>;
  auth_klasse: Generated<AuthKlasse>;
  zaehlt_als_abo: Generated<boolean>;
  cc_kosten_usd_micros: ColumnType<
    number | null,
    number | bigint | null | undefined,
    number | bigint | null
  >;
  abweichung_ab: Generated<boolean>;
  heuristisch: Generated<boolean>;
  /** Migration 0020: Issue-Schlüssel (nie der Branch-Name); NULL = unbekannt, [] = ohne Schlüssel. */
  issue_schluessel: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
}

export interface OtelKontrollsummeTabelle {
  mandant_id: string;
  tag: Tag;
  session_id: string;
  model: string;
  typ: string;
  query_source: Generated<string>;
  wert: Zahl;
}

export interface TagAggregatTabelle {
  mandant_id: string;
  tag: Tag;
  person_id: string | null;
  projekt_id: string | null;
  model: string;
  speed: Generated<string>;
  auth_klasse: AuthKlasse;
  input: Zahl;
  output: Zahl;
  cache_read: Zahl;
  cache_write: Zahl;
  cache_write_1h: Zahl;
  web_search: Generated<number>;
  anfragen: Generated<number>;
  schatten_usd_micros: Zahl;
  preis_version: string | null;
  abo_anteil: DezimalDefault;
}

/** Migration 0020: Monatssummen je Projekt und Issue-Schlüssel (nur Abo-Nutzung). */
export interface IssueAggregatTabelle {
  mandant_id: string;
  /** Erster Tag des Monats. */
  monat: Tag;
  projekt_id: string | null;
  schluessel: string;
  sitzungen: Generated<number>;
  anfragen: Generated<number>;
  input: Zahl;
  output: Zahl;
  cache_read: Zahl;
  cache_write: Zahl;
  cache_write_1h: Zahl;
  web_search: Generated<number>;
  schatten_usd_micros: Zahl;
  aktualisiert: ZeitDefault;
}

export interface MonatsabschlussTabelle {
  mandant_id: string;
  monat: Tag;
  projekt_id: string | null;
  topf: Generated<'projekt' | 'unzugeordnet' | 'ungenutzt'>;
  schatten_usd_micros: Zahl;
  sitzanteil_usd_micros: Zahl;
  ueberschreitung_usd_micros: Zahl;
  projektpreis_usd_micros: Zahl;
  /** Migration 0012: nullbar (kein Kurs zum Abschlusszeitpunkt). */
  projektpreis_eur_cent: ColumnType<number | null, number | bigint | null, number | bigint | null>;
  kurs: ColumnType<string | null, string | number | null, string | number | null>;
  preis_version: string;
  eingefroren_am: ZeitDefault;
  // Migration 2026_10_22_0012 (kalkulation)
  projektpreis_usd_cent: Zahl;
  input: Zahl;
  output: Zahl;
  cache_read: Zahl;
  cache_write: Zahl;
  cache_write_1h: Zahl;
  web_search: Zahl;
  anfragen: Zahl;
  kurs_quelle: 'ezb' | 'manuell' | null;
  kurs_vorlaeufig: Generated<boolean>;
  sitzkosten_verteilung: 'person' | 'gleich' | 'pool' | null;
  code_anteil_sitz: Dezimal | null;
  schatten_faktor: Dezimal | null;
  cache_write_annahme: '5m' | '1h' | null;
  ueberschreitung_abgezogen: Generated<boolean>;
  erzwungen: Generated<boolean>;
}

export interface KursTabelle {
  mandant_id: string;
  monat: Tag;
  usd_eur: Dezimal;
  /** Migration 0012: `mandant` heißt jetzt `manuell`. */
  quelle: Generated<'ezb' | 'manuell'>;
  vorlaeufig: Generated<boolean>;
  aktualisiert: ZeitDefault;
}

export interface PreisTabelle {
  id: Id;
  mandant_id: string | null;
  modell_praefix: string;
  gueltig_ab: Tag;
  input: Dezimal;
  output: Dezimal;
  cache_read: Dezimal;
  cache_write_5m: Dezimal;
  cache_write_1h: Dezimal;
  fast_input: Dezimal | null;
  fast_output: Dezimal | null;
  prompt_schwelle_tokens: number | null;
  lang_input: Dezimal | null;
  lang_output: Dezimal | null;
  lang_cache_read: Dezimal | null;
  lang_cache_write_5m: Dezimal | null;
  lang_cache_write_1h: Dezimal | null;
  geo_us_faktor: DezimalDefault;
  quelle_url: string;
  geprueft_am: Tag;
}

export interface UeberschreitungTabelle {
  mandant_id: string;
  tag: Tag;
  person_id: string;
  model: string;
  amount_usd_micros: Zahl;
  list_amount_usd_micros: ColumnType<
    number | null,
    number | bigint | null | undefined,
    number | bigint | null
  >;
  input: Zahl;
  output: Zahl;
  cache_read: Zahl;
  cache_write: Zahl;
  quelle: 'api' | 'csv';
}

export interface AbgleichLaufTabelle {
  id: Id;
  mandant_id: string;
  zeitraum: string;
  status: Generated<'laeuft' | 'ok' | 'abweichung' | 'fehler'>;
  abweichungen: unknown;
  gestartet: ZeitDefault;
  beendet: Zeit | null;
  quelle: Generated<'api' | 'csv'>;
  ausloeser: Generated<'plan' | 'einmal' | 'api'>;
  zeilen: Generated<number>;
  fehler: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface BudgetTabelle {
  id: Id;
  mandant_id: string;
  /** `null` = mandantenweit (Migration 0014). */
  projekt_id: string | null;
  zeitraum: Generated<'monat'>;
  betrag: Dezimal;
  waehrung: Generated<string>;
  basis: Generated<'projektpreis' | 'tokens'>;
  schwellen: Generated<number[]>;
  erstellt: ZeitDefault;
  bezeichnung: ColumnType<string | null, string | null | undefined, string | null>;
  ausloeser: Generated<'verbrauch' | 'prognose'>;
  aktiv: Generated<boolean>;
  geaendert: ZeitDefault;
}

export type Zustellung = 'offen' | 'zugestellt' | 'fehler' | 'ohne_kanal';

export interface AlarmTabelle {
  id: Id;
  mandant_id: string;
  budget_id: string;
  periode: Tag;
  schwelle: number;
  ausgeloest: ZeitDefault;
  wert: Dezimal;
  quittiert: Zeit | null;
  prozent: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  betrag: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  prognose: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  zustellung: ColumnType<Zustellung, Zustellung | undefined, Zustellung>;
  zustellversuche: Generated<number>;
  zustellfehler: ColumnType<string | null, string | null | undefined, string | null>;
  zugestellt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  quittiert_von: ColumnType<string | null, string | null | undefined, string | null>;
}

type ZeitNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type TextNull = ColumnType<string | null, string | null | undefined, string | null>;

/** Alarmkanal je Mandant (Migration 0022, bis 2026-10-24 ee-Migration 0002); Geheimnis nur verschlüsselt. */
export interface AlarmKanalTabelle {
  id: Id;
  mandant_id: string;
  typ: 'webhook' | 'smtp' | 'weeberwrk-relay';
  bezeichnung: string;
  aktiv: Generated<boolean>;
  konfig: ColumnType<unknown, string | undefined, string>;
  geheimnis: ColumnType<Buffer | null, Buffer | null | undefined, Buffer | null>;
  erstellt: ZeitDefault;
  geaendert: ZeitDefault;
}

/** Projekt-Hinweis je Monat (Migration 0022); `projekt_id` `null` = mandantenweit. */
export interface HinweisTabelle {
  id: Id;
  mandant_id: string;
  monat: Tag;
  projekt_id: string | null;
  typ: string;
  text: string;
  wert: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  erstellt: ZeitDefault;
  aktualisiert: ZeitDefault;
  erledigt: ZeitNull;
  erledigt_von: TextNull;
}

/**
 * Hinweis-Schwellen je Mandant (Migration 0022). Der Tabellenname stammt aus der Zeit als ee-Modul und
 * bleibt, damit vorhandene Installationen nichts umbenennen müssen.
 */
export interface EeEinstellungTabelle {
  mandant_id: string;
  hinweise: ColumnType<unknown, string | undefined, string>;
  geaendert: ZeitDefault;
}

/** Anmeldedienst je Mandant (Migration 0023). */
export interface MandantOidcTabelle {
  mandant_id: string;
  issuer: string;
  client_id: string;
  /** AES-256-GCM, AAD `mandant_oidc.client_secret`; nie in Antworten. */
  client_secret: Buffer;
  scopes: ColumnType<string, string | undefined, string>;
  bezeichnung: string;
  gruppen_rollen: ColumnType<Record<string, string[]>, string | undefined, string>;
  aktiv: ColumnType<boolean, boolean | undefined, boolean>;
  erstellt: ColumnType<Date, Date | string | undefined, never>;
  geaendert: ColumnType<Date, Date | string | undefined, Date | string>;
  zuletzt_geprueft: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** E-Mail-Domain je Mandant (Migration 0023), serverweit eindeutig. */
export interface MandantDomainTabelle {
  domain: string;
  mandant_id: string;
  verifiziert: ColumnType<boolean, boolean | undefined, boolean>;
  verifizierungs_token: string;
  verifiziert_am: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  quelle: ColumnType<
    'dns' | 'plattform_admin' | null,
    'dns' | 'plattform_admin' | null | undefined,
    'dns' | 'plattform_admin' | null
  >;
  erstellt: ColumnType<Date, Date | string | undefined, never>;
}

/** Einladung eines Kontos ohne Passwort (Migration 0023); Token nur als SHA-256. */
export interface KontoEinladungTabelle {
  mandant_id: string;
  benutzer_id: string;
  token_sha256: Buffer;
  laeuft_ab: ColumnType<Date, Date | string, Date | string>;
  erstellt: ColumnType<Date, Date | string | undefined, Date | string>;
  erstellt_von: string | null;
}

/** SCIM (Migration 0024). */
export interface MandantScimTokenTabelle {
  id: ColumnType<string, string | undefined, never>;
  mandant_id: string;
  token_sha256: Buffer;
  praefix: string;
  bezeichnung: string | null;
  erstellt: ColumnType<Date, Date | string | undefined, never>;
  zuletzt_genutzt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  widerrufen: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface ScimKontoTabelle {
  mandant_id: string;
  benutzer_id: string;
  external_id: string | null;
  aktiv: ColumnType<boolean, boolean | undefined, boolean>;
  erstellt: ColumnType<Date, Date | string | undefined, never>;
  geaendert: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface MandantScimGruppeTabelle {
  id: ColumnType<string, string | undefined, never>;
  mandant_id: string;
  display_name: string;
  external_id: string | null;
  erstellt: ColumnType<Date, Date | string | undefined, never>;
  geaendert: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface MandantScimMitgliedTabelle {
  mandant_id: string;
  gruppe_id: string;
  benutzer_id: string;
}

/** Jira-Verbindung je Mandant (Migration 0025). */
export interface MandantJiraTabelle {
  mandant_id: string;
  basis_url: string;
  art: 'cloud' | 'datacenter';
  benutzer_email: string | null;
  /** AES-256-GCM, AAD `mandant_jira.token`; nie in Antworten oder Logs. */
  token: Buffer;
  aktiv: ColumnType<boolean, boolean | undefined, boolean>;
  nur_zugeordnete: ColumnType<boolean, boolean | undefined, boolean>;
  zuletzt_geprueft: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  fehler: string | null;
  erstellt: ColumnType<Date, Date | string | undefined, never>;
  geaendert: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** Zuordnung seatmeter-Projekt → Jira-Projekt (Migration 0025). */
export interface ProjektJiraTabelle {
  mandant_id: string;
  projekt_id: string;
  jira_projekt_schluessel: string;
  jira_projekt_name: string | null;
  geaendert: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** Einstellungen des Projektkatalogs je Mandant (Migration 0026). */
export interface MandantProjektkatalogTabelle {
  mandant_id: string;
  stufe: Generated<'aus' | 'warnen' | 'blockieren'>;
  kontakt: string | null;
  zuletzt_import: Zeit | null;
  import_quelle: string | null;
  inaktiv_status: ColumnType<string[] | null, string[] | null | undefined, string[] | null>;
  zuletzt_sync: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  zuletzt_push: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  sync_warnung_stunden: ColumnType<number | null, number | null | undefined, number | null>;
  sync_deaktivieren_tage: ColumnType<number | null, number | null | undefined, number | null>;
  sync_deaktivieren_max_prozent: Generated<number>;
  sync_alarm_seit: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  sync_bremse_seit: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  geaendert: ZeitDefault;
}

/** Projekt aus der Quelle des Mandanten (Migration 0026); wird inaktiv, nie gelöscht. */
export interface KatalogProjektTabelle {
  id: Id;
  mandant_id: string;
  /** Schlüssel je Mandant (Migration 0029). */
  externe_id: string;
  /** Nur Anzeige; ohne Wert zeigt das Dashboard die externe ID. */
  nummer: string | null;
  name: string;
  kunde: string | null;
  /** Roh, ohne Fremdschlüssel: Das Elternprojekt darf später ankommen. */
  parent_externe_id: string | null;
  status_roh: string | null;
  aktiv: Generated<boolean>;
  quelle: string;
  zuletzt_gesehen: ZeitDefault;
  erstellt: ZeitDefault;
}

/** Token für geplante Katalog-Importe (Migration 0027); gespeichert nur als SHA-256. */
export interface KatalogImportTokenTabelle {
  id: Id;
  mandant_id: string;
  token_sha256: Buffer;
  praefix: string;
  bezeichnung: string;
  scope: ColumnType<
    'csv_import' | 'katalog_api' | 'sync_status',
    'csv_import' | 'katalog_api' | 'sync_status' | undefined,
    never
  >;
  erstellt: ZeitDefault;
  zuletzt_genutzt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  widerrufen: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

/** Tageszähler der Katalog-API je Token, UTC-Tag (Migration 0029). */
export interface KatalogSyncTagTabelle {
  mandant_id: string;
  tag: Tag;
  token_id: string;
  neu: Zahl;
  aktualisiert: Zahl;
  unveraendert: Zahl;
  abgelehnt: Zahl;
  protokolliert: Generated<boolean>;
}

/** Zuordnung Repo → Katalog-Projekt (Migration 0026). */
export interface ProjektKatalogTabelle {
  mandant_id: string;
  projekt_id: string;
  katalog_projekt_id: string;
  geaendert: ZeitDefault;
}

/** Zuordnung Sitzung ohne Repo → Katalog-Projekt (Migration 0026). */
export interface SitzungKatalogTabelle {
  mandant_id: string;
  session_id: string;
  katalog_projekt_id: string;
  erstellt: ZeitDefault;
}

/** Kosten je Katalog-Projekt und Repo beim Monatsabschluss (Migration 0026); `projekt_id` NULL = ohne Repo. */
export interface KatalogAbschlussTabelle {
  id: Id;
  mandant_id: string;
  monat: Tag;
  /** Schlüssel des Projekts; leer = offen (Migration 0029). */
  externe_id: Generated<string>;
  nummer: string;
  name: string;
  pfad: string | null;
  kunde: string | null;
  projekt_id: string | null;
  projekt_name: string | null;
  sitzungen: Zahl;
  input: Zahl;
  output: Zahl;
  cache_read: Zahl;
  cache_write: Zahl;
  cache_write_1h: Zahl;
  web_search: Zahl;
  anfragen: Zahl;
  schatten_usd_micros: Zahl;
}

/** Titel und Status je Jira-Issue, 24 h gültig (Migration 0025). */
export interface JiraIssueCacheTabelle {
  mandant_id: string;
  schluessel: string;
  titel: string | null;
  status: string | null;
  gefunden: ColumnType<boolean, boolean | undefined, boolean>;
  geholt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface BenutzerTabelle {
  id: Id;
  benutzername: string;
  login: 'lokal' | 'oidc';
  oidc_sub: string | null;
  passwort_hash: string | null;
  erstellt: ZeitDefault;
  deaktiviert: Zeit | null;
  /** Migration 0019: Issuer zum `oidc_sub` (eindeutig ist das Paar); `NULL` = globaler Anbieter (alt). */
  oidc_issuer: ColumnType<string | null, string | null | undefined, string | null>;
  /** Migration 0019: Beginn der letzten Dashboard-Sitzung. */
  zuletzt_angemeldet: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
}

export type RolleQuelle = 'manuell' | 'oidc' | 'scim';

export interface RolleTabelle {
  id: Id;
  mandant_id: string;
  benutzer_id: string;
  rolle: 'mandanten_admin' | 'projektleiter' | 'controller' | 'betriebsrat' | 'entwickler';
  projekt_ids: string[] | null;
  /**
   * Herkunft (Migration 0013, `scim` ab 0021): `manuell`, `oidc` (Gruppen-Zuordnung, beim Login abgeglichen)
   * oder `scim` (SCIM-Gruppen, bei jeder Änderung der Mitgliedschaft abgeglichen).
   */
  quelle: ColumnType<RolleQuelle, RolleQuelle | undefined, RolleQuelle>;
}

export interface AuditTabelle {
  id: Generated<number>;
  mandant_id: string;
  benutzer_id: string | null;
  aktion: string;
  objekt: string | null;
  ts: ZeitDefault;
}

export interface IngestStatistikTabelle {
  mandant_id: string;
  tag: Tag;
  quelle: 'a' | 'b' | 'c';
  angenommen: Zahl;
  verworfen_inhalt: Zahl;
  verworfen_api: Zahl;
  verworfen_fremd_org: Zahl;
  unzugeordnet: Zahl;
  zuletzt: Zeit | null;
}

export interface LoeschlaufTabelle {
  id: Id;
  mandant_id: string;
  tabelle: string;
  bis: Tag;
  anzahl: Zahl;
  ts: ZeitDefault;
}

// Migration 2026_10_22_0010 (auth, jobs)
/** Anmeldeweg einer Dashboard-Sitzung (`oidc` ab Migration 0013, ee). */
export type SitzungQuelle = 'lokal' | 'remote_user' | 'oidc';

export interface BenutzerSitzungTabelle {
  id: Id;
  token_sha256: Buffer;
  benutzer_id: string;
  mandant_id: string | null;
  csrf: string;
  quelle: ColumnType<SitzungQuelle, SitzungQuelle | undefined, SitzungQuelle>;
  erstellt: ZeitDefault;
  laeuft_ab: Zeit;
}

export interface JobLaufTabelle {
  id: Id;
  job: string;
  ausloeser: ColumnType<
    'plan' | 'einmal' | 'api',
    'plan' | 'einmal' | 'api' | undefined,
    'plan' | 'einmal' | 'api'
  >;
  status: ColumnType<
    'laeuft' | 'ok' | 'fehler' | 'uebersprungen',
    'laeuft' | 'ok' | 'fehler' | 'uebersprungen' | undefined,
    'laeuft' | 'ok' | 'fehler' | 'uebersprungen'
  >;
  gestartet: ZeitDefault;
  beendet: Zeit | null;
  ergebnis: unknown;
  fehler: string | null;
}

export interface Datenbank {
  mandant: MandantTabelle;
  mandant_geheimnis: MandantGeheimnisTabelle;
  anthropic_org: AnthropicOrgTabelle;
  ingest_token: IngestTokenTabelle;
  einmalcode: EinmalcodeTabelle;
  rechner: RechnerTabelle;
  person: PersonTabelle;
  person_klar: PersonKlarTabelle;
  person_sitz: PersonSitzTabelle;
  sitzkosten: SitzkostenTabelle;
  projekt: ProjektTabelle;
  projekt_alias: ProjektAliasTabelle;
  sitzung: SitzungTabelle;
  anfrage: AnfrageTabelle;
  otel_kontrollsumme: OtelKontrollsummeTabelle;
  tag_aggregat: TagAggregatTabelle;
  issue_aggregat: IssueAggregatTabelle;
  monatsabschluss: MonatsabschlussTabelle;
  kurs: KursTabelle;
  preis: PreisTabelle;
  ueberschreitung: UeberschreitungTabelle;
  abgleich_lauf: AbgleichLaufTabelle;
  budget: BudgetTabelle;
  alarm: AlarmTabelle;
  alarm_kanal: AlarmKanalTabelle;
  hinweis: HinweisTabelle;
  ee_einstellung: EeEinstellungTabelle;
  mandant_jira: MandantJiraTabelle;
  projekt_jira: ProjektJiraTabelle;
  jira_issue_cache: JiraIssueCacheTabelle;
  mandant_projektkatalog: MandantProjektkatalogTabelle;
  katalog_projekt: KatalogProjektTabelle;
  katalog_import_token: KatalogImportTokenTabelle;
  katalog_sync_tag: KatalogSyncTagTabelle;
  projekt_katalog: ProjektKatalogTabelle;
  sitzung_katalog: SitzungKatalogTabelle;
  katalog_abschluss: KatalogAbschlussTabelle;
  mandant_oidc: MandantOidcTabelle;
  mandant_domain: MandantDomainTabelle;
  konto_einladung: KontoEinladungTabelle;
  mandant_scim_token: MandantScimTokenTabelle;
  scim_konto: ScimKontoTabelle;
  mandant_scim_gruppe: MandantScimGruppeTabelle;
  mandant_scim_mitglied: MandantScimMitgliedTabelle;
  benutzer: BenutzerTabelle;
  rolle: RolleTabelle;
  audit: AuditTabelle;
  ingest_statistik: IngestStatistikTabelle;
  loeschlauf: LoeschlaufTabelle;
  benutzer_sitzung: BenutzerSitzungTabelle;
  job_lauf: JobLaufTabelle;
}
