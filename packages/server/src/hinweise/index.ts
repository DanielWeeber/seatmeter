// Modul hinweise (Kern, bis 2026-10-24 ee): Projekt-Hinweise je Projekt und Monat, Regeln je Mandant, Job
// `hinweise.erzeugen` (täglich 04:30 UTC, nach Tagesaggregat und Kurs). Datenqualität steht im Modul aggregation.
import type { SeatmeterPlugin } from '../plugin.js';
import { hinweiseJob } from './job.js';
import { hinweisRouten } from './routen.js';

export * from './job.js';
export * from './regeln.js';
export { AUDIT_HINWEISE } from './routen.js';

export const hinweisePlugin: SeatmeterPlugin = {
  name: 'kern-hinweise',
  routen: (app, ctx) => hinweisRouten(app, ctx),
  jobs: [
    { name: 'hinweise.erzeugen', zeitplan: '30 4 * * *', ausfuehren: (ctx) => hinweiseJob(ctx) },
  ],
};
