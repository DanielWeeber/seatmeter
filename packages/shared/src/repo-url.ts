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

/**
 * Form, unter der der Ingest ein Repo speichert. `normalisiereRepoUrl` ist für scp-Remotes nicht idempotent: Ein Umlaut,
 * `..`, `{}`, `"`, ein Backslash oder ein IDN-Host bleiben im ersten Durchlauf stehen und ändern sich erst, wenn die
 * `https://`-Form durch `new URL` läuft. Genau das passiert im Ingest, also hier auch: wiederholen, bis nichts mehr ändert.
 * Bleibt eine Form ohne gültige URL (`new URL` scheitert), gilt der letzte Stand.
 */
export function kanonischeRepoInfo(roh: string): RepoInfo | null {
  let info = normalisiereRepoUrl(roh);
  for (let i = 0; info && i < 3; i += 1) {
    const weiter = normalisiereRepoUrl(info.urlNorm);
    if (!weiter || weiter.urlNorm === info.urlNorm) break;
    info = weiter;
  }
  return info;
}

/** Bestandteile einer schon normalisierten URL (`https://host/pfad`), ohne sie noch einmal zu verändern. */
export function repoInfoAusUrlNorm(urlNorm: string): RepoInfo | null {
  const treffer = /^https:\/\/([^/]+)\/(.+)$/.exec(urlNorm);
  if (!treffer || treffer[1] === undefined || treffer[2] === undefined) return null;
  const host = treffer[1].replace(/:\d+$/, '');
  const teile = treffer[2].split('/');
  const repoName = teile[teile.length - 1] ?? '';
  if (repoName === '') return null;
  return {
    urlNorm,
    host,
    owner: teile.length > 1 ? teile.slice(0, -1).join('/') : null,
    repoName,
    provider: erkenneProvider(host),
  };
}

// ---------------------------------------------------------------------------------------------
// Ordner ohne Git-Remote

/**
 * Präfix des Ordner-Schlüssels, den der verwaltete Hook nur für Ordner ohne Git-Remote sendet:
 * `local-<Pfad relativ zum Home-Ordner>` (außerhalb davon nur der letzte Ordnername, im Home-Ordner selbst `~`).
 * Normalisierte Remote-URLs beginnen immer mit `https://`, Pfad-Projekte des Agenten mit `pfad:`; ein Ordner-Schlüssel
 * kann deshalb nie mit einem Repo zusammenfallen oder aus einer Remote-URL entstehen.
 */
export const ORDNER_PRAEFIX = 'local-';
/** Höchstlänge des Pfads hinter dem Präfix. */
export const ORDNER_PFAD_MAX = 1000;

export function istOrdnerSchluessel(urlNorm: string | null | undefined): urlNorm is string {
  return typeof urlNorm === 'string' && urlNorm.startsWith(ORDNER_PRAEFIX);
}

/**
 * Prüft einen gemeldeten Ordner-Schlüssel und gibt ihn unverändert zurück, sonst `null`. Abgelehnt wird alles, was
 * nach absolutem Pfad (`/…`, `~/…`), Laufwerk, Backslash, Steuer- oder unsichtbaren Zeichen oder `.`/`..`-Teilen aussieht: Der Hook schickt nur relative
 * Pfade ohne solche Teile, und ein absoluter Pfad soll auch von einem fremden Absender nie gespeichert werden.
 */
export function ordnerSchluesselPruefen(roh: string): string | null {
  if (!istOrdnerSchluessel(roh)) return null;
  const pfad = roh.slice(ORDNER_PRAEFIX.length);
  if (pfad === '' || pfad.length > ORDNER_PFAD_MAX) return null;
  if (pfad === '~') return roh;
  // Steuerzeichen (auch C1), Zeilentrenner, Nullbreite und Richtungswechsel: Sie verfälschten die Anzeige.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\\]/.test(pfad))
    return null;
  if (pfad.startsWith('/') || pfad.startsWith('~/') || /^[a-z]:/i.test(pfad)) return null;
  if (pfad.split('/').some((t) => t === '' || t === '.' || t === '..')) return null;
  return roh;
}

/** Anzeigename eines Ordner-Projekts: `Ordner <Pfad>`. */
export function ordnerAnzeigename(schluessel: string): string {
  return `Ordner ${schluessel.slice(ORDNER_PRAEFIX.length)}`;
}
