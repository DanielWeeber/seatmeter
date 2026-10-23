// Agent-Tests: synthetische Transkripte unter test/fixtures, Server über gefälschtes fetch.
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const shared = (pfad: string) => fileURLToPath(new URL(`../shared/src/${pfad}`, import.meta.url));

export default defineProject({
  resolve: {
    alias: [{ find: /^@seatmeter\/shared$/, replacement: shared('index.ts') }],
  },
  test: {
    name: 'agent',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
