// OTLP-Kodierung: Protobuf (protobufjs mit dem erzeugten Deskriptor) und JSON landen in derselben
// JS-Form (camelCase-Feldnamen, int64 als String), damit die Auswertung nur eine Form kennt.
import protobuf from 'protobufjs';
import { OTLP_DESCRIPTOR } from './otlp-proto.generiert.js';

const root = protobuf.Root.fromJSON(OTLP_DESCRIPTOR);

const TYPEN = {
  logsAnfrage: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest'),
  logsAntwort: root.lookupType('opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse'),
  metrikenAnfrage: root.lookupType(
    'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest',
  ),
  metrikenAntwort: root.lookupType(
    'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse',
  ),
};

// google.rpc.Status für Fehlerkörper (OTLP/HTTP-Spezifikation), nicht Teil von opentelemetry-proto.
const STATUS = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        rpc: {
          nested: {
            Status: {
              fields: { code: { type: 'int32', id: 1 }, message: { type: 'string', id: 2 } },
            },
          },
        },
      },
    },
  },
}).lookupType('google.rpc.Status');

export type OtlpArt = 'logs' | 'metrics';
export type OtlpFormat = 'protobuf' | 'json';

const UMWANDLUNG: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  bytes: String,
  defaults: false,
  arrays: true,
};

/** Dekodiert einen Protobuf-Körper in die OTLP/JSON-Form; wirft bei ungültigen Daten. */
export function protobufDekodieren(art: OtlpArt, daten: Uint8Array): Record<string, unknown> {
  const typ = art === 'logs' ? TYPEN.logsAnfrage : TYPEN.metrikenAnfrage;
  return typ.toObject(typ.decode(daten), UMWANDLUNG);
}

/** Kodiert eine Anfrage in OTLP/JSON-Form als Protobuf (für Tests und Fixtures). */
export function protobufKodieren(art: OtlpArt, objekt: Record<string, unknown>): Uint8Array {
  const typ = art === 'logs' ? TYPEN.logsAnfrage : TYPEN.metrikenAnfrage;
  return typ.encode(typ.fromObject(objekt)).finish();
}

/** Antwortkörper `Export*ServiceResponse`; `partialSuccess` nur bei abgelehnten Datensätzen. */
export function antwortKodieren(
  art: OtlpArt,
  format: OtlpFormat,
  abgelehnt: number,
  meldung: string,
): Uint8Array | Record<string, unknown> {
  const feld = art === 'logs' ? 'rejectedLogRecords' : 'rejectedDataPoints';
  const objekt: Record<string, unknown> =
    abgelehnt > 0 ? { partialSuccess: { [feld]: String(abgelehnt), errorMessage: meldung } } : {};
  if (format === 'json') return objekt;
  const typ = art === 'logs' ? TYPEN.logsAntwort : TYPEN.metrikenAntwort;
  return typ.encode(typ.fromObject(objekt)).finish();
}

/** gRPC-Statuscodes passend zum HTTP-Status (OTLP/HTTP verlangt `google.rpc.Status` als Fehlerkörper). */
const GRPC_CODE: Record<number, number> = {
  400: 3,
  401: 16,
  413: 8,
  415: 3,
  429: 8,
  500: 13,
  503: 14,
};

export function fehlerKodieren(
  format: OtlpFormat,
  status: number,
  meldung: string,
): Uint8Array | Record<string, unknown> {
  const objekt = { code: GRPC_CODE[status] ?? 2, message: meldung };
  if (format === 'json') return objekt;
  return STATUS.encode(STATUS.fromObject(objekt)).finish();
}
