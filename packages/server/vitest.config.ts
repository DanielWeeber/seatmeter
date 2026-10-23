// Server-Tests laufen gegen echte Postgres 18 (compose.dev.yml bzw. CI-Dienst).
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const shared = (pfad: string) => fileURLToPath(new URL(`../shared/src/${pfad}`, import.meta.url));

export default defineProject({
  resolve: {
    alias: [
      { find: /^@seatmeter\/shared\/hmac$/, replacement: shared('hmac.ts') },
      { find: /^@seatmeter\/shared$/, replacement: shared('index.ts') },
    ],
  },
  test: {
    name: 'server',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 90_000,
  },
});
