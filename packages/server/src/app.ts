// App-Fabrik: Fastify 5 mit pino-Logging ohne Körper, Attribute, Header-Werte oder IP-Adressen.
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Konfiguration } from './config.js';
import type { Db } from './db/db.js';
import { authGrundlage } from './auth/index.js';
import { healthRouten } from './health/routes.js';
import { KERN_MODULE } from './kern.js';
import { registrierePlugins, type PluginRegister, type SeatmeterPlugin } from './plugin.js';
import { statischesWeb } from './static/index.js';

export interface AppOptionen {
  konfiguration: Konfiguration;
  db: Db;
  /** Zusätzliche Plugins (ee); die Kern-Module aus `kern.ts` kommen immer davor. */
  plugins?: readonly SeatmeterPlugin[];
  /** Für Tests: eigener Log-Zielstrom. */
  logStream?: NodeJS.WritableStream;
}

/** Nur Methode, Pfad ohne Query und Request-ID; nie Körper, Header oder Adressen. */
export const logSerializer: NonNullable<
  Exclude<FastifyServerOptions['logger'], boolean | undefined>
> = {
  serializers: {
    req: (anfrage: { id?: string; method?: string; url?: string }) => ({
      id: anfrage.id,
      method: anfrage.method,
      // Einladungslinks (`/einladung/<token>`, Modul konten) tragen ein Geheimnis im Pfad: nie ins Log.
      path: (anfrage.url ?? '').split('?', 1)[0]?.replace(/^\/einladung\/[^/]+/, '/einladung/…'),
    }),
    res: (antwort: { statusCode?: number }) => ({ statusCode: antwort.statusCode }),
  },
};

declare module 'fastify' {
  interface FastifyInstance {
    /** Von den Plugins gesammelte Jobs, Auth-Provider und Navigation. */
    seatmeter: PluginRegister;
    /** Jobs der Kern-Module (aggregation, aufbewahrung, …). */
    seatmeterKernJobs: PluginRegister['jobs'];
  }
}

export async function erstelleApp(optionen: AppOptionen): Promise<FastifyInstance> {
  // Anzahl der Proxy-Stufen als Funktion (die ersten n Adressen der Kette sind vertrauenswürdig).
  const tp = optionen.konfiguration.SEATMETER_TRUST_PROXY;
  const app = Fastify({
    logger: {
      level: optionen.konfiguration.LOG_LEVEL,
      ...logSerializer,
      ...(optionen.logStream ? { stream: optionen.logStream } : {}),
    },
    bodyLimit: 4 * 1024 * 1024,
    // Client-IP (Ratenlimits, Anmelde-Sperre) nur hinter konfiguriertem Proxy aus X-Forwarded-For.
    trustProxy: typeof tp === 'number' ? (_adresse: string, stufe: number) => stufe < tp : tp,
  });

  healthRouten(app, optionen.db);
  const ctx = { db: optionen.db, konfiguration: optionen.konfiguration };
  let pluginProvider: PluginRegister['authProvider'] = [];
  let erweiterungen: PluginRegister['auth'] = [];
  await authGrundlage(
    app,
    ctx,
    () => pluginProvider,
    () => erweiterungen,
  );
  const kern = await registrierePlugins(app, KERN_MODULE, ctx);
  const register = await registrierePlugins(app, optionen.plugins ?? [], ctx);
  pluginProvider = [...kern.authProvider, ...register.authProvider];
  erweiterungen = [...kern.auth, ...register.auth];
  app.decorate('seatmeter', register);
  app.decorate('seatmeterKernJobs', kern.jobs);
  // Zuletzt: Dashboard-Auslieferung mit SPA-Rückfall (nur mit SEATMETER_WEB_DIST).
  const webDist = optionen.konfiguration.SEATMETER_WEB_DIST;
  if (webDist) await statischesWeb(app, webDist);
  await app.ready();
  return app;
}
