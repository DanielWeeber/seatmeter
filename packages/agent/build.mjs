// Bündelt die CLI in eine Datei (Architektur §2.2), lauffähig mit Node ≥ 22 ohne weitere Pakete.
// Einzeldatei-Binary (bun --compile / Node SEA): siehe packages/agent/README.md, Abschnitt Binary.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/seatmeter-agent.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'info',
});
