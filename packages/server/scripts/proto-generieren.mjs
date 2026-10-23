// Erzeugt src/ingest-otlp/otlp-proto.generiert.ts aus den vendorten opentelemetry-proto-Dateien unter
// proto/ (Apache-2.0, siehe proto/README.md). Aufruf im Container, danach Prettier:
//   node packages/server/scripts/proto-generieren.mjs && pnpm exec prettier --write packages/server/src/ingest-otlp/otlp-proto.generiert.ts
// Der Test `test/otlp-proto.test.ts` prüft, dass die erzeugte Datei zu den .proto-Dateien passt.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const basis = fileURLToPath(new URL('..', import.meta.url));
const protoDir = path.join(basis, 'proto');
const ziel = path.join(basis, 'src', 'ingest-otlp', 'otlp-proto.generiert.ts');

export const OTLP_DATEIEN = [
  'opentelemetry/proto/collector/logs/v1/logs_service.proto',
  'opentelemetry/proto/collector/metrics/v1/metrics_service.proto',
];

const root = new protobuf.Root();
root.resolvePath = (_herkunft, datei) => path.join(protoDir, datei);
root.loadSync(OTLP_DATEIEN, { keepCase: false });
root.resolveAll();

const inhalt = `// Automatisch erzeugt von scripts/proto-generieren.mjs aus proto/ (opentelemetry-proto v1.11.1,
// Apache-2.0, Copyright The OpenTelemetry Authors). Nicht von Hand ändern.
import type { INamespace } from 'protobufjs';

// toJSON() enthält Zusatzfelder (z. B. protoName), die INamespace nicht kennt.
export const OTLP_DESCRIPTOR = ${JSON.stringify(root.toJSON())} as unknown as INamespace;
`;
writeFileSync(ziel, inhalt);
console.log(`geschrieben: ${path.relative(basis, ziel)}`);
