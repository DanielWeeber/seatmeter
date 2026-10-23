// Modul abgleich (Kern, bis 2026-10-24 ee): Enterprise Analytics API (Key verschlüsselt) und Team-Spend-CSV
// → `ueberschreitung` und `abgleich_lauf`; Job `abgleich.analytics` täglich 05:00 UTC.
import type { Konfiguration } from '../config.js';
import type { SeatmeterPlugin } from '../plugin.js';
import { abgleichJob, type AbgleichOptionen } from './abgleich.js';
import { abgleichRouten } from './routen.js';

export * from './abgleich.js';
export * from './analytics.js';
export * from './csv.js';
export { AUDIT_ABGLEICH } from './routen.js';

/** Basis-URL der Analytics API aus `SEATMETER_ANALYTICS_URL` (nur Tests oder Proxy), sonst Standard. */
function optionen(k: Konfiguration): AbgleichOptionen {
  return k.SEATMETER_ANALYTICS_URL ? { basis: k.SEATMETER_ANALYTICS_URL } : {};
}

export const abgleichPlugin: SeatmeterPlugin = {
  name: 'kern-abgleich',
  routen: (app, ctx) => abgleichRouten(app, ctx, optionen(ctx.konfiguration)),
  jobs: [
    {
      name: 'abgleich.analytics',
      zeitplan: '0 5 * * *',
      ausfuehren: (ctx) => abgleichJob(ctx, optionen(ctx.konfiguration)),
    },
  ],
};
