// Verträge des Moduls Projektkatalog (Kern): Projektliste aus dem Projektmanagement-Werkzeug des Mandanten,
// Zuordnung Repo → Katalog-Projekt, Kosten je Katalog-Projekt und die erzwungene Projektwahl. Nur lesend
// gegenüber der Quelle. Eine Sitzung ohne Repo wird über ihre Sitzungs-ID zugeordnet.
import { z } from 'zod';
import { kennzahlenSchema, monatSchema } from './dashboard.js';

const leerZuNull = (w: string | null | undefined) => {
  const t = w?.trim();
  return t ? t : null;
};

/** Steuerzeichen (auch Zeilenumbrüche) oder ein Ersetzungszeichen aus falsch dekodierten Dateien? */
export function katalogTextUnsauber(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) return true;
  }
  return false;
}

const sauber = (w: string) => !katalogTextUnsauber(w);
const TEXT_UNSAUBER = 'enthält Steuerzeichen oder falsch kodierte Zeichen';

const JA = new Set([
  'ja',
  'j',
  'yes',
  'y',
  'true',
  't',
  'wahr',
  '1',
  'on',
  'aktiv',
  'active',
  'offen',
]);
const NEIN = new Set([
  'nein',
  'n',
  'no',
  'false',
  'f',
  'falsch',
  '0',
  'off',
  'inaktiv',
  'inactive',
  'abgeschlossen',
  'geschlossen',
  'closed',
]);

/** Ja/Nein aus Text, für Push und CSV gleich; `undefined` = nicht erkannt. Groß-/Kleinschreibung egal. */
export function katalogJaNein(text: string): boolean | undefined {
  const t = text.trim().toLowerCase();
  return JA.has(t) ? true : NEIN.has(t) ? false : undefined;
}

/** Längen wie in der Datenbank. */
export const KATALOG_ID_MAX = 200;
export const KATALOG_NUMMER_MAX = 100;
export const KATALOG_NAME_MAX = 300;
export const KATALOG_STATUS_MAX = 100;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(sauber, TEXT_UNSAUBER)
    .nullable()
    .optional()
    .transform((w) => (w === undefined ? undefined : leerZuNull(w)));

/**
 * Ein Projekt aus der Quelle: JSON-Import, CSV und künftige Quellen liefern diese Form. Die externe ID ist der Schlüssel;
 * fehlt sie, gilt die Nummer auch als ID. Optionale Felder: weggelassen bleibt der gespeicherte Wert, `null` leert ihn.
 */
export const katalogEintragSchema = z
  .strictObject({
    externe_id: z
      .string()
      .trim()
      .min(1)
      .max(KATALOG_ID_MAX)
      .refine(sauber, TEXT_UNSAUBER)
      .optional(),
    nummer: optionalText(KATALOG_NUMMER_MAX),
    name: z.string().trim().min(1).max(KATALOG_NAME_MAX).refine(sauber, TEXT_UNSAUBER),
    kunde: optionalText(KATALOG_NAME_MAX),
    parent: optionalText(KATALOG_ID_MAX),
    aktiv: z.boolean().default(true),
    status: optionalText(KATALOG_STATUS_MAX),
  })
  .transform((e, ctx) => {
    const id = e.externe_id ?? e.nummer;
    if (!id) {
      ctx.addIssue({
        code: 'custom',
        message: 'Externe ID oder Nummer fehlt',
        path: ['externe_id'],
      });
      return z.NEVER;
    }
    return { ...e, externe_id: id };
  });
export type KatalogEintrag = z.output<typeof katalogEintragSchema>;

/** Obergrenze je Import (Projekte). */
export const KATALOG_IMPORT_MAX = 20_000;

/** Obergrenze einer hochgeladenen Datei (Route und CLI). */
export const KATALOG_DATEI_MAX_BYTES = 16 * 1024 * 1024;

/** Höchstens so viele Meldungen zu abgelehnten Zeilen; die Zahl `abgelehnt` zählt alle. */
export const KATALOG_ABGELEHNT_MELDUNGEN_MAX = 20;

