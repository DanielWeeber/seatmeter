// Verträge des ee-Moduls Jira: Verbindung je Mandant (Cloud: E-Mail + API-Token,
// Data Center: Personal Access Token), Zuordnung seatmeter-Projekt → Jira-Projekt und Kosten je
// Jira-Projekt und Issue. Das Token steht nur in Eingaben, nie in Antworten. Kein Rückschreiben nach Jira.
import { z } from 'zod';
import { kennzahlenSchema, monatSchema } from './dashboard.js';
import { ISSUE_SCHLUESSEL_MUSTER, JIRA_PROJEKT_SCHLUESSEL_MUSTER } from './issue-schluessel.js';

export const JIRA_ARTEN = ['cloud', 'datacenter'] as const;
export type JiraArt = (typeof JIRA_ARTEN)[number];

/** `PUT /api/v1/ee/jira/verbindung`: ohne `token` bleibt das gespeicherte Token. */
export const jiraVerbindungEingabeSchema = z
  .strictObject({
    basis_url: z.url().max(500),
    art: z.enum(JIRA_ARTEN),
    /** Nur Cloud (Basic-Anmeldung mit E-Mail und API-Token). */
    benutzer_email: z.email().max(320).nullable().default(null),
    token: z.string().trim().min(1).max(2000).optional(),
    aktiv: z.boolean().default(true),
    /** Issue-Schlüssel nur für zugeordnete Jira-Projekte speichern (Positivliste). */
    nur_zugeordnete: z.boolean().default(false),
  })
  .refine((e) => e.art !== 'cloud' || e.benutzer_email !== null, {
    message: 'Jira Cloud braucht die E-Mail-Adresse des Kontos',
    path: ['benutzer_email'],
  });
export type JiraVerbindungEingabe = z.input<typeof jiraVerbindungEingabeSchema>;

/** `GET /api/v1/ee/jira/verbindung` (ohne Token). */
export const jiraVerbindungSchema = z.object({
  eingerichtet: z.boolean(),
  basis_url: z.string().nullable(),
  art: z.enum(JIRA_ARTEN).nullable(),
  benutzer_email: z.string().nullable(),
  token_gesetzt: z.boolean(),
  aktiv: z.boolean(),
  nur_zugeordnete: z.boolean(),
  zuletzt_geprueft: z.string().nullable(),
  fehler: z.string().nullable(),
});
export type JiraVerbindung = z.infer<typeof jiraVerbindungSchema>;

/** `POST /api/v1/ee/jira/verbindung/pruefen` */
export const jiraPruefungSchema = z.object({
  ok: z.boolean(),
  /** Anzeigename des Jira-Kontos (keine E-Mail). */
  konto: z.string().nullable(),
  fehler: z.string().nullable(),
  zuletzt_geprueft: z.string(),
});
export type JiraPruefung = z.infer<typeof jiraPruefungSchema>;

export const jiraProjektSchema = z.object({ schluessel: z.string(), name: z.string() });
export type JiraProjekt = z.infer<typeof jiraProjektSchema>;

/** `GET /api/v1/ee/jira/projekte` (aus Jira geladen). */
export const jiraProjekteAntwortSchema = z.object({ projekte: z.array(jiraProjektSchema) });
export type JiraProjekteAntwort = z.infer<typeof jiraProjekteAntwortSchema>;

export const jiraZuordnungZeileSchema = z.object({
  projekt_id: z.string(),
  projekt_name: z.string(),
  jira_projekt_schluessel: z.string().nullable(),
  jira_projekt_name: z.string().nullable(),
});
export type JiraZuordnungZeile = z.infer<typeof jiraZuordnungZeileSchema>;

/** `GET /api/v1/ee/jira/zuordnung`: alle seatmeter-Projekte des Mandanten mit ihrer Zuordnung. */
export const jiraZuordnungAntwortSchema = z.object({
  zuordnung: z.array(jiraZuordnungZeileSchema),
  /** Aktuelle Positivliste (`mandant.issue_praefixe`); `null` = alle Schlüssel. */
  issue_praefixe: z.array(z.string()).nullable(),
});
export type JiraZuordnungAntwort = z.infer<typeof jiraZuordnungAntwortSchema>;

/** `PUT /api/v1/ee/jira/zuordnung`: vollständige Liste; `null` entfernt die Zuordnung. */
export const jiraZuordnungEingabeSchema = z.strictObject({
  zuordnung: z
    .array(
      z.strictObject({
        projekt_id: z.uuid(),
        jira_projekt_schluessel: z
          .string()
          .max(50)
          .regex(JIRA_PROJEKT_SCHLUESSEL_MUSTER)
          .nullable(),
        jira_projekt_name: z.string().max(200).nullable().default(null),
      }),
    )
    .max(2000),
});
export type JiraZuordnungEingabe = z.input<typeof jiraZuordnungEingabeSchema>;

export const jiraKostenIssueSchema = kennzahlenSchema.extend({
  schluessel: z.string().regex(ISSUE_SCHLUESSEL_MUSTER),
  /** Aus Jira (zwischengespeichert, 24 h); `null`, solange unbekannt. */
  titel: z.string().nullable(),
  status: z.string().nullable(),
  /** `false`: Jira kennt den Schlüssel nicht (z. B. Branch-Name ohne echtes Issue). */
  gefunden: z.boolean().nullable(),
  sitzungen: z.number(),
});
export type JiraKostenIssue = z.infer<typeof jiraKostenIssueSchema>;

export const jiraKostenProjektSchema = kennzahlenSchema.extend({
  /** Jira-Projektschlüssel (Präfix der Issue-Schlüssel). */
  schluessel: z.string(),
  name: z.string().nullable(),
  /** seatmeter-Projekte mit dieser Zuordnung. */
  seatmeter_projekte: z.array(z.object({ id: z.string(), name: z.string() })),
  issues: z.array(jiraKostenIssueSchema),
  /** Nutzung zugeordneter seatmeter-Projekte ohne Issue-Schlüssel. */
  ohne_issue: kennzahlenSchema,
});
export type JiraKostenProjekt = z.infer<typeof jiraKostenProjektSchema>;

/** `GET /api/v1/ee/jira/kosten?monat=` */
export const jiraKostenAntwortSchema = z.object({
  monat: monatSchema,
  jira_projekte: z.array(jiraKostenProjektSchema),
  titel: z.object({
    /** In diesem Aufruf aus Jira nachgeladene Issues (höchstens 50). */
    nachgeladen: z.number(),
    /** Noch ohne Titel (werden beim nächsten Aufruf nachgeladen). */
    offen: z.number(),
    /** Fehler beim Nachladen (nicht blockierend), ohne Token. */
    fehler: z.string().nullable(),
  }),
});
export type JiraKostenAntwort = z.infer<typeof jiraKostenAntwortSchema>;
