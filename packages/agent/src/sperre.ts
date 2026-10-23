// Einfache Dateisperre (O_EXCL), damit Hook und Sweeper nicht gleichzeitig scannen oder pushen.
// Eine Sperre älter als 2 Minuten gilt als verwaist (abgestürzter Prozess) und wird übernommen.
import { closeSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { verzeichnisSicherstellen } from './dateien.js';
import type { Umgebung } from './umgebung.js';

const VERWAIST_MS = 120_000;

export async function mitSperre<T>(
  u: Umgebung,
  fn: () => Promise<T>,
  wartenMs = 5_000,
): Promise<T | 'gesperrt'> {
  verzeichnisSicherstellen(u.agentDir);
  const pfad = join(u.agentDir, 'lock');
  const ende = Date.now() + wartenMs;
  for (;;) {
    try {
      const fd = openSync(pfad, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch {
      const st = statSync(pfad, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > VERWAIST_MS) {
        rmSync(pfad, { force: true });
        continue;
      }
      if (Date.now() >= ende) return 'gesperrt';
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(pfad, { force: true });
  }
}
