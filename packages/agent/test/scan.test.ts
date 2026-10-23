// Transkript-Zähler, Pfad-Filter, Projekt-Erkennung und Inhaltsfreiheit (Phase-2-Kriterien b–f, h).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPushSchema, normalisiereRepoUrl, type AgentAnfrage } from '@seatmeter/shared';
import { authHinweis } from '../src/auth-hinweis.js';
import { AGENT_VERSION, main } from '../src/cli.js';
import { istEingeschlossen, projektOrdnerName, wirksameKonfig } from '../src/konfig.js';
import { scanne } from '../src/scan.js';
import { leseZeile } from '../src/transkript.js';
import { projektFuer } from '../src/projekt.js';
import { ladeAnfragen } from '../src/warteschlange.js';
import { ladeZustand, speichereZustand } from '../src/zustand.js';
import {
  ausgabe,
  eingerichtet,
  EMAIL,
  fakeGit,
  KONTO,
  ORG,
  S1,
  S2,
  testUmgebung,
  type TestUmgebung,
  zeitErsetzen,
} from './hilfen.js';

/** URL eines Repo-Projekts (Pfad-Projekte haben keine). */
const urlVon = (p: AgentAnfrage['projekt'] | undefined) =>
  p && 'url_norm' in p ? p.url_norm : undefined;

function scan(u: TestUmgebung) {
  const z = ladeZustand(u);
  const e = scanne(u, wirksameKonfig(u), z, { hinweis: authHinweis(u) });
  speichereZustand(u, z);
  return e;
}

function summen(liste: AgentAnfrage[]) {
  const s = { input: 0, output: 0, cache_read: 0, cache_creation: 0, c5m: 0, c1h: 0 };
  for (const a of liste) {
    s.input += a.input_tokens;
    s.output += a.output_tokens;
    s.cache_read += a.cache_read_input_tokens;
    s.cache_creation += a.cache_creation_input_tokens;
    s.c5m += a.cache_write_5m ?? 0;
    s.c1h += a.cache_write_1h ?? 0;
  }
  return s;
}

const ERWARTET = {
  input: 41,
  output: 271,
  cache_read: 2800,
  cache_creation: 950,
  c5m: 550,
  c1h: 400,
};

