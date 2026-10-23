import { describe, expect, it } from 'vitest';
import { normalisiereRepoUrl } from './repo-url.js';

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
