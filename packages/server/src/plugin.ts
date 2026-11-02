// Erweiterungspunkt SeatmeterPlugin (Architektur §2.3, §8): `ee/` registriert sich hierüber.
// Der Kern importiert nie aus `ee/`; Plugins werden per Modulname (SEATMETER_PLUGINS) geladen.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NavEintrag, Rolle } from '@seatmeter/shared';
import type { Konfiguration } from './config.js';
import type { Db } from './db/db.js';
import type { Datenbank } from './db/schema.js';

export interface PluginKontext {
  db: Db;
  konfiguration: Konfiguration;
}

export interface JobDefinition {
  /** Eindeutiger Name, z. B. `aggregation.tag`. */
  name: string;
  /** Cron-Ausdruck (UTC), z. B. `15 2 * * *`; oder aus der Konfiguration, `null` = nicht planen, `--einmal` geht weiter. */
  zeitplan: string | ((konfiguration: Konfiguration) => string | null);
  /** Läuft er schon, bleibt das ohne Zeile in `job_lauf`: Bei häufigen Jobs und mehreren Instanzen wäre das nur Rauschen. */
  still?: boolean;
  /** Rückgabe (nur Zähler, JSON) landet in `job_lauf.ergebnis`. */
  ausfuehren(ctx: PluginKontext): Promise<unknown>;
}

export interface Benutzerkontext {
  benutzerId: string;
  mandantId: string;
  rollen: string[];
}

/** Anmeldeknopf auf der Anmeldeseite (`GET /api/v1/auth/anbieter`). */
export interface AnmeldeLink {
  /** Deutscher Knopftext, z. B. „Mit weeberwrk SSO anmelden“. */
  titel: string;
  /** Start-URL (Weiterleitung zum Identity Provider), z. B. `/api/v1/auth/oidc/start`. */
  start: string;
}

export interface AuthProvider {
  /** Z. B. `lokal`, `oidc`, `proxy-header`. */
  name: string;
  /** Liefert den Benutzer zur Anfrage oder `null`, wenn dieser Provider nicht zuständig ist. */
  authentifizieren(anfrage: FastifyRequest, ctx: PluginKontext): Promise<Benutzerkontext | null>;
  /**
   * Optional: Knopf für die Anmeldeseite; `null`, solange der Provider nicht nutzbar ist
   * (z. B. nicht konfiguriert oder ohne Lizenz). Anbieter mit Weiterleitung (OIDC) legen nach dem
   * Rückruf eine normale Sitzung an (`erstelleSitzung`) und liefern in `authentifizieren` `null`.
   */
  anmeldeLink?(ctx: PluginKontext): AnmeldeLink | null;
  /**
   * Optional (Modul oidc: SSO je Mandant): Anmeldedienst für eine E-Mail-Adresse (verifizierte Domain → Mandant)
   * bzw. ein Mandanten-Kürzel; `null`, wenn keiner zuständig ist. Grundlage von
   * `GET /api/v1/auth/anbieter?email=…|?mandant=…`. Darf nie verraten, ob ein Konto existiert.
   */
  anmeldeZiel?(abfrage: AnmeldeAbfrage, ctx: PluginKontext): Promise<AnmeldeZiel | null>;
}

/** Abfrage der Anmeldeseite: genau eines von E-Mail-Adresse (klein) oder Mandanten-Kürzel. */
export interface AnmeldeAbfrage {
  email?: string;
  mandant?: string;
}

/** Anmeldedienst eines Mandanten für die Anmeldeseite („Weiter zu <bezeichnung>“). */
export interface AnmeldeZiel {
  bezeichnung: string;
  /** Start-URL, z. B. `/api/v1/auth/oidc/start?mandant=<slug>`. */
  start: string;
}

/** Rolle eines Benutzers in einem Mandanten (Ergebnis von `benutzer_mandanten`). */
export interface MandantRolle {
  mandant_id: string;
  name: string;
  slug: string;
  rolle: Rolle;
  projekt_ids: string[] | null;
}

