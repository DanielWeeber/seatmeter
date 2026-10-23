// Normalisierung der Git-Remote-URL (Architektur §3.3).
// Ziel: dieselbe Form wie Claude Code in `vcs.repository.url.full` – klein geschrieben, ohne `.git`,
// ohne Zugangsdaten, Query und Fragment. SSH-Formen (scp-Stil und `ssh://host:port/`) werden auf
// `https://host/pfad` abgebildet, damit HTTPS- und SSH-Klone dasselbe Projekt ergeben.
// Abweichungen zur echten Claude-Code-Ausgabe fängt `projekt_alias` ab (Architektur §12, Punkt 6).

export type RepoProvider = 'github' | 'gitlab' | 'gitea' | 'unknown';

export interface RepoInfo {
  /** Normalisierte URL, z. B. `https://github.com/owner/repo`. */
  urlNorm: string;
  host: string;
  /** Alle Pfadteile außer dem letzten (GitLab-Untergruppen bleiben erhalten). */
  owner: string | null;
  repoName: string;
  provider: RepoProvider;
}

const SCP_FORM = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

export function erkenneProvider(host: string): RepoProvider {
  const h = host.toLowerCase();
  if (h === 'github.com' || h.includes('github')) return 'github';
  if (h === 'gitlab.com' || h.includes('gitlab')) return 'gitlab';
  if (h.includes('gitea') || h.includes('forgejo') || h === 'codeberg.org') return 'gitea';
  return 'unknown';
}

/**
 * Normalisiert eine `remote.origin.url`. Gibt `null` zurück, wenn die Angabe kein entferntes
 * Repo beschreibt (leer, lokaler Pfad, `file://`).
 */
export function normalisiereRepoUrl(roh: string): RepoInfo | null {
  const eingabe = roh.trim();
  if (eingabe === '') return null;

  let host: string;
  let port: string | null = null;
  let pfad: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(eingabe)) {
    let url: URL;
    try {
      url = new URL(eingabe);
    } catch {
      return null;
    }
    const schema = url.protocol.replace(/:$/, '').toLowerCase();
    if (schema === 'file') return null;
    host = url.hostname;
    // SSH- und git-Ports gehören nicht zur Identität des Repos, HTTP(S)-Ports schon.
    if ((schema === 'https' || schema === 'http') && url.port !== '') port = url.port;
    pfad = url.pathname;
  } else {
    const treffer = SCP_FORM.exec(eingabe);
    if (!treffer || treffer[1] === undefined || treffer[2] === undefined) return null;
    // Windows-Laufwerk (`C:\…`) ist kein Remote.
    if (/^[a-z]$/i.test(treffer[1])) return null;
    host = treffer[1];
    pfad = treffer[2];
  }

  pfad = pfad.split(/[?#]/, 1)[0] ?? '';
  const teile = pfad
    .split('/')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (teile.length === 0 || host === '') return null;

  const letzter = teile.length - 1;
  teile[letzter] = (teile[letzter] ?? '').replace(/\.git$/i, '');
  if (teile[letzter] === '') return null;

  const hostKlein = host.toLowerCase();
  const pfadKlein = teile.map((t) => t.toLowerCase());
  const hostMitPort = port ? `${hostKlein}:${port}` : hostKlein;
  const repoName = pfadKlein[pfadKlein.length - 1] ?? '';
  const owner = pfadKlein.length > 1 ? pfadKlein.slice(0, -1).join('/') : null;

  return {
    urlNorm: `https://${hostMitPort}/${pfadKlein.join('/')}`,
    host: hostKlein,
    owner,
    repoName,
    provider: erkenneProvider(hostKlein),
  };
}
