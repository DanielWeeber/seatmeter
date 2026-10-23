// Testhilfen: Umgebung in einem Temp-Verzeichnis, Fixtures mit Zeitplatzhaltern, Git und HTTP
// als Fälschungen (kein Netz, kein echtes Git, kein Schlüsselbund).
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitAufruf, Umgebung } from '../src/umgebung.js';

export const FIXTURES = new URL('./fixtures/transkripte/', import.meta.url);
export const S1 = 'aaaaaaaa-1111-4111-8111-111111111111';
export const S2 = 'bbbbbbbb-2222-4222-8222-222222222222';
export const ORG = '7d0a1c3e-5b2f-4c8d-9e1a-0b2c3d4e5f60';
export const KONTO = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
export const EMAIL = 'geheime.person@example.com';

/** Remotes der Fixture-Repos: SSH mit Port 2222 (Forgejo) und scp-Form (GitHub). */
export const REMOTES: Record<string, string> = {
  '/home/dev/kunden/alpha': 'ssh://git@git.example.org:2222/Kunde/Alpha.git',
  '/home/dev/kunden/beta': 'git@github.com:kunde/beta.git',
  '/home/dev/privat/geheim': 'https://github.com/privat/geheim.git',
  '/home/dev/privat': 'https://github.com/privat/home.git',
};

export function fakeGit(
  remotes: Record<string, string> = REMOTES,
): GitAufruf & { aufrufe: string[][] } {
  const aufrufe: string[][] = [];
  const f = ((args: string[], cwd: string) => {
    aufrufe.push([...args, cwd]);
    if (args[0] === 'rev-parse') return remotes[cwd] ? cwd : null;
    if (args[0] === 'config') return remotes[cwd] ?? null;
    return null;
  }) as GitAufruf & { aufrufe: string[][] };
  f.aufrufe = aufrufe;
  return f;
}

export interface Mitschnitt {
  url: string;
  methode: string;
  kopf: Record<string, string>;
  koerper: string;
}

export type Antworter = (url: string, koerper: string, nr: number) => Response;

export function fakeFetch(antworter: Antworter): typeof fetch & { mitschnitt: Mitschnitt[] } {
  const mitschnitt: Mitschnitt[] = [];
  const f = (async (eingabe: string | URL | Request, init?: RequestInit) => {
    const url = String(eingabe);
    const koerper = typeof init?.body === 'string' ? init.body : '';
    mitschnitt.push({
      url,
      methode: init?.method ?? 'GET',
      kopf: Object.fromEntries(new Headers(init?.headers).entries()),
      koerper,
    });
    return antworter(url, koerper, mitschnitt.length);
  }) as typeof fetch & { mitschnitt: Mitschnitt[] };
  f.mitschnitt = mitschnitt;
  return f;
}

export const json = (wert: unknown, status = 200, kopf: Record<string, string> = {}) =>
  new Response(JSON.stringify(wert), {
    status,
    headers: { 'content-type': 'application/json', ...kopf },
  });

/** Standard-Server: nimmt alles an. */
export const serverOk: Antworter = (url, koerper) => {
  if (url.endsWith('/api/agent/v1/config')) {
    return json({
      server_url: 'https://ingest.example.org',
      modus: 'hooks',
      sweeper_intervall_min: 10,
      include_paths: [],
      exclude_paths: [],
      rueckfuellung_tage: 30,
    });
  }
  if (url.endsWith('/api/agent/v1/heartbeat')) return new Response(null, { status: 204 });
  const d = JSON.parse(koerper) as { anfragen?: unknown[]; sitzungen?: unknown[] };
  const n = (d.anfragen ?? d.sitzungen ?? []).length;
  return json({
    angenommen: n,
    wiederholt: 0,
    verworfen_api: 0,
    verworfen_fremd_org: 0,
    abgelehnt: 0,
  });
};

/** Ersetzt `{{T+n}}` durch basis + n Sekunden. */
export function zeitErsetzen(text: string, basis: Date): string {
  return text.replace(/\{\{T\+(\d+)\}\}/g, (_m, n: string) =>
    new Date(basis.getTime() + Number(n) * 1000).toISOString(),
  );
}

/** Kopiert die Fixture-Transkripte nach `<claudeDir>/projects` und setzt die Zeiten ein. */
export function fixturesKopieren(claudeDir: string, basis: Date): string {
  const ziel = join(claudeDir, 'projects');
  mkdirSync(ziel, { recursive: true });
  cpSync(FIXTURES, ziel, { recursive: true });
  const ersetzen = (ordner: string) => {
    for (const e of readdirSync(ordner)) {
      const p = join(ordner, e);
      if (statSync(p).isDirectory()) ersetzen(p);
      else if (p.endsWith('.jsonl')) writeFileSync(p, zeitErsetzen(readFileSync(p, 'utf8'), basis));
    }
  };
  ersetzen(ziel);
  return ziel;
}

export interface TestUmgebung extends Umgebung {
  wurzel: string;
  fetch: ReturnType<typeof fakeFetch>;
  git: ReturnType<typeof fakeGit>;
}

export function testUmgebung(
  o: { jetzt?: Date; antworter?: Antworter; plattform?: NodeJS.Platform; fixtures?: boolean } = {},
): TestUmgebung {
  const wurzel = mkdtempSync(join(tmpdir(), 'seatmeter-agent-'));
  const home = join(wurzel, 'home');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const jetzt = o.jetzt ?? new Date();
  if (o.fixtures !== false) fixturesKopieren(claudeDir, new Date(jetzt.getTime() - 3600_000));
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      projects: { '/home/dev/kunden/alpha': { history: ['GEHEIMER-INHALT Verlauf'] } },
      oauthAccount: {
        accountUuid: KONTO,
        emailAddress: EMAIL,
        organizationUuid: ORG,
        displayName: 'Geheimer Name',
        organizationName: 'Geheime Firma',
      },
    }),
  );
  return {
    wurzel,
    home,
    claudeDir,
    claudeJson: join(home, '.claude.json'),
    agentDir: join(home, '.seatmeter'),
    env: { HOME: home, SEATMETER_TOKEN_DATEI: '1' },
    plattform: o.plattform ?? 'linux',
    jetzt: () => jetzt,
    git: fakeGit(),
    fetch: fakeFetch(o.antworter ?? serverOk),
    verbose: false,
  };
}

/** Lokale Konfiguration und Token wie nach `enroll` + `install --sweeper-only`. */
export function eingerichtet(
  u: Umgebung,
  lokal: Record<string, unknown> = {},
  mitToken = true,
): void {
  mkdirSync(u.agentDir, { recursive: true });
  writeFileSync(
    join(u.agentDir, 'config.json'),
    JSON.stringify({
      server_url: 'https://ingest.example.org',
      modus: 'nur_sweeper',
      include_paths: ['/home/dev/kunden'],
      ...lokal,
    }),
  );
  if (mitToken) {
    writeFileSync(join(u.agentDir, 'token'), 'smr_testtoken0000000000000000000000\n', {
      mode: 0o600,
    });
  }
}

export function ausgabe() {
  const o = { out: '', err: '' };
  return {
    o,
    aus: { out: (t: string) => (o.out += t), err: (t: string) => (o.err += t) },
  };
}
