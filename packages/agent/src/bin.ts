import { main } from './cli.js';

const code = await main(
  process.argv.slice(2),
  {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  },
  { interaktiv: Boolean(process.stdout.isTTY && process.stdin.isTTY) },
);
// Hooks dürfen Claude Code nie blockieren: offene Handles (stdin, Timer) nicht abwarten.
process.exit(code);