/** Trennzeichen der CSV; es wird nicht erraten. */
export const katalogTrennzeichenSchema = z.enum([';', ',', '\t', '|']);
export type KatalogTrennzeichen = z.infer<typeof katalogTrennzeichenSchema>;
export const KATALOG_TRENNZEICHEN_STANDARD: KatalogTrennzeichen = ';';

const TRENNZEICHEN_NAMEN: Record<string, KatalogTrennzeichen> = {
  semikolon: ';',
  komma: ',',
  tab: '\t',
  tabulator: '\t',
  pipe: '|',
};

/** Trennzeichen aus URL oder Kommandozeile: das Zeichen selbst oder sein Name; `null` = unbekannt. */
export function katalogTrennzeichenLesen(wert: string): KatalogTrennzeichen | null {
  const e = katalogTrennzeichenSchema.safeParse(wert);
  return e.success ? e.data : (TRENNZEICHEN_NAMEN[wert.trim().toLowerCase()] ?? null);
}

const spaltenName = z.string().trim().min(1).max(200);

/** Spaltenzuordnung nach Kopfzeilen-Namen: externe ID und Name Pflicht, alle anderen Spalten zählen nicht. */
export const katalogSpaltenSchema = z.strictObject({
  id: spaltenName,
  name: spaltenName,
  nummer: spaltenName.optional(),
  kunde: spaltenName.optional(),
  aktiv: spaltenName.optional(),
  parent: spaltenName.optional(),
});
export type KatalogSpalten = z.infer<typeof katalogSpaltenSchema>;

/** `POST /api/v1/projektkatalog/import`: `vollstaendig` deaktiviert alle Projekte, die fehlen. */
export const katalogImportEingabeSchema = z.strictObject({
  projekte: z.array(katalogEintragSchema).min(1).max(KATALOG_IMPORT_MAX),
  vollstaendig: z.boolean().default(true),
  trockenlauf: z.boolean().default(false),
});
export type KatalogImportEingabe = z.input<typeof katalogImportEingabeSchema>;

/** `POST /api/v1/projektkatalog/import/csv` */
export const KATALOG_TEXT_KODIERUNG =
  'Die Datei ist nicht UTF-8-kodiert. Bitte als UTF-8 exportieren (mit oder ohne BOM).';

export const katalogCsvEingabeSchema = z.strictObject({
  csv: z
    .string()
    .min(1, 'CSV fehlt')
    .refine((w) => !w.includes('\uFFFD'), KATALOG_TEXT_KODIERUNG),
  vollstaendig: z.boolean().default(true),
  trockenlauf: z.boolean().default(false),
  trennzeichen: katalogTrennzeichenSchema.default(KATALOG_TRENNZEICHEN_STANDARD),
  spalten: katalogSpaltenSchema.optional(),
});
export type KatalogCsvEingabe = z.input<typeof katalogCsvEingabeSchema>;

export const katalogImportErgebnisSchema = z.object({
  neu: z.number(),
  /** Bekannte Projekte, bei denen sich Name, Kunde oder Aktiv wirklich geändert hat (auch Reaktivierung). */
  aktualisiert: z.number(),
  unveraendert: z.number(),
  /** Bekannte Projekte, die in der vollständigen Liste fehlen. */
  deaktiviert: z.number(),
  abgelehnt: z.number(),
  aktiv_gesamt: z.number(),
  /** Höchstens 20 Meldungen mit Zeilennummer, nie mit Zellinhalten. */
  abgelehnte_zeilen: z.array(z.string()),
  /** Gültige Zeilen, deretwegen nichts deaktiviert wird; höchstens 20, mit Zeilennummer, nie mit Zellinhalten. */
  hinweise: z.array(z.string()),
  /** Eine Zeile ließ sich keinem Projekt zuordnen oder kann andere verschluckt haben: Es wurde nichts deaktiviert. */
  deaktivierung_uebersprungen: z.boolean(),
  /** Nur gerechnet, nichts gespeichert. */
  trockenlauf: z.boolean(),
});
export type KatalogImportErgebnis = z.infer<typeof katalogImportErgebnisSchema>;

