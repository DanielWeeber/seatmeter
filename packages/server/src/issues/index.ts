// Modul issues: Monatsaggregat je Issue-Schlüssel (aufgebaut vom Tagesaggregat) und
// die Dashboard-Routen `/api/v1/projekte/:id/issues` und `/api/v1/issues`.
import type { SeatmeterPlugin } from '../plugin.js';
import { issueRouten } from './routen.js';

export * from './aggregat.js';
export { issueRouten, kennzahlenAus, projektAnzeigename } from './routen.js';

export const issuesPlugin: SeatmeterPlugin = {
  name: 'kern-issues',
  routen(app, ctx) {
    issueRouten(app, ctx);
  },
};
