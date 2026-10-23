// Protokoll nach ~/.seatmeter/agent.log: nur Zähler, Befehle und Fehlerarten.
// Nie Inhalte, Transkriptpfade, cwd, Tokens oder Server-Antworten mit Werten.
import { renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { haengeAn } from './dateien.js';
import type { Umgebung } from './umgebung.js';

const MAX_GROESSE = 1_000_000;

export interface Logger {
  info(meldung: string, daten?: Record<string, unknown>): void;
  fehler(meldung: string, daten?: Record<string, unknown>): void;
}

export function logger(u: Umgebung, stderr?: (t: string) => void): Logger {
  const datei = join(u.agentDir, 'agent.log');
  const schreibe = (stufe: string, meldung: string, daten?: Record<string, unknown>) => {
    const zeile = `${u.jetzt().toISOString()} ${stufe} ${meldung}${daten ? ` ${JSON.stringify(daten)}` : ''}\n`;
    try {
      if ((statSync(datei, { throwIfNoEntry: false })?.size ?? 0) > MAX_GROESSE) {
        renameSync(datei, `${datei}.1`);
      }
      haengeAn(datei, zeile);
    } catch {
      // Protokoll ist best effort; der Agent darf daran nie scheitern.
    }
    if (u.verbose && stderr) stderr(zeile);
  };
  return {
    info: (m, d) => schreibe('INFO', m, d),
    fehler: (m, d) => schreibe('FEHLER', m, d),
  };
}