describe('Transkript-Zähler', () => {
  it('liest nur Nutzungsfelder; content, gitBranch und Tool-Eingaben fehlen im Ergebnis', () => {
    const zeile = readFileSync(
      join(
        new URL('./fixtures/transkripte/-home-dev-kunden-alpha/', import.meta.url).pathname,
        `${S1}.jsonl`,
      ),
      'utf8',
    )
      .split('\n')
      .find((z) => z.includes('msg_02FIX')) as string;
    const e = leseZeile(zeitErsetzen(zeile, new Date()));
    expect(e).toMatchObject({
      requestId: 'req_02FIX',
      cache5m: 100,
      cache1h: 200,
      webSearch: 1,
      inferenceGeo: 'us',
    });
    const text = JSON.stringify(e);
    expect(text).not.toContain('GEHEIM');
    expect(text).not.toContain('content');
    expect(text).not.toContain('gitBranch');
    expect(leseZeile('{"type":"assistant","message":')).toBeNull();
    expect(leseZeile('{"type":"user","message":{"content":"x"}}')).toBeNull();
  });

  it('(b) nur B: Summen entsprechen exakt der Nutzung im synthetischen Transkript (letzte Zeile je message.id)', () => {
    const u = testUmgebung();
    eingerichtet(u);
    const e = scan(u);
    const q = ladeAnfragen(u);
    expect(q.map((a) => a.request_id ?? `msg:${a.message_id}`).sort()).toEqual([
      'msg:msg_04FIX',
      'req_01FIX',
      'req_02FIX',
      'req_03FIX',
      'req_S1FIX',
    ]);
    expect(summen(q)).toEqual(ERWARTET);
    expect(q.find((a) => a.request_id === 'req_01FIX')?.output_tokens).toBe(120);
    expect(q.find((a) => a.request_id === 'req_S1FIX')?.ist_subagent).toBe(true);
    expect(q.find((a) => a.request_id === 'req_01FIX')?.ist_subagent).toBe(false);
    expect(e).toMatchObject({ anfragen: 5, ausserhalb: 1 });
    // Zweiter Scan ohne Änderung: nichts Neues.
    expect(scan(u).anfragen).toBe(0);
  });

  it('(c) verlorene Hooks: der Sweeper holt nachträglich geschriebene Zeilen nach (inkl. Streaming-Nachzügler)', () => {
    const u = testUmgebung();
    eingerichtet(u);
    const datei = join(u.claudeDir, 'projects', '-home-dev-kunden-alpha', `${S1}.jsonl`);
    const voll = readFileSync(datei, 'utf8');
    const zeilen = voll.split('\n');
    // Zustand „Claude Code hat erst die erste Streaming-Zeile geschrieben“ (+ halbe Zeile ohne \n).
    writeFileSync(datei, `${zeilen.slice(0, 2).join('\n')}\n${(zeilen[2] ?? '').slice(0, 40)}`);
    scan(u);
    const zwischen = ladeAnfragen(u).find((a) => a.request_id === 'req_01FIX');
    expect(zwischen?.output_tokens).toBe(5);
    // Rest wird asynchron nachgeschrieben, kein Hook feuert; der nächste Sweeper-Lauf findet alles.
    writeFileSync(datei, voll);
    scan(u);
    const q = ladeAnfragen(u);
    expect(q.find((a) => a.request_id === 'req_01FIX')?.output_tokens).toBe(120);
    expect(summen(q)).toEqual(ERWARTET);
    // Datei wächst weiter: nur die neue Zeile wird gelesen.
    appendFileSync(
      datei,
      `${(zeilen[3] ?? '').replace(/msg_02FIX/g, 'msg_07FIX').replace(/req_02FIX/g, 'req_07FIX')}\n`,
    );
    expect(scan(u).anfragen).toBe(1);
  });

  it('(d) mitgeschnittener Push und Heartbeat enthalten keine Inhalte, kein cwd, keine Pfade, keinen Hostnamen, keine E-Mail', async () => {
    const u = testUmgebung();
    eingerichtet(u);
    const { aus, o } = ausgabe();
    expect(await main(['scan', '--push'], aus, { umgebung: u })).toBe(0);
    expect(o.out).toContain('Push: ok');
    const pushes = u.fetch.mitschnitt.filter((m) => m.url.includes('/api/ingest/v1/'));
    expect(pushes.map((m) => new URL(m.url).pathname).sort()).toEqual([
      '/api/ingest/v1/anfragen',
      '/api/ingest/v1/sitzungen',
    ]);
    const heartbeats = u.fetch.mitschnitt.filter((m) => m.url.endsWith('/api/agent/v1/heartbeat'));
    expect(heartbeats).toHaveLength(1);
    expect(JSON.parse(heartbeats[0]?.koerper ?? '{}')).toEqual({ agent_version: AGENT_VERSION });
    for (const m of [...pushes, ...heartbeats]) {
      expect(m.kopf.authorization).toMatch(/^Bearer smr_/);
      const roh = m.koerper;
      for (const verboten of [
        'GEHEIM',
        'content',
        'cwd',
        '/home/dev',
        'kunden/alpha/',
        'transcript',
        'gitBranch',
        'feature/',
        EMAIL,
        '@example.com',
        'Geheim',
        hostname(),
        u.home,
      ]) {
        expect(roh, verboten).not.toContain(verboten);
      }
      expect(roh).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    }
    const anfragen = pushes.find((m) => m.url.endsWith('/anfragen'));
    const push = agentPushSchema.parse(JSON.parse(anfragen?.koerper ?? '{}'));
    expect(push.anfragen).toHaveLength(5);
    expect(push.anfragen[0]?.auth_hinweis).toEqual({
      klasse: 'oauth',
      org_uuid: ORG,
      account_uuid: KONTO,
    });
    // Warteschlange ist danach leer.
    expect(ladeAnfragen(u)).toHaveLength(0);
  });

  it('(e) URL-Testvektoren HTTPS/SSH/Port 2222 ergeben im Agenten dieselbe URL wie in @seatmeter/shared', () => {
    const vektoren: [string, string][] = [
      ['https://git.example.org/Kunde/Alpha.git', 'https://git.example.org/kunde/alpha'],
      ['ssh://git@git.example.org:2222/Kunde/Alpha.git', 'https://git.example.org/kunde/alpha'],
      ['git@git.example.org:Kunde/Alpha.git', 'https://git.example.org/kunde/alpha'],
      ['https://user:geheim@github.com/kunde/beta.git?x=1#y', 'https://github.com/kunde/beta'],
    ];
    for (const [roh, erwartet] of vektoren) {
      const u = testUmgebung({ fixtures: false });
      u.git = fakeGit({ '/repo': roh });
      const projekt = projektFuer(u, ladeZustand(u), '/repo');
      expect(urlVon(projekt)).toBe(erwartet);
      expect(urlVon(projekt)).toBe(normalisiereRepoUrl(roh)?.urlNorm);
    }
    // HTTPS- und SSH-Klon desselben Repos ergeben dasselbe Projekt.
    expect(new Set(vektoren.slice(0, 3).map(([, e]) => e)).size).toBe(1);
  });

  it('(f) eine Sitzung über zwei Repos wird je Anfrage zwei Projekten zugeordnet', () => {
    const u = testUmgebung();
    eingerichtet(u);
    scan(u);
    const q = ladeAnfragen(u).filter((a) => a.session_id === S1);
    const je = new Map(q.map((a) => [a.request_id ?? a.message_id, urlVon(a.projekt)]));
    expect(je.get('req_01FIX')).toBe('https://git.example.org/kunde/alpha');
    expect(je.get('req_03FIX')).toBe('https://github.com/kunde/beta');
    expect(new Set(q.map((a) => urlVon(a.projekt))).size).toBe(2);
    // Git wird je cwd nur einmal gefragt (Cache).
    const revParse = u.git.aufrufe.filter((a) => a[0] === 'rev-parse');
    expect(revParse.length).toBe(2);
  });

  it('(h) Pfad-Filter: Sitzungen und Zeilen außerhalb verlassen den Rechner nicht (auch nicht ihre IDs)', async () => {
    const u = testUmgebung();
    eingerichtet(u, { exclude_paths: ['/home/dev/kunden/beta'] });
    const { aus } = ausgabe();
    await main(['scan', '--push'], aus, { umgebung: u });
    const alles = u.fetch.mitschnitt.map((m) => m.koerper).join('\n');
    expect(alles).not.toContain(S2);
    expect(alles).not.toContain('msg_P1FIX');
    expect(alles).not.toContain('msg_06FIX');
    expect(alles).not.toContain('msg_03FIX');
    expect(alles).toContain('msg_01FIX');
    // Der Ordner des privaten Bereichs wurde gar nicht gelesen.
    expect(Object.keys(ladeZustand(u).dateien).some((p) => p.includes('-home-dev-privat'))).toBe(
      false,
    );
    expect(u.git.aufrufe.some((a) => a.at(-1)?.startsWith('/home/dev/privat'))).toBe(false);
  });

  it('Pfad-Filter-Regeln: Trennergrenze, Ausschluss geht vor, ohne cwd nur ohne Filter', () => {
    const k = {
      server_url: null,
      modus: 'nur_sweeper' as const,
      sweeper_intervall_min: 10,
      include_paths: ['/home/dev/kunden'],
      exclude_paths: ['/home/dev/kunden/intern'],
      rueckfuellung_tage: 30,
      pfad_projekte: [],
    };
    expect(istEingeschlossen('/home/dev/kunden', k)).toBe(true);
    expect(istEingeschlossen('/home/dev/kunden/x/y', k)).toBe(true);
    expect(istEingeschlossen('/home/dev/kundenxyz', k)).toBe(false);
    expect(istEingeschlossen('/home/dev/kunden/intern/a', k)).toBe(false);
    expect(istEingeschlossen(null, k)).toBe(false);
    expect(istEingeschlossen(null, { ...k, include_paths: [], exclude_paths: [] })).toBe(true);
    expect(projektOrdnerName('/Users/x/Kunden/acme.de')).toBe('-Users-x-Kunden-acme-de');
  });

  it('Rückfüllung: Anfragen älter als rueckfuellung_tage bleiben liegen', () => {
    const u = testUmgebung({ jetzt: new Date(Date.now() + 40 * 86_400_000) });
    eingerichtet(u);
    expect(scan(u).anfragen).toBe(0);
  });

  it('Auth-Hinweis: API-Key-Variablen → api ohne Konto; sonst oauth mit UUIDs, nie E-Mail', () => {
    const u = testUmgebung({ fixtures: false });
    expect(authHinweis(u, { ANTHROPIC_API_KEY: 'sk-test' })).toEqual({
      klasse: 'api',
      org_uuid: null,
      account_uuid: null,
    });
    expect(authHinweis(u, { ANTHROPIC_BASE_URL: 'https://proxy.example.org' }).klasse).toBe('api');
    expect(authHinweis(u, {})).toEqual({ klasse: 'oauth', org_uuid: ORG, account_uuid: KONTO });
    writeFileSync(
      join(u.claudeDir, 'settings.json'),
      JSON.stringify({ apiKeyHelper: '/bin/echo' }),
    );
    expect(authHinweis(u, {}).klasse).toBe('api');
  });

  it('pfad_projekte: ohne Git-Remote unter konfiguriertem Pfad → Pfad-Projekt (nur Name, kein Pfad)', () => {
    const u = testUmgebung();
    eingerichtet(u, {
      pfad_projekte: {
        '/home/dev/kunden': 'kunden/rest',
        '/home/dev/kunden/beta': 'kunden/beta',
        '/home/dev/x': '/kein/gueltiger/name',
      },
    });
    const k = wirksameKonfig(u);
    // Ungültige Bezeichnungen werden ignoriert, der längste Pfad steht vorn.
    expect(k.pfad_projekte.map((r) => r.name)).toEqual(['kunden/beta', 'kunden/rest']);
    const z = ladeZustand(u);
    u.git = fakeGit({ '/home/dev/kunden/alpha': 'ssh://git@git.example.org:2222/Kunde/Alpha.git' });
    // Git-Remote geht vor.
    expect(projektFuer(u, z, '/home/dev/kunden/alpha', k)).toMatchObject({
      url_norm: 'https://git.example.org/kunde/alpha',
    });
    expect(projektFuer(u, z, '/home/dev/kunden', k)).toEqual({ typ: 'pfad', name: 'kunden/rest' });
    expect(projektFuer(u, z, '/home/dev/kunden/ohne-remote/', k)).toEqual({
      typ: 'pfad',
      name: 'kunden/rest',
    });
    expect(projektFuer(u, z, '/home/dev/kunden/beta/unter', k)).toEqual({
      typ: 'pfad',
      name: 'kunden/beta',
    });
    // Präfix nur an Pfadgrenzen; außerhalb und ohne Konfiguration bleibt es „unzugeordnet“.
    expect(projektFuer(u, z, '/home/dev/kunden-alt', k)).toBeNull();
    expect(projektFuer(u, z, '/home/dev/kunden/ohne-remote')).toBeNull();

    // Ganzer Scan ohne Remotes: alle Anfragen tragen das Pfad-Projekt und bestehen das strikte Schema.
    u.git = fakeGit({});
    scan(u);
    const q = ladeAnfragen(u);
    expect(q.length).toBeGreaterThan(0);
    const namen = new Set(q.map((a) => (a.projekt && 'typ' in a.projekt ? a.projekt.name : null)));
    expect([...namen].sort()).toEqual(['kunden/beta', 'kunden/rest']);
    expect(agentPushSchema.safeParse({ agent_version: '0.1.0', anfragen: q }).success).toBe(true);
    expect(JSON.stringify(q)).not.toContain('/home/dev');
  });

  it('gelöschter Worktree unter <repo>/.claude/worktrees/<name> zählt zum Repo darüber', () => {
    const u = testUmgebung({ fixtures: false });
    eingerichtet(u, { pfad_projekte: { '/home/dev/kunden': 'kunden/rest' } });
    const k = wirksameKonfig(u);
    const z = ladeZustand(u);
    // Das Fixture-Home liegt unter /home/dev; die Pfade existieren nicht auf der Platte.
    u.home = '/home/dev';
    u.git = fakeGit({ '/home/dev/kunden/alpha': 'ssh://git@git.example.org:2222/Kunde/Alpha.git' });
    expect(
      urlVon(
        projektFuer(u, z, '/home/dev/kunden/alpha/.claude/worktrees/agent-a0e943e09c04041aa', k),
      ),
    ).toBe('https://git.example.org/kunde/alpha');
    // Ohne Repo darüber: Pfad-Projekt; nie über das Home-Verzeichnis hinaus.
    expect(projektFuer(u, z, '/home/dev/kunden/weg/unter', k)).toEqual({
      typ: 'pfad',
      name: 'kunden/rest',
    });
    u.git = fakeGit({ '/home/dev': 'https://github.com/privat/home.git' });
    expect(projektFuer(u, z, '/home/dev/irgendwo/weg')).toBeNull();
  });
});
