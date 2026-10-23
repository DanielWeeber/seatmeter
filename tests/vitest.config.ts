import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'grenze', include: ['*.test.ts'], testTimeout: 60_000 },
});
