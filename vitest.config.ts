// Vitest für das Monorepo: ein Projekt je Paket plus die Grenzprüfung unter tests/.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared', 'packages/server', 'packages/web', 'packages/agent', 'tests'],
  },
});
