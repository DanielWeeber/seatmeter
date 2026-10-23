// Routen `POST /otlp/v1/logs` und `POST /otlp/v1/metrics` (OTLP/HTTP, Protobuf und JSON).
// Eigener Fastify-Kontext: eigene Körper-Parser (inkl. gzip), Token-Prüfung vor dem Lesen des Körpers.
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.js';
import type { IngestRatenlimit } from '../ingest-gemeinsam/ratenlimit.js';
import {
  istDbNichtErreichbar,
  RETRY_AFTER_SEKUNDEN,
  zugangsHook,
  zugangVon,
} from '../ingest-gemeinsam/zugang.js';
import {
  antwortKodieren,
  fehlerKodieren,
  protobufDekodieren,
  type OtlpArt,
  type OtlpFormat,
} from './protobuf.js';
import { logsVerarbeiten, metrikenVerarbeiten } from './verarbeiten.js';

export const OTLP_KOERPER_MAX = 4 * 1024 * 1024;
/** Obergrenze nach dem Entpacken (Schutz vor gzip-Bomben). */
const ENTPACKT_MAX = 16 * 1024 * 1024;

export interface OtlpOptionen {
  db: Db;
  masterKey: Buffer;
  /** Ratenlimits (je IP, Fehlversuche, je Token mit Mandanten-Grenze), gemeinsam mit den Agent-Routen. */
  ratenlimit: IngestRatenlimit;
}

function formatVon(anfrage: FastifyRequest): OtlpFormat {
  return String(anfrage.headers['content-type'] ?? '').startsWith('application/json')
    ? 'json'
    : 'protobuf';
}

function senden(
  antwort: FastifyReply,
  format: OtlpFormat,
  status: number,
  koerper: Uint8Array | Record<string, unknown>,
): FastifyReply {
  antwort.code(status);
  if (format === 'json') return antwort.type('application/json').send(koerper);
  return antwort.type('application/x-protobuf').send(Buffer.from(koerper as Uint8Array));
}

function fehler(antwort: FastifyReply, status: number, meldung: string): FastifyReply {
  return senden(
    antwort,
    formatVon(antwort.request),
    status,
    fehlerKodieren(formatVon(antwort.request), status, meldung),
  );
}

class KoerperFehler extends Error {}

function entpacken(anfrage: FastifyRequest, roh: Buffer): Buffer {
  const kodierung = String(anfrage.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (kodierung === 'identity' || kodierung === '') return roh;
  if (kodierung !== 'gzip')
    throw new KoerperFehler(`Content-Encoding ${kodierung} wird nicht unterstützt`);
  try {
    return gunzipSync(roh, { maxOutputLength: ENTPACKT_MAX });
  } catch {
    throw new KoerperFehler('gzip-Körper ungültig oder zu groß');
  }
}

function dekodieren(art: OtlpArt, format: OtlpFormat, roh: Buffer): Record<string, unknown> {
  let objekt: unknown;
  try {
    objekt = format === 'json' ? JSON.parse(roh.toString('utf8')) : protobufDekodieren(art, roh);
  } catch {
    throw new KoerperFehler(
      `Körper ist kein gültiges OTLP/${format === 'json' ? 'JSON' : 'Protobuf'}`,
    );
  }
  const liste = art === 'logs' ? 'resourceLogs' : 'resourceMetrics';
  if (
    typeof objekt !== 'object' ||
    objekt === null ||
    Array.isArray(objekt) ||
    ((objekt as Record<string, unknown>)[liste] !== undefined &&
      !Array.isArray((objekt as Record<string, unknown>)[liste]))
  ) {
    throw new KoerperFehler(
      `Körper hat nicht die Form von Export${art === 'logs' ? 'Logs' : 'Metrics'}ServiceRequest`,
    );
  }
  return objekt as Record<string, unknown>;
}

export async function otlpRouten(app: FastifyInstance, optionen: OtlpOptionen): Promise<void> {
  await app.register(async (kind) => {
    // Rohkörper als Buffer; Dekodierung im Handler, damit Fehler als OTLP-Status antworten.
    kind.removeAllContentTypeParsers();
    const roh = (
      _a: FastifyRequest,
      koerper: Buffer,
      fertig: (e: Error | null, b?: Buffer) => void,
    ) => fertig(null, koerper);
    kind.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: OTLP_KOERPER_MAX },
      roh,
    );
    kind.addContentTypeParser(
      'application/x-protobuf',
      { parseAs: 'buffer', bodyLimit: OTLP_KOERPER_MAX },
      roh,
    );

    kind.addHook(
      'onRequest',
      zugangsHook({
        db: optionen.db,
        typen: ['mandant', 'rechner'],
        ratenlimit: optionen.ratenlimit,
        gruppe: 'otlp',
        quelle: 'a',
        fehlerAntwort: fehler,
      }),
    );

    // Fehler aus Fastify selbst (z. B. 413, 415) ebenfalls im OTLP-Format beantworten.
    kind.setErrorHandler((err: Error & { statusCode?: number }, anfrage, antwort) => {
      const status =
        err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      if (status === 500)
        anfrage.log.error({ fehlerart: err.name }, 'OTLP-Verarbeitung fehlgeschlagen');
      return fehler(antwort, status, status === 500 ? 'Interner Fehler' : err.message);
    });

    const handler = (art: OtlpArt) => async (anfrage: FastifyRequest, antwort: FastifyReply) => {
      const format = formatVon(anfrage);
      let koerper: Record<string, unknown>;
      try {
        koerper = dekodieren(art, format, entpacken(anfrage, anfrage.body as Buffer));
      } catch (f) {
        if (f instanceof KoerperFehler) return fehler(antwort, 400, f.message);
        throw f;
      }
      try {
        const zugang = zugangVon(anfrage);
        const ergebnis =
          art === 'logs'
            ? await logsVerarbeiten(optionen.db, optionen.masterKey, zugang, koerper)
            : await metrikenVerarbeiten(optionen.db, optionen.masterKey, zugang, koerper);
        return senden(
          antwort,
          format,
          200,
          antwortKodieren(art, format, ergebnis.abgelehnt, ergebnis.meldung),
        );
      } catch (f) {
        if (istDbNichtErreichbar(f)) {
          antwort.header('retry-after', String(RETRY_AFTER_SEKUNDEN));
          return fehler(antwort, 503, 'Datenbank nicht erreichbar, bitte später erneut senden');
        }
        // Nur die Fehlerart loggen, nie Körper oder Attribute.
        anfrage.log.error(
          { fehlerart: (f as Error).name, code: (f as { code?: string }).code },
          'OTLP-Verarbeitung fehlgeschlagen',
        );
        return fehler(antwort, 500, 'Interner Fehler');
      }
    };

    kind.post('/otlp/v1/logs', handler('logs'));
    kind.post('/otlp/v1/metrics', handler('metrics'));
  });
}
