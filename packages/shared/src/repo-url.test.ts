import { describe, expect, it } from 'vitest';
import { kanonischeRepoInfo, normalisiereRepoUrl, repoInfoAusUrlNorm } from './repo-url.js';

describe('normalisiereRepoUrl (Architektur §3.3)', () => {
  const vektoren: Array<[string, string, string | null, string, string]> = [
    // Eingabe, url_norm, owner, repo_name, provider
    [
      'ssh://git@git.example.com:2222/weeberwrk/seatmeter.git',
      'https://git.example.com/weeberwrk/seatmeter',
      'weeberwrk',
      'seatmeter',
      'unknown',
    ],
    ['git@github.com:Owner/Repo.git', 'https://github.com/owner/repo', 'owner', 'repo', 'github'],
    [
      'https://user:pw@github.com/Owner/Repo.git',
      'https://github.com/owner/repo',
      'owner',
      'repo',
      'github',
    ],
    ['https://github.com/Owner/Repo', 'https://github.com/owner/repo', 'owner', 'repo', 'github'],
    [
      'https://github.com/Owner/Repo.git?ref=main#readme',
      'https://github.com/owner/repo',
      'owner',
      'repo',
      'github',
    ],
    [
      'https://gitlab.com/Gruppe/Untergruppe/Projekt.git',
      'https://gitlab.com/gruppe/untergruppe/projekt',
      'gruppe/untergruppe',
      'projekt',
      'gitlab',
    ],
    [
      'git@gitlab.example.org:team/app.git',
      'https://gitlab.example.org/team/app',
      'team',
      'app',
      'gitlab',
    ],
    [
      'https://gitea.example.org:3000/org/repo.git/',
      'https://gitea.example.org:3000/org/repo',
      'org',
      'repo',
      'gitea',
    ],
    [
      'ssh://git@codeberg.org/Org/Repo.git',
      'https://codeberg.org/org/repo',
      'org',
      'repo',
      'gitea',
    ],
    [
      '  https://oauth2:abc123@git.example.org/a/b.git  ',
      'https://git.example.org/a/b',
      'a',
      'b',
      'unknown',
    ],
  ];

  it.each(vektoren)('%s', (eingabe, urlNorm, owner, repoName, provider) => {
    expect(normalisiereRepoUrl(eingabe)).toEqual({
      urlNorm,
      host: new URL(urlNorm).hostname,
      owner,
      repoName,
      provider,
    });
  });

  it('echter Vektor Claude Code 2.1.308 (2026-10-22): SSH mit Port 2222 wie vcs.repository.url.full', () => {
    // Remote `ssh://git@<forgejo>:2222/<owner>/<repo>.git`; Claude Code schickte im Pilot
    // `vcs.repository.url.full = https://<forgejo>/<owner>/<repo>`, `vcs.owner.name`, `vcs.repository.name`
    // und für selbst gehostetes Forgejo kein `vcs.provider.name` (nur gitea.com wird zu `gitea`).
    // Hostname hier neutral, die Form ist die beobachtete.
    const ausClaudeCode = 'https://git.example.org/team/projekt';
    const remote = normalisiereRepoUrl('ssh://git@git.example.org:2222/team/projekt.git');
    expect(remote?.urlNorm).toBe(ausClaudeCode);
    // Der Server normalisiert die Claude-Code-Angabe erneut; das muss stabil bleiben.
    expect(normalisiereRepoUrl(ausClaudeCode)).toEqual(remote);
  });

  it('HTTPS- und SSH-Klon ergeben dieselbe URL', () => {
    const ssh = normalisiereRepoUrl('ssh://git@git.example.com:2222/weeberwrk/seatmeter.git');
    const https = normalisiereRepoUrl('https://git.example.com/weeberwrk/seatmeter.git');
    expect(ssh?.urlNorm).toBe(https?.urlNorm);
  });

  it.each([
    '',
    '   ',
    '/home/nutzer/repo',
    'file:///srv/git/repo.git',
    'C:\\repos\\x',
    'https://github.com/',
  ])('kein Remote: %j', (eingabe) => {
    expect(normalisiereRepoUrl(eingabe)).toBeNull();
  });

  it('Zugangsdaten tauchen nie in der normalisierten URL auf', () => {
    const r = normalisiereRepoUrl('https://ich:geheim@github.com/o/r.git');
    expect(r?.urlNorm).not.toContain('geheim');
    expect(r?.urlNorm).not.toContain('ich');
  });
});

describe('kanonischeRepoInfo', () => {
  it.each([
    ['git@git.example:o/r.git', 'https://git.example/o/r'],
    ['git@git.example:kunden/müller/r.git', 'https://git.example/kunden/m%c3%bcller/r'],
    ['git@git.example:a/../b/r.git', 'https://git.example/b/r'],
    ['git@git.example:a/{b}/r.git', 'https://git.example/a/%7bb%7d/r'],
    ['git@git.example:a"b/r.git', 'https://git.example/a%22b/r'],
    ['git@git.example:a\\b/r.git', 'https://git.example/a/b/r'],
    ['git@bücher.example:o/r.git', 'https://xn--bcher-kva.example/o/r'],
  ])('%s ergibt dieselbe Form wie der Ingest und ändert sich nicht mehr', (roh, form) => {
    const info = kanonischeRepoInfo(roh);
    expect(info?.urlNorm).toBe(form);
    expect(normalisiereRepoUrl(form)?.urlNorm).toBe(form);
    expect(kanonischeRepoInfo(form)?.urlNorm).toBe(form);
  });

  it('ohne gültige URL bleibt der erste Stand, lokale Pfade bleiben null', () => {
    expect(kanonischeRepoInfo('git@exa[mple:o/r.git')?.urlNorm).toBe('https://exa[mple/o/r');
    expect(kanonischeRepoInfo('/srv/git/r.git')).toBeNull();
  });
});

describe('repoInfoAusUrlNorm', () => {
  it('nimmt die URL auseinander, ohne sie zu ändern', () => {
    expect(repoInfoAusUrlNorm('https://gitlab.example:8443/gruppe/unter/repo')).toEqual({
      urlNorm: 'https://gitlab.example:8443/gruppe/unter/repo',
      host: 'gitlab.example',
      owner: 'gruppe/unter',
      repoName: 'repo',
      provider: 'gitlab',
    });
    expect(repoInfoAusUrlNorm('https://git.example/repo')?.owner).toBeNull();
    expect(repoInfoAusUrlNorm('kein-url')).toBeNull();
  });
});
