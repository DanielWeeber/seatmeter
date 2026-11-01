// Modul projektkatalog (Kern): Projektliste aus dem Projektmanagement-Werkzeug des Mandanten, Zuordnung Repo →
// Katalog-Projekt, Kosten je Katalog-Projekt, erzwungene Projektwahl. Nur lesend gegenüber der Quelle.
import type { SeatmeterPlugin } from '../plugin.js';
import { projektwahlRouten } from './projektwahl.js';
import { katalogPushRouten } from './push.js';
import { katalogRouten } from './routen.js';
import { syncJob } from './sync.js';
import { katalogDateiRoute, katalogTokenRouten } from './upload.js';

export { AUDIT_KATALOG } from './audit.js';
export * from './daten.js';
export * from './importieren.js';
export * from './kosten.js';
export * from './link.js';
export * from './quelle.js';
export * from './stufe.js';
export * from './sync.js';
export { katalogPushRouten } from './push.js';
export { projektwahlPruefRoute, projektwahlRouten } from './projektwahl.js';
export { katalogRouten } from './routen.js';
export { katalogDateiRoute, katalogTokenRouten } from './upload.js';

export const projektkatalogPlugin: SeatmeterPlugin = {
  name: 'kern-projektkatalog',
  routen: (app, ctx) => {
    katalogRouten(app, ctx);
    katalogTokenRouten(app, ctx);
    katalogDateiRoute(app, ctx);
    katalogPushRouten(app, ctx);
    projektwahlRouten(app, ctx);
  },
  jobs: [
    {
      // Stündlich zur Minute 25: Alarm bei ausbleibender Synchronisation, optional Deaktivieren, Tageszeilen im Audit.
      name: 'projektkatalog.sync',
      zeitplan: '25 * * * *',
      ausfuehren: (ctx) => syncJob(ctx),
    },
  ],
};
