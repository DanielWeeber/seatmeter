// Laufzeit-Umgebung des Agenten: Pfade, Umgebungsvariablen, Uhr, Git- und HTTP-Aufrufe.
// Alles, was Tests ersetzen müssen, läuft über dieses Objekt (keine globalen Pfade im Code).
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Führt `git` mit Argumenten in `cwd` aus; liefert stdout (getrimmt) oder `null` bei Fehler. */
export type GitAufruf = (args: string[], cwd: string) => string | null;

export interface Umgebung {
  home: string;
  /** `CLAUDE_CONFIG_DIR` oder `~/.claude`. */
  claudeDir: string;
  /** `~/.claude.json` (bzw. `$CLAUDE_CONFIG_DIR/.claude.json`). */
  claudeJson: string;
  /** `SEATMETER_HOME` oder `~/.seatmeter`. */
  agentDir: string;
  env: NodeJS.ProcessEnv;
  plattform: NodeJS.Platform;
  jetzt: () => Date;
  git: GitAufruf;
  fetch: typeof fetch;
  verbose: boolean;
}

/** Variablen, die Git aus der Umgebung übernimmt und die das Ergebnis verfälschen (CCAM `git-env`). */
const GIT_VARIABLEN = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

/** Umgebung für Git-Aufrufe ohne `GIT_*`-Variablen, die ein Hook-Prozess geerbt haben kann. */
export function bereinigteGitUmgebung(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sauber: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (
      GIT_VARIABLEN.includes(k) ||
      k.startsWith('GIT_CONFIG_KEY_') ||
      k.startsWith('GIT_CONFIG_VALUE_')
    )
      continue;
    sauber[k] = v;
  }
  sauber.GIT_TERMINAL_PROMPT = '0';
  sauber.GIT_OPTIONAL_LOCKS = '0';
  return sauber;
}

export function echterGit(env: NodeJS.ProcessEnv): GitAufruf {
  const sauber = bereinigteGitUmgebung(env);
  return (args, cwd) => {
    try {
      return execFileSync('git', args, {
        cwd,
        env: sauber,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
    } catch {
      return null;
    }
  };
}

export function standardUmgebung(env: NodeJS.ProcessEnv = process.env, verbose = false): Umgebung {
  const home = env.HOME && env.HOME !== '' ? env.HOME : homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(home, '.claude');
  return {
    home,
    claudeDir,
    claudeJson: env.CLAUDE_CONFIG_DIR
      ? join(env.CLAUDE_CONFIG_DIR, '.claude.json')
      : join(home, '.claude.json'),
    agentDir: env.SEATMETER_HOME ? env.SEATMETER_HOME : join(home, '.seatmeter'),
    env,
    plattform: process.platform,
    jetzt: () => new Date(),
    git: echterGit(env),
    fetch: globalThis.fetch.bind(globalThis),
    verbose,
  };
}
