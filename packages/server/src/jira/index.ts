// Modul jira (Kern seit 2026-10-24, vorher ee): Verbindung je Mandant (Token verschlüsselt), Zuordnung
// seatmeter-Projekt → Jira-Projekt, Kosten je Jira-Projekt und Issue. Nur lesend, kein Rückschreiben nach Jira.
import type { SeatmeterPlugin } from '../plugin.js';
import { jiraRouten } from './routen.js';

export * from './client.js';
export * from './daten.js';
export * from './kosten.js';
export { AUDIT_JIRA, jiraRouten } from './routen.js';

export const jiraPlugin: SeatmeterPlugin = {
  name: 'kern-jira',
  routen: (app, ctx) =>
    jiraRouten(app, ctx, { internErlaubt: ctx.konfiguration.SEATMETER_JIRA_INTERN_ERLAUBT }),
};
