// Rechner-Token (`smr_…`): macOS-Schlüsselbund über `security` (Token nur über stdin, nie als
// Argument), sonst Datei ~/.seatmeter/token mit Rechten 0600. `SEATMETER_TOKEN_DATEI=1` erzwingt
// die Datei (Tests, Rechner ohne Schlüsselbund).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RECHNER_TOKEN_PRAEFIX } from '@seatmeter/shared';
import { schreibeAtomar } from './dateien.js';
import type { Umgebung } from './umgebung.js';

export const SCHLUESSELBUND_DIENST = 'seatmeter-agent';
const SCHLUESSELBUND_KONTO = 'rechner-token';
const SECURITY = '/usr/bin/security';

export type TokenSpeicher = 'schluesselbund' | 'datei';

const pfadToken = (u: Umgebung) => join(u.agentDir, 'token');

function schluesselbundNutzbar(u: Umgebung): boolean {
  return u.plattform === 'darwin' && u.env.SEATMETER_TOKEN_DATEI !== '1' && existsSync(SECURITY);
}

export function speichereToken(u: Umgebung, token: string): TokenSpeicher {
  if (!token.startsWith(RECHNER_TOKEN_PRAEFIX) || /\s|"/.test(token)) {
    throw new Error('Rechner-Token hat ein unerwartetes Format');
  }
  if (schluesselbundNutzbar(u)) {
    try {
      execFileSync(SECURITY, ['-i'], {
        input: `add-generic-password -U -s ${SCHLUESSELBUND_DIENST} -a ${SCHLUESSELBUND_KONTO} -w ${token}\n`,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 10_000,
      });
      if (ladeAusSchluesselbund() === token) {
        rmSync(pfadToken(u), { force: true });
        return 'schluesselbund';
      }
    } catch {
      // weiter mit Datei
    }
  }
  schreibeAtomar(pfadToken(u), `${token}\n`, 0o600);
  return 'datei';
}

function ladeAusSchluesselbund(): string | null {
  try {
    const t = execFileSync(
      SECURITY,
      ['find-generic-password', '-s', SCHLUESSELBUND_DIENST, '-a', SCHLUESSELBUND_KONTO, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    ).trim();
    return t.startsWith(RECHNER_TOKEN_PRAEFIX) ? t : null;
  } catch {
    return null;
  }
}

export function ladeToken(u: Umgebung): { token: string; speicher: TokenSpeicher } | null {
  if (schluesselbundNutzbar(u)) {
    const t = ladeAusSchluesselbund();
    if (t) return { token: t, speicher: 'schluesselbund' };
  }
  try {
    const t = readFileSync(pfadToken(u), 'utf8').trim();
    return t.startsWith(RECHNER_TOKEN_PRAEFIX) ? { token: t, speicher: 'datei' } : null;
  } catch {
    return null;
  }
}

export function loescheToken(u: Umgebung): void {
  if (schluesselbundNutzbar(u)) {
    try {
      execFileSync(
        SECURITY,
        ['delete-generic-password', '-s', SCHLUESSELBUND_DIENST, '-a', SCHLUESSELBUND_KONTO],
        { stdio: 'ignore', timeout: 10_000 },
      );
    } catch {
      // nicht vorhanden
    }
  }
  rmSync(pfadToken(u), { force: true });
}
