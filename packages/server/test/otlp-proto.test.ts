import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { klassifizieren, logsAuswerten } from '../src/ingest-otlp/auswertung.js';
import { OTLP_DESCRIPTOR } from '../src/ingest-otlp/otlp-proto.generiert.js';
import { protobufDekodieren, protobufKodieren } from '../src/ingest-otlp/protobuf.js';
import { fixture, TEST_ORG } from './ingest-hilfen.js';

describe('OTLP-Deskriptor und Auswertung (ohne Datenbank)', () => {
  it('der erzeugte Deskriptor passt zu den vendorten .proto-Dateien', () => {
    const protoDir = fileURLToPath(new URL('../proto', import.meta.url));
    const root = new protobuf.Root();
    root.resolvePath = (_herkunft, datei) => path.join(protoDir, datei);
    root.loadSync(
      [
        'opentelemetry/proto/collector/logs/v1/logs_service.proto',
        'opentelemetry/proto/collector/metrics/v1/metrics_service.proto',
      ],
      { keepCase: false },
    );
    root.resolveAll();
    expect(JSON.parse(JSON.stringify(root.toJSON()))).toEqual(OTLP_DESCRIPTOR);
  });

  it('Protobuf-Rundreise ergibt dieselbe JSON-Form', () => {
    const f = fixture('logs-api-request.json');
    const zurueck = protobufDekodieren('logs', protobufKodieren('logs', f));
    const salt = Buffer.alloc(32, 3);
    expect(logsAuswerten(zurueck, salt)).toEqual(logsAuswerten(f, salt));
  });

  it('Allowlist: Inhaltsattribute werden nicht gelesen, nur gezählt', () => {
    const salt = Buffer.alloc(32, 3);
    const a = logsAuswerten(fixture('logs-user-prompt.json'), salt);
    expect(a.anfragen).toEqual([]);
    expect(a.verworfenInhalt).toBe(1);
    expect(a.ignoriert).toBe(1);
    expect(JSON.stringify([...a.meldungen])).not.toContain('GEHEIM');
  });

  it('Abo-Regel nach Architektur §4', () => {
    const salt = Buffer.alloc(32, 3);
    const [api] = logsAuswerten(fixture('logs-api-key.json'), salt).anfragen;
    const [abo] = logsAuswerten(fixture('logs-api-request.json'), salt).anfragen;
    const orgs = new Set([TEST_ORG]);
    expect(klassifizieren(api!, orgs)).toBe('api');
    expect(klassifizieren(abo!, orgs)).toBe('abo');
    expect(klassifizieren(abo!, new Set())).toBe('fremd_org');
    expect(klassifizieren({ ...abo!, identitySource: 'gateway-oidc' }, orgs)).toBe('provider');
    expect(klassifizieren({ ...abo!, orgUuid: null }, orgs)).toBe('unbekannt');
  });
});