/** Präfix der Katalog-Tokens. Der Zweck entscheidet, welche Route das Token darf. */
export const KATALOG_TOKEN_PRAEFIX = 'smk_';

/**
 * `csv_import`: nur der CSV-Upload. `katalog_api`: nur der Push je Projekt und der Sync-Status. `sync_status`: nur
 * lesend der Sync-Status, für die Überwachung.
 */
export const katalogTokenScopeSchema = z.enum(['csv_import', 'katalog_api', 'sync_status']);
export type KatalogTokenScope = z.infer<typeof katalogTokenScopeSchema>;

export const katalogTokenSchema = z.object({
  id: z.string(),
  bezeichnung: z.string(),
  praefix: z.string(),
  scope: katalogTokenScopeSchema,
  erstellt: z.string(),
  zuletzt_genutzt: z.string().nullable(),
  widerrufen: z.string().nullable(),
});
export type KatalogToken = z.infer<typeof katalogTokenSchema>;

/** `GET /api/v1/projektkatalog/tokens` */
export const katalogTokenListeSchema = z.object({ tokens: z.array(katalogTokenSchema) });
export type KatalogTokenListe = z.infer<typeof katalogTokenListeSchema>;

/** `POST /api/v1/projektkatalog/tokens` */
export const katalogTokenEingabeSchema = z.strictObject({
  bezeichnung: z.string().trim().min(1).max(100),
  scope: katalogTokenScopeSchema.default('csv_import'),
});
export type KatalogTokenEingabe = z.input<typeof katalogTokenEingabeSchema>;

/** Antwort beim Anlegen: Der Klartext steht nur hier. */
export const katalogTokenNeuSchema = katalogTokenSchema.extend({ token: z.string() });
export type KatalogTokenNeu = z.infer<typeof katalogTokenNeuSchema>;

export const katalogProjektSchema = z.object({
  id: z.string(),
  externe_id: z.string(),
  /** Anzeige: Nummer, ohne Nummer die externe ID. */
  nummer: z.string(),
  name: z.string(),
  /** Namen von der Wurzel bis hierher, z. B. `Webshop › AP Login`. */
  pfad: z.string(),
  parent_externe_id: z.string().nullable(),
  kunde: z.string().nullable(),
  aktiv: z.boolean(),
  /** Status wie vom Quellsystem gesendet. */
  status: z.string().nullable(),
  quelle: z.string(),
  zuletzt_gesehen: z.string(),
});
export type KatalogProjekt = z.infer<typeof katalogProjektSchema>;

/** `GET /api/v1/projektkatalog/projekte` */
export const katalogListeSchema = z.object({ projekte: z.array(katalogProjektSchema) });
export type KatalogListe = z.infer<typeof katalogListeSchema>;

/**
 * Stufe der Projektwahl: `aus`; `warnen` lässt den Prompt durch und zeigt den Link; `blockieren` hält den Prompt an,
 * bis ein Projekt gewählt ist. Rollout: erst warnen, später blockieren.
 */
export const katalogStufeSchema = z.enum(['aus', 'warnen', 'blockieren']);
export type KatalogStufe = z.infer<typeof katalogStufeSchema>;

/** Warum die Projektwahl gerade nicht eingeschaltet werden darf (Serverkonfiguration). */
export const katalogHinderungSchema = z.enum(['auto_rolle', 'link_basis']);
export type KatalogHinderung = z.infer<typeof katalogHinderungSchema>;

