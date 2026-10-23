// Modul budgets (Kern, bis 2026-10-24 ee): Budgets je Projekt oder mandantenweit, Alarme je Schwelle genau
// einmal, Alarmkanäle (Webhook, SMTP, weeberwrk-Relay), Job `budgets.pruefen` (stündlich).
import type { SeatmeterPlugin } from '../plugin.js';
import { pruefeBudgets } from './pruefen.js';
import { budgetRouten } from './routen.js';

export * from './kanal.js';
export * from './prognose.js';
export * from './pruefen.js';
export * from './stand.js';
export { AUDIT_BUDGETS } from './routen.js';

export const budgetsPlugin: SeatmeterPlugin = {
  name: 'kern-budgets',
  routen: (app, ctx) => budgetRouten(app, ctx),
  jobs: [
    {
      // Stündlich zur Minute 7 (nach merge.ab); Alarme je Schwelle einmal, Zustellung mit Wiederholung.
      name: 'budgets.pruefen',
      zeitplan: '7 * * * *',
      ausfuehren: (ctx) => pruefeBudgets(ctx),
    },
  ],
};
