// Dateihelfer: Agent-Verzeichnis 0700, Dateien 0600, atomares Schreiben (tmp + rename).
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function verzeichnisSicherstellen(pfad: string): void {
  mkdirSync(pfad, { recursive: true, mode: 0o700 });
}

export function leseJson<T>(pfad: string): T | null {
  try {
    return JSON.parse(readFileSync(pfad, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function schreibeAtomar(pfad: string, inhalt: string, modus = 0o600): void {
  verzeichnisSicherstellen(dirname(pfad));
  const tmp = `${pfad}.${process.pid}.tmp`;
  writeFileSync(tmp, inhalt, { mode: modus });
  chmodSync(tmp, modus);
  renameSync(tmp, pfad);
}

export function schreibeJson(pfad: string, wert: unknown): void {
  schreibeAtomar(pfad, `${JSON.stringify(wert, null, 2)}\n`);
}

export function haengeAn(pfad: string, inhalt: string): void {
  verzeichnisSicherstellen(dirname(pfad));
  appendFileSync(pfad, inhalt, { mode: 0o600 });
}
