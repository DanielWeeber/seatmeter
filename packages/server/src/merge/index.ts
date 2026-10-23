// Modul merge: Job `merge.ab` (alle 5 min, Einmallauf `--einmal merge.ab`); keine Routen.
import type { SeatmeterPlugin } from '../plugin.js';
import { mergeJob } from './job.js';

export * from './job.js';

export const mergePlugin: SeatmeterPlugin = {
  name: 'kern-merge',
  jobs: [{ name: 'merge.ab', zeitplan: '*/5 * * * *', ausfuehren: (ctx) => mergeJob(ctx) }],
};
