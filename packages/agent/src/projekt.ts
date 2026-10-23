// Projekt-Erkennung im Agenten (Architektur §3.3): je cwd einmal `git rev-parse --show-toplevel`
// und `git config --get remote.origin.url` mit bereinigter Umgebung, dann dieselbe Normalisierung
// wie der Server (`normalisiereRepoUrl` aus @seatmeter/shared). Gesendet wird nur die normalisierte
// URL samt Owner/Name/Provider, nie der lokale Pfad. Das Home-Verzeichnis zählt nicht als Repo.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { normalisiereRepoUrl, type ProjektAngabe, type ProjektMeldung } from '@seatmeter/shared';
import { pfadProjektFuer, type WirksameKonfig } from './konfig.js';
import type { Umgebung } from './umgebung.js';
import type { Zustand } from './zustand.js';

/** Cache-Einträge werden nach einem Tag neu geprüft (Remote kann sich ändern). */
const CACHE_MS = 24 * 3600 * 1000;

/** Höchstens so viele Ebenen nach oben, wenn das cwd nicht mehr existiert. */
const MAX_EBENEN = 8;

/**
 * Toplevel des Repos zum cwd. Existiert das cwd nicht mehr (z. B. gelöschter Worktree eines Agenten unter
 * `<repo>/.claude/worktrees/<name>`), wird der nächste übergeordnete Ordner mit Repo genommen, höchstens bis
 * unterhalb des Home-Verzeichnisses.
 */
function toplevel(u: Umgebung, cwd: string): string | null {
  const direkt = u.git(['rev-parse', '--show-toplevel'], cwd);
  if (direkt || existsSync(cwd)) return direkt;
  const home = resolve(u.home);
  let ordner = resolve(cwd);
  for (let i = 0; i < MAX_EBENEN; i++) {
    const oben = dirname(ordner);
    if (oben === ordner || oben === home || !oben.startsWith(`${home}/`)) return null;
    ordner = oben;
    const top = u.git(['rev-parse', '--show-toplevel'], ordner);
    if (top) return top;
  }
  return null;
}

export function erkenneProjekt(u: Umgebung, cwd: string): ProjektAngabe | null {
  const top = toplevel(u, cwd);
  if (!top) return null;
  if (resolve(top) === resolve(u.home)) return null;
  const url = u.git(['config', '--get', 'remote.origin.url'], top);
  if (!url) return null;
  const info = normalisiereRepoUrl(url);
  if (!info) return null;
  return {
    url_norm: info.urlNorm,
    provider: info.provider,
    owner: info.owner,
    repo_name: info.repoName,
  };
}

/** Repo je cwd mit Cache im Zustand (überlebt gelöschte Arbeitsverzeichnisse). */
export function repoFuer(u: Umgebung, z: Zustand, cwd: string): ProjektAngabe | null {
  const jetzt = u.jetzt();
  const c = z.projekte[cwd];
  if (c && jetzt.getTime() - new Date(c.geprueft).getTime() < CACHE_MS) return c.projekt;
  const projekt = erkenneProjekt(u, cwd);
  // Verschwundenes Verzeichnis: letzten bekannten Stand behalten.
  if (!projekt && c?.projekt) return c.projekt;
  z.projekte[cwd] = { projekt, geprueft: jetzt.toISOString() };
  return projekt;
}

/**
 * Projekt je cwd: Git-Remote zuerst, sonst das Pfad-Projekt aus `pfad_projekte` (längster Präfix),
 * sonst `null` (= „unzugeordnet“). Der Pfad selbst verlässt den Rechner nie.
 */
export function projektFuer(
  u: Umgebung,
  z: Zustand,
  cwd: string,
  k?: Pick<WirksameKonfig, 'pfad_projekte'>,
): ProjektMeldung | null {
  return repoFuer(u, z, cwd) ?? (k ? pfadProjektFuer(cwd, k) : null);
}
