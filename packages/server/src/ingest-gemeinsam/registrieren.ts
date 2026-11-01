// Registriert die Module ingest-otlp, ingest-agent und enrollment als Kern-Modul (Eintrag in `kern.ts`).
import type { FastifyInstance } from 'fastify';
import { enrollmentRouten } from '../enrollment/routes.js';
import { agentIngestRouten } from '../ingest-agent/routes.js';
import { otlpRouten } from '../ingest-otlp/routes.js';
import type { PluginKontext, SeatmeterPlugin } from '../plugin.js';
import { projektwahlPruefRoute } from '../projektkatalog/projektwahl.js';
import { IngestRatenlimit, ratenlimitOptionen } from './ratenlimit.js';

export async function ingestModuleRegistrieren(
  app: FastifyInstance,
  ctx: PluginKontext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;
  // Ein gemeinsamer Satz Ratenlimits für alle Ingest-Pfade (der Eimer je IP gilt pfadübergreifend).
  const ratenlimit = new IngestRatenlimit(ratenlimitOptionen(ctx.konfiguration));
  await otlpRouten(app, { db: ctx.db, masterKey, ratenlimit });
  await agentIngestRouten(app, { db: ctx.db, masterKey, ratenlimit });
  await projektwahlPruefRoute(app, {
    db: ctx.db,
    masterKey,
    ratenlimit,
    konfiguration: ctx.konfiguration,
    env,
  });
  await enrollmentRouten(app, {
    ctx,
    ingestUrl: env.SEATMETER_INGEST_URL || undefined,
    ratenlimit,
  });
}

export const ingestPlugin: SeatmeterPlugin = {
  name: 'ingest',
  routen: (app, ctx) => ingestModuleRegistrieren(app, ctx),
};