export const KATALOG_HINDERUNG_TEXT: Record<KatalogHinderung, string> = {
  auto_rolle:
    'Im Header-Modus bekäme jede Person, die dem Link folgt, die Rolle aus SEATMETER_AUTO_ROLLE. Bitte ' +
    'SEATMETER_AUTO_ROLLE=entwickler setzen, sonst bleibt die Projektwahl aus.',
  link_basis:
    'SEATMETER_INGEST_URL ist gesetzt, SEATMETER_PUBLIC_URL nicht: Der Link zeigte auf den Ingest-Host. Bitte ' +
    'SEATMETER_PUBLIC_URL setzen, sonst bleibt die Projektwahl aus.',
};

/** Status, die ein Projekt inaktiv machen, wenn der Mandant nichts anderes einstellt. */
export const KATALOG_INAKTIV_STATUS_STANDARD: readonly string[] = [
  'closed',
  'archived',
  'inactive',
  'cancelled',
  'abgeschlossen',
  'archiviert',
  'geschlossen',
  'inaktiv',
  'beendet',
  'storniert',
];

/** Standard der Bremse beim Deaktivieren veralteter Projekte. */
export const KATALOG_DEAKTIVIEREN_MAX_PROZENT = 25;

/** Standard der Warnung bei ausbleibender Synchronisation. */
export const KATALOG_SYNC_WARNUNG_STUNDEN = 48;

/**
 * `aus`: Warnung abgeschaltet. `nicht_bewertet`: noch kein Token und noch keine Synchronisation.
 * `ok` und `veraltet` je nach Alter der letzten Synchronisation.
 */
export const katalogSyncStatusSchema = z.enum(['aus', 'nicht_bewertet', 'ok', 'veraltet']);
export type KatalogSyncStatus = z.infer<typeof katalogSyncStatusSchema>;

export const katalogSyncStandSchema = z.object({
  status: katalogSyncStatusSchema,
  zuletzt_sync: z.string().nullable(),
  warnung_stunden: z.number().nullable(),
  deaktivieren_tage: z.number().nullable(),
  /** Mehr Anteil der gesendeten Projekte geht über den Zeitraum der Bremse nicht verloren; mindestens ein Projekt darf. */
  deaktivieren_max_prozent: z.number(),
  /** Der letzte Lauf hätte zu viele Projekte deaktiviert und wurde angehalten. */
  bremse_aktiv: z.boolean(),
  /** Letzte sieben Tage (UTC), neuester zuerst. `abgelehnt`: Anfragen mit gültigem Token, die nicht 200 bekamen. */
  tage: z.array(
    z.object({
      tag: z.string(),
      neu: z.number(),
      aktualisiert: z.number(),
      unveraendert: z.number(),
      abgelehnt: z.number(),
    }),
  ),
});
export type KatalogSyncStand = z.infer<typeof katalogSyncStandSchema>;

/** `GET /api/v1/projektkatalog/sync-status`: 200 außer bei `veraltet` (503). */
export const katalogSyncStatusAntwortSchema = z.object({
  status: katalogSyncStatusSchema,
  zuletzt_sync: z.string().nullable(),
  warnung_stunden: z.number().nullable(),
  alter_stunden: z.number().nullable(),
  /** Anfragen mit gültigem Token, die nicht 200 bekamen: ein abgebrochener Lauf, ändert den Statuscode nicht. */
  abgelehnt_heute: z.number(),
  abgelehnt_7_tage: z.number(),
});
export type KatalogSyncStatusAntwort = z.infer<typeof katalogSyncStatusAntwortSchema>;

/** Antwort von `PUT /api/v1/projektkatalog/projekte/:externalId`. */
export const katalogPushAntwortSchema = z.object({
  externalId: z.string(),
  ergebnis: z.enum(['neu', 'aktualisiert', 'unveraendert']),
  active: z.boolean(),
});
export type KatalogPushAntwort = z.infer<typeof katalogPushAntwortSchema>;

