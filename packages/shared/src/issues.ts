// Antworttypen der Issue-Auswertung (Kern): Kosten je Issue-Schlüssel aus dem
// Monatsaggregat `issue_aggregat`. Beträge in Mikro-USD wie im übrigen Dashboard.
import { z } from 'zod';
import { kennzahlenSchema, monatSchema } from './dashboard.js';

export const issueZeileSchema = kennzahlenSchema.extend({
  /** z. B. `ABC-123` (groß geschrieben). */
  schluessel: z.string(),
  /** Präfix vor dem Bindestrich, z. B. `ABC` (= Jira-Projektschlüssel). */
  projekt_schluessel: z.string(),
  /** Verschiedene Sitzungen mit Anfragen zu diesem Schlüssel im Monat. */
  sitzungen: z.number(),
});
export type IssueZeile = z.infer<typeof issueZeileSchema>;

/** `GET /api/v1/projekte/:id/issues?monat=` */
export const projektIssuesAntwortSchema = z.object({
  monat: monatSchema,
  projekt: z.object({ id: z.string(), name: z.string() }),
  issues: z.array(issueZeileSchema),
  /** Abo-Nutzung des Projekts ohne erkannten Schlüssel (Projektsumme minus Summe der Issues). */
  ohne_schluessel: kennzahlenSchema,
  /** Projektsumme im Monat (wie `/api/v1/projekte/:id`). */
  gesamt: kennzahlenSchema,
});
export type ProjektIssuesAntwort = z.infer<typeof projektIssuesAntwortSchema>;

export const issueProjektZeileSchema = issueZeileSchema.extend({
  projekt: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type IssueProjektZeile = z.infer<typeof issueProjektZeileSchema>;

/** `GET /api/v1/issues?monat=`: je Schlüssel und seatmeter-Projekt, über alle sichtbaren Projekte. */
export const issuesAntwortSchema = z.object({
  monat: monatSchema,
  issues: z.array(issueProjektZeileSchema),
});
export type IssuesAntwort = z.infer<typeof issuesAntwortSchema>;
