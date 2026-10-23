// Statische Auslieferung des Dashboards (packages/web/dist) durch den Server selbst, damit ein Container genügt.
// Aktiv nur mit SEATMETER_WEB_DIST. Wird als letzte Route registriert: alle Modulrouten gehen vor, weil der Router
// feste Pfade immer vor dem Platzhalter `/*` wählt. Pfade unter /api und /otlp bekommen nie die SPA, sondern 404 (JSON).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const INHALTSTYPEN: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Recharts setzt Inline-Styles, daher `style-src 'unsafe-inline'`; Skripte nur aus eigener Herkunft. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Pfade, die nie die SPA ausliefern (API, Ingest). */
export function istServerPfad(pfad: string): boolean {
  return /^\/(api|otlp)(\/|$)/.test(pfad);
}

async function istDatei(datei: string): Promise<boolean> {
  try {
    return (await stat(datei)).isFile();
  } catch {
    return false;
  }
}

/** Löst einen URL-Pfad sicher innerhalb der Wurzel auf; `null` bei ungültigem Pfad oder Ausbruchsversuch. */
export function loesePfad(wurzel: string, urlPfad: string): string | null {
  let pfad: string;
  try {
    pfad = decodeURIComponent(urlPfad);
  } catch {
    return null;
  }
  if (pfad.includes('\0')) return null;
  const ziel = path.resolve(wurzel, `.${path.posix.normalize(`/${pfad}`)}`);
  if (ziel !== wurzel && !ziel.startsWith(wurzel + path.sep)) return null;
  return ziel;
}

function sende(antwort: FastifyReply, datei: string, unveraenderlich: boolean): FastifyReply {
  const typ = INHALTSTYPEN[path.extname(datei).toLowerCase()] ?? 'application/octet-stream';
  antwort
    .header('content-type', typ)
    .header('x-content-type-options', 'nosniff')
    .header(
      'cache-control',
      unveraenderlich ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate',
    );
  if (typ.startsWith('text/html')) {
    antwort
      .header('content-security-policy', CSP)
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY');
  }
  return antwort.send(createReadStream(datei));
}

/**
 * Registriert GET/HEAD `/*` für das Dashboard-Build in `verzeichnis`.
 * - vorhandene Datei → Datei (`/assets/*` mit Hash im Namen: ein Jahr Cache, sonst `no-cache`)
 * - Pfad mit Dateiendung, aber keine Datei → 404
 * - sonst → `index.html` (Client-Routing der SPA)
 */
export async function statischesWeb(app: FastifyInstance, verzeichnis: string): Promise<void> {
  const wurzel = path.resolve(verzeichnis);
  const index = path.join(wurzel, 'index.html');
  if (!(await istDatei(index))) {
    throw new Error(`SEATMETER_WEB_DIST: ${wurzel} enthält keine index.html`);
  }

  app.get('/*', async (anfrage, antwort) => {
    const pfad = (anfrage.url.split('?', 1)[0] ?? '/') || '/';
    if (istServerPfad(pfad)) {
      return antwort.code(404).send({ fehler: 'nicht gefunden' });
    }
    const ziel = loesePfad(wurzel, pfad);
    if (ziel === null) return antwort.code(400).send({ fehler: 'ungültiger Pfad' });
    if (ziel !== wurzel && (await istDatei(ziel))) {
      return sende(antwort, ziel, pfad.startsWith('/assets/'));
    }
    if (path.extname(pfad) !== '') {
      return antwort.code(404).send({ fehler: 'nicht gefunden' });
    }
    return sende(antwort, index, false);
  });
}