/** `GET /api/v1/projektkatalog/einstellung` */
export const katalogEinstellungSchema = z.object({
  stufe: katalogStufeSchema,
  /** Steht auf der Hinweisseite für Konten ohne Zugang zur Organisation. */
  kontakt: z.string().nullable(),
  /** Gesetzt: Der Hook wirkt nicht, die Stufe lässt sich nicht einschalten. */
  hinderung: katalogHinderungSchema.nullable(),
  /** `false`: keine Konten mit der Rolle `entwickler` und keine Gruppenzuordnung dafür. */
  auswahl_erreichbar: z.boolean(),
  /** Status, die ein Projekt inaktiv machen (klein geschrieben). */
  inaktiv_status: z.array(z.string()),
  sync: katalogSyncStandSchema,
  zuletzt_import: z.string().nullable(),
  import_quelle: z.string().nullable(),
  projekte_aktiv: z.number(),
  projekte_gesamt: z.number(),
});
export type KatalogEinstellung = z.infer<typeof katalogEinstellungSchema>;

/** `PUT /api/v1/projektkatalog/einstellung`; was fehlt, bleibt. */
export const katalogEinstellungEingabeSchema = z.strictObject({
  stufe: katalogStufeSchema.optional(),
  /** `null` stellt die Standardliste wieder her. */
  inaktiv_status: z
    .array(z.string().trim().min(1).max(KATALOG_STATUS_MAX).refine(sauber, TEXT_UNSAUBER))
    .max(100)
    .nullable()
    .optional(),
  /** `null`: Warnung aus. */
  sync_warnung_stunden: z.number().int().min(1).max(8760).nullable().optional(),
  /** `null`: nichts wird wegen Alters deaktiviert. */
  sync_deaktivieren_tage: z.number().int().min(1).max(3650).nullable().optional(),
  /** Bremse: Würde ein Lauf mehr als diesen Anteil der aktiven Projekte deaktivieren, hält er an. */
  sync_deaktivieren_max_prozent: z.number().int().min(1).max(100).optional(),
  kontakt: z
    .string()
    .trim()
    .max(200)
    .refine(sauber, TEXT_UNSAUBER)
    .nullish()
    .transform((w) => (w === undefined ? undefined : leerZuNull(w))),
});
export type KatalogEinstellungEingabe = z.input<typeof katalogEinstellungEingabeSchema>;

/** Katalog-Projekt in Zuordnung und Auswahl (ohne Herkunftsangaben). */
export const katalogKurzSchema = z.object({
  id: z.string(),
  externe_id: z.string(),
  nummer: z.string(),
  name: z.string(),
  pfad: z.string(),
  parent_externe_id: z.string().nullable(),
  kunde: z.string().nullable(),
  aktiv: z.boolean(),
});
export type KatalogKurz = z.infer<typeof katalogKurzSchema>;

export const katalogZuordnungZeileSchema = z.object({
  projekt_id: z.string(),
  /** Repo-Name (nie der Name aus dem Katalog). */
  projekt_name: z.string(),
  katalog: katalogKurzSchema.nullable(),
});
export type KatalogZuordnungZeile = z.infer<typeof katalogZuordnungZeileSchema>;

/** `GET /api/v1/projektkatalog/zuordnung`: Projektleiter sehen nur ihre Projekte. */
export const katalogZuordnungAntwortSchema = z.object({
  zuordnung: z.array(katalogZuordnungZeileSchema),
});
export type KatalogZuordnungAntwort = z.infer<typeof katalogZuordnungAntwortSchema>;

/** `PUT /api/v1/projektkatalog/zuordnung`: nur die genannten Zeilen; `null` entfernt die Zuordnung. */
export const katalogZuordnungEingabeSchema = z.strictObject({
  zuordnung: z
    .array(
      z.strictObject({
        projekt_id: z.uuid(),
        katalog_projekt_id: z.uuid().nullable(),
      }),
    )
    .min(1)
    .max(2000),
});
export type KatalogZuordnungEingabe = z.infer<typeof katalogZuordnungEingabeSchema>;