/** Erweiterung der Anmeldung durch Plugins (ee: Plattform-Admin, Lizenzstatus in `/me`, Kontenkontingent). */
export interface AuthErweiterung {
  /**
   * Zusätzliche Mandanten-Rollen, die nicht in `rolle` stehen (ee: Plattform-Admins sehen jeden
   * Mandanten mit der Rolle `controller`, also ohne Personensichten). Gilt für Mandantenwahl,
   * Sitzung und `/me`; Mandantenzugriffe bleiben trotzdem an `withMandant` gebunden.
   */
  zusatzRollen?(benutzerId: string, ctx: PluginKontext): Promise<MandantRolle[]>;
  /** Zusatzfelder für `GET /api/v1/auth/me` (ee: `ee`, `plattform_admin`). */
  me?(
    anmeldung: { benutzerId: string; mandantId: string | null },
    ctx: PluginKontext,
  ): Promise<Record<string, unknown>>;
  /**
   * Kontenkontingent (ee: `mandant.konten_max`, gesetzt vom Plattform-Admin). Gefragt in der Transaktion des
   * Mandanten (`withMandant`), bevor ein Konto seine erste Rolle im Mandanten bekommt (Einladung,
   * Rollenvergabe, Reaktivierung, SSO-Erstanmeldung, SCIM, Header-Modus); `benutzerId` `null` = neues Konto.
   * Ergebnis `null` = passt, sonst der volle Stand. Darf bis Transaktionsende eine Sperre je Mandant halten.
   * Ohne Erweiterung gilt kein Kontingent.
   */
  kontingentPruefen?(
    trx: Transaction<Datenbank>,
    benutzerId: string | null,
  ): Promise<KontingentStand | null>;
  /** Stand des Kontenkontingents für Anzeigen (ee); ohne Erweiterung zählt der Kern, ohne Obergrenze. */
  kontingentStand?(trx: Transaction<Datenbank>): Promise<KontingentStand>;
  /**
   * Konten, die über allen Mandanten stehen (ee: Plattform-Admins). Sie zählen nicht im Kontenkontingent, nur
   * solche Konten ändern sie in der Kontenverwaltung, und SCIM eines Mandanten sperrt oder benennt sie nie.
   */
  plattformAdmins?(ctx: PluginKontext): Promise<string[]>;
  /**
   * Darf das Konto den Mandanten verwalten, ohne dort Mandanten-Admin zu sein (ee: Plattform-Admin mit
   * Lizenz)? Grundlage der Mandantenverwaltung unter `/api/v1/mandant/…` mit `?mandant=<id>`.
   */
  mandantVerwalten?(benutzerId: string, mandantId: string, ctx: PluginKontext): Promise<boolean>;
  /**
   * Gruppen-Zuordnung des globalen OIDC-Anbieters (`SEATMETER_OIDC_GRUPPEN` mit `{ "plattform_admin": true }`):
   * Plattform-Admin aus Gruppen setzen bzw. entziehen (ee). Ohne Erweiterung bleibt das Ziel wirkungslos.
   */
  plattformAdminAbgleichen?(benutzerId: string, soll: boolean, ctx: PluginKontext): Promise<void>;
}

/** Kontenkontingent eines Mandanten: belegte Plätze und Obergrenze (`null` = unbegrenzt). */
export interface KontingentStand {
  belegt: number;
  max: number | null;
}

/**
 * Eigene Migrationen eines Plugins (nur vorwärts). Sie laufen nach denen des Kerns mit eigener
 * Protokolltabelle `kysely_migration_<name>`, damit ein Plugin entfernt werden kann, ohne dass der
 * Kern-Migrator über fehlende Einträge stolpert.
 */
export interface PluginMigrationen {
  /** Kurzname für die Protokolltabelle (`[a-z0-9_]+`), z. B. `ee`. */
  name: string;
  migrationen: Record<string, Migration>;
}

export interface SeatmeterPlugin {
  name: string;
  /** Registriert Routen in einem eigenen Fastify-Kontext. */
  routen?(app: FastifyInstance, ctx: PluginKontext): Promise<void> | void;
  jobs?: JobDefinition[];
  authProvider?: AuthProvider[];
  /** Erweiterungen der Anmeldung (zusätzliche Rollen, Felder in `/me`). */
  auth?: AuthErweiterung;
  /** Eigene Migrationen; `main.ts` führt sie nach den Kern-Migrationen aus (`migrierePlugins`). */
  migrationen?: PluginMigrationen;
  navigation?: NavEintrag[];
}

export interface PluginRegister {
  plugins: string[];
  jobs: JobDefinition[];
  authProvider: AuthProvider[];
  auth: AuthErweiterung[];
  navigation: NavEintrag[];
}

/** Registriert die Plugins an der App und sammelt Jobs, Auth-Provider und Navigation ein. */
export async function registrierePlugins(
  app: FastifyInstance,
  plugins: readonly SeatmeterPlugin[],
  ctx: PluginKontext,
): Promise<PluginRegister> {
  const register: PluginRegister = {
    plugins: [],
    jobs: [],
    authProvider: [],
    auth: [],
    navigation: [],
  };
  const namen = new Set<string>();
  for (const plugin of plugins) {
    if (namen.has(plugin.name)) throw new Error(`Plugin doppelt registriert: ${plugin.name}`);
    namen.add(plugin.name);
    const routen = plugin.routen;
    if (routen) await app.register(async (kind) => routen.call(plugin, kind, ctx));
    register.plugins.push(plugin.name);
    register.jobs.push(...(plugin.jobs ?? []));
    register.authProvider.push(...(plugin.authProvider ?? []));
    if (plugin.auth) register.auth.push(plugin.auth);
    register.navigation.push(...(plugin.navigation ?? []));
  }
  return register;
}

function istPlugin(wert: unknown): wert is SeatmeterPlugin {
  return (
    typeof wert === 'object' && wert !== null && typeof (wert as SeatmeterPlugin).name === 'string'
  );
}

/** Lädt Plugins dynamisch per Modulname; erwartet einen Default-Export vom Typ SeatmeterPlugin. */
export async function ladePluginModule(modulnamen: readonly string[]): Promise<SeatmeterPlugin[]> {
  const geladen: SeatmeterPlugin[] = [];
  for (const name of modulnamen) {
    const modul: { default?: unknown } = await import(name);
    if (!istPlugin(modul.default)) throw new Error(`Modul ${name} exportiert kein SeatmeterPlugin`);
    geladen.push(modul.default);
  }
  return geladen;
}
