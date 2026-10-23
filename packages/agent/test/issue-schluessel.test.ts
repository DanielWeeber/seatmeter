// Issue-Schlüssel aus dem Branch-Namen: nur der Schlüssel verlässt den Rechner,
// der Branch-Name nie. Dazu der Befehl `otel-ressource` für den Start-Wrapper (Quelle A).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPushSchema } from '@seatmeter/shared';
import { main } from '../src/cli.js';
import { leseZeile } from '../src/transkript.js';
import { ladeAnfragen } from '../src/warteschlange.js';
import { ausgabe, eingerichtet, fakeGit, testUmgebung } from './hilfen.js';

const SITZUNG = 'cccccccc-3333-4333-8333-333333333333';

function zeile(nr: number, branch: string | undefined, ts: Date): string {
  return JSON.stringify({
    type: 'assistant',
    cwd: '/home/dev/kunden/alpha',
    sessionId: SITZUNG,
    version: '2.1.309',
    ...(branch === undefined ? {} : { gitBranch: branch }),
    requestId: `req_ISSUE${nr}`,
    timestamp: new Date(ts.getTime() + nr * 1000).toISOString(),
    message: {
      id: `msg_ISSUE${nr}`,
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'GEHEIMER-INHALT' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  });
}

describe('Issue-Schlüssel im Agenten', () => {
  it('leseZeile: Schlüssel aus gitBranch, Branch-Name verworfen', () => {
    const t = new Date();
    expect(leseZeile(zeile(1, 'feature/ABC-123-titel', t))?.issueSchluessel).toEqual(['ABC-123']);
    expect(leseZeile(zeile(2, 'abc-123', t))?.issueSchluessel).toEqual(['ABC-123']);
    expect(leseZeile(zeile(3, 'ABC-123/ABC-124', t))?.issueSchluessel).toEqual([
      'ABC-123',
      'ABC-124',
    ]);
    expect(leseZeile(zeile(4, 'main', t))?.issueSchluessel).toEqual([]);
    expect(leseZeile(zeile(5, undefined, t))?.issueSchluessel).toBeNull();
    const text = JSON.stringify(leseZeile(zeile(6, 'feature/ABC-9-geheimer-titel', t)));
    expect(text).not.toContain('feature');
    expect(text).not.toContain('geheimer-titel');
    expect(text).not.toContain('gitBranch');
  });

  it('Push enthält issue_schluessel je Anfrage, nie den Branch-Namen', async () => {
    const jetzt = new Date();
    const u = testUmgebung({ jetzt, fixtures: false });
    eingerichtet(u);
    const ordner = join(u.claudeDir, 'projects', '-home-dev-kunden-alpha');
    mkdirSync(ordner, { recursive: true });
    const basis = new Date(jetzt.getTime() - 600_000);
    writeFileSync(
      join(ordner, `${SITZUNG}.jsonl`),
      `${[
        zeile(1, 'feature/ABC-123-geheimer-titel', basis),
        zeile(2, 'ABC-123/abc-124', basis),
        zeile(3, 'main', basis),
        zeile(4, undefined, basis),
      ].join('\n')}\n`,
    );
    const { aus } = ausgabe();
    expect(await main(['scan'], aus, { umgebung: u })).toBe(0);
    const q = new Map(ladeAnfragen(u).map((a) => [a.request_id, a]));
    expect(q.get('req_ISSUE1')?.issue_schluessel).toEqual(['ABC-123']);
    expect(q.get('req_ISSUE2')?.issue_schluessel).toEqual(['ABC-123', 'ABC-124']);
    expect(q.get('req_ISSUE3')?.issue_schluessel).toEqual([]);
    expect(q.get('req_ISSUE4')).not.toHaveProperty('issue_schluessel');

    expect(await main(['push'], aus, { umgebung: u })).toBe(0);
    const push = u.fetch.mitschnitt.find((m) => m.url.endsWith('/api/ingest/v1/anfragen'));
    const roh = push?.koerper ?? '';
    for (const verboten of ['feature', 'geheimer-titel', '"main"', 'gitBranch', 'GEHEIM'])
      expect(roh, verboten).not.toContain(verboten);
    expect(agentPushSchema.parse(JSON.parse(roh)).anfragen).toHaveLength(4);
  });

  it('otel-ressource: Schlüssel des aktuellen Branches, vorhandene Attribute bleiben', async () => {
    const u = testUmgebung({ fixtures: false });
    eingerichtet(u);
    const zweig: Record<string, string> = {
      '/home/dev/kunden/alpha': 'feature/ABC-123-geheim',
      '/home/dev/kunden/beta': 'main',
      '/home/dev/privat/geheim': 'XYZ-1',
    };
    const git = fakeGit();
    u.git = Object.assign(
      (args: string[], cwd: string) =>
        args[0] === 'rev-parse' && args[1] === '--abbrev-ref'
          ? (zweig[cwd] ?? null)
          : git(args, cwd),
      { aufrufe: git.aufrufe },
    );
    const lauf = async (cwd: string, env: Record<string, string> = {}) => {
      u.env = { ...u.env, ...env };
      const { aus, o } = ausgabe();
      expect(await main(['otel-ressource'], aus, { umgebung: u, cwd })).toBe(0);
      return o.out;
    };
    expect(await lauf('/home/dev/kunden/alpha')).toBe('seatmeter.issue_schluessel=ABC-123\n');
    expect(
      await lauf('/home/dev/kunden/alpha', {
        OTEL_RESOURCE_ATTRIBUTES: 'team=a,seatmeter.issue_schluessel=ALT-1',
      }),
    ).toBe('team=a,seatmeter.issue_schluessel=ABC-123\n');
    expect(await lauf('/home/dev/kunden/beta')).toBe('');
    // Außerhalb des Pfad-Filters: nichts, auch wenn der Branch einen Schlüssel trägt.
    expect(await lauf('/home/dev/privat/geheim')).toBe('');
  });
});