export const katalogKostenRepoSchema = kennzahlenSchema.extend({
  /** `null`: nur für zusammengefasste Zeilen ohne seatmeter-Projekt. */
  id: z.string().nullable(),
  name: z.string(),
});
export type KatalogKostenRepo = z.infer<typeof katalogKostenRepoSchema>;

export const katalogKostenProjektSchema = kennzahlenSchema.extend({
  externe_id: z.string(),
  nummer: z.string(),
  name: z.string(),
  pfad: z.string(),
  kunde: z.string().nullable(),
  repos: z.array(katalogKostenRepoSchema),
  /** Über die Sitzungs-ID zugeordnete Nutzung aus Ordnern ohne Repo. */
  ohne_repo: kennzahlenSchema,
  sitzungen_ohne_repo: z.number(),
  /** Elternprojekt in dieser Sicht; `null` = oberste Ebene, auch wenn das Elternprojekt hier nicht sichtbar ist. */
  eltern_externe_id: z.string().nullable(),
  tiefe: z.number(),
  /**
   * Eigene Kennzahlen plus alle Nachfahren dieser Sicht. Nur zum Anzeigen, nicht addieren: Die Kennzahlen des Projekts selbst
   * zählen nur das Eigene, ihre Summe über alle Projekte ist die Summe der Seite.
   */
  summe: kennzahlenSchema,
});
export type KatalogKostenProjekt = z.infer<typeof katalogKostenProjektSchema>;

/** `GET /api/v1/projektkatalog/kosten?monat=` */
export const katalogKostenAntwortSchema = z.object({
  monat: monatSchema,
  /** `monatsabschluss`: Stand beim Monatsabschluss, spätere Zuordnungen ändern ihn nicht. */
  quelle: z.enum(['live', 'monatsabschluss']),
  /** In Baumreihenfolge: Eltern vor Kindern. Auch Eltern ohne eigene Nutzung, wenn ein Nachfahre welche hat. */
  projekte: z.array(katalogKostenProjektSchema),
  /** Alle Projekte und das Offene dieser Sicht, je einmal gezählt. */
  gesamt: kennzahlenSchema,
  /** Die Sicht ist auf eigene Projekte beschränkt: `gesamt` ist dann nicht die Summe des Monats. */
  eingeschraenkt: z.boolean(),
  offen: z.object({
    /** Repos mit Nutzung im Monat und ohne Zuordnung. */
    repos: z.array(katalogKostenRepoSchema),
    /** Nutzung ohne Repo und ohne gewählte Zuordnung. */
    ohne_repo: kennzahlenSchema,
  }),
});
export type KatalogKostenAntwort = z.infer<typeof katalogKostenAntwortSchema>;

/** `GET /api/v1/projektwahl?token=` (Auswahlseite hinter dem Link des Hooks). */
export const projektwahlAntwortSchema = z.object({
  ziel: z.discriminatedUnion('art', [
    z.object({ art: z.literal('repo'), name: z.string() }),
    z.object({ art: z.literal('sitzung') }),
  ]),
  gueltig_bis: z.string(),
  projekte: z.array(katalogKurzSchema),
  /** Schon vergeben (z. B. von jemand anderem); ändern dürfen dann nur Admin und Projektleitung. */
  zugeordnet: katalogKurzSchema.nullable(),
});
export type ProjektwahlAntwort = z.infer<typeof projektwahlAntwortSchema>;

/** `POST /api/v1/projektwahl` */
export const projektwahlEingabeSchema = z.strictObject({
  token: z.string().min(1).max(4000),
  katalog_projekt_id: z.uuid(),
});
export type ProjektwahlEingabe = z.infer<typeof projektwahlEingabeSchema>;

export const projektwahlErgebnisSchema = z.object({ zugeordnet: katalogKurzSchema });
export type ProjektwahlErgebnis = z.infer<typeof projektwahlErgebnisSchema>;

/** SPA-Pfad der Auswahlseite; das Token steht im Pfad, wird im Server-Log aber gekürzt. */
export const PROJEKTWAHL_PFAD_PRAEFIX = '/projektwahl/';
