// Führt den erzeugten Hook wirklich in bash aus, mit Nachbauten von curl und git im PATH: Was gesendet wird,
// wann blockiert wird, und dass jeder Fehler den Prompt durchlässt. Der Prompt darf nirgends auftauchen.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROJEKTWAHL_PRUEF_PFAD,
  PROJEKTWAHL_TOKEN_VARIABLE,
  projektwahlHookBefehl,
  projektwahlHookEinstellung,
} from './projektwahl-hook.js';
import { normalisiereRepoUrl } from './repo-url.js';

const PROMPT = 'GEHEIMER-PROMPT mit "session_id":"gefaelscht" und $(touch /tmp/nie)';
const TOKEN = 'smi_test-Token_0123456789';
const URL_INGEST = 'https://ingest.example.org';

let ordner: string;
let bin: string;
let protokoll: string;
let temp: string;

function ausfuehrbar(pfad: string, inhalt: string): void {
  writeFileSync(pfad, inhalt);
  chmodSync(pfad, 0o755);
}

function eingabe(sitzung = 'sitzung-123'): string {
  return `${JSON.stringify({
    session_id: sitzung,
    transcript_path: '/tmp/x.jsonl',
    cwd: '/tmp',
    hook_event_name: 'UserPromptSubmit',
    prompt: PROMPT,
  })}\n`;
}

interface Lauf {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Aufgezeichnete curl-Aufrufe: Argumente und stdin. */
  curl: string;
}

function lauf(
  o: {
    antwort?: string;
    curlFehler?: boolean;
    remote?: string | null;
    env?: Record<string, string>;
    befehl?: string;
    stdin?: string;
  } = {},
): Lauf {
  const antwort = join(ordner, 'antwort');
  writeFileSync(antwort, o.antwort ?? 'frei\n');
  ausfuehrbar(
    join(bin, 'curl'),
    `#!/bin/bash
{ printf 'ARGS:'; printf ' [%s]' "$@"; printf '\\nSTDIN:'; cat; printf '\\n'; } >> '${protokoll}'
${o.curlFehler ? 'exit 7' : `cat '${antwort}'`}
`,
  );
  const remote =
    o.remote === undefined ? 'https://nutzer:geheim@git.example.org/o/r.git' : o.remote;
  ausfuehrbar(
    join(bin, 'git'),
    remote === null ? '#!/bin/bash\nexit 2\n' : `#!/bin/bash\nprintf '%s\\n' '${remote}'\n`,
  );
  const r = spawnSync(
    'bash',
    ['-c', o.befehl ?? projektwahlHookBefehl({ ingestUrl: URL_INGEST })],
    {
      input: o.stdin ?? eingabe(),
      encoding: 'utf8',
      cwd: ordner,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: ordner,
        TMPDIR: temp,
        [PROJEKTWAHL_TOKEN_VARIABLE]: TOKEN,
        ...o.env,
      },
      timeout: 20_000,
    },
  );
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    curl: existsSync(protokoll) ? readFileSync(protokoll, 'utf8') : '',
  };
}

beforeEach(() => {
  ordner = mkdtempSync(join(tmpdir(), 'projektwahl-hook-'));
  bin = join(ordner, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  protokoll = join(ordner, 'curl.log');
  temp = join(ordner, 'tmp');
  mkdirSync(temp);
});

afterEach(() => {
  spawnSync('rm', ['-rf', ordner]);
});

describe('Hook der Projektwahl', () => {
  it('entfernt Query und Fragment aus der Repo-URL', () => {
    const r = lauf({ remote: 'https://git.example.org/o/r.git?token=geheim#x' });
    expect(r.curl).toContain('[repo=https://git.example.org/o/r.git]');
    expect(r.curl).not.toContain('geheim');
  });

  it('entfernt Zugangsdaten vollständig, auch mit @ im Passwort', () => {
    for (const remote of [
      'https://nutzer:ge@heim@git.example.org/o/r.git',
      'https://token@git.example.org/o/r.git',
      'https://nutzer:ge:h@e@im@git.example.org/o/r.git',
    ]) {
      spawnSync('rm', ['-rf', protokoll, join(ordner, '.cache')]);
      const r = lauf({ remote });
      expect(r.curl, remote).toContain('[repo=https://git.example.org/o/r.git]');
      expect(r.curl, remote).not.toMatch(/heim|e@im|token@|nutzer/);
    }
  });

  it('sendet nur, was der Server als Repo erkennt; lokale Pfade bleiben auf dem Rechner', () => {
    const repoInCurl = (curl: string) => /\[repo=([^\]]*)\]/.exec(curl)?.[1];
    for (const remote of [
      'https://git.example.org/o/r.git',
      'ssh://git@git.example.org:2222/o/r.git',
      'git@git.example.org:o/r.git',
      'git.example.org:o/r.git',
      'git@git.example.org:/srv/r.git',
    ]) {
      spawnSync('rm', ['-rf', protokoll, join(ordner, '.cache')]);
      const r = lauf({ remote, antwort: 'zugeordnet\n' });
      const gesendet = repoInCurl(r.curl);
      expect(gesendet, remote).toBeTruthy();
      expect(normalisiereRepoUrl(gesendet ?? ''), remote).not.toBeNull();
      expect(readdirSync(join(ordner, '.cache', 'seatmeter'))[0], remote).toMatch(/^r\d+-\d+$/);
    }
    for (const remote of [
      '/srv/git/r.git',
      './r.git',
      '../r.git',
      '~/r.git',
      'r.git',
      'file:///srv/git/r.git',
      'FILE:///srv/git/r.git',
      'C:\\repos\\r',
      'C:/repos/r',
      'https://git.example.org',
      'https://git.example.org/',
    ]) {
      spawnSync('rm', ['-rf', protokoll, join(ordner, '.cache')]);
      const r = lauf({ remote, antwort: 'zugeordnet\n' });
      expect(repoInCurl(r.curl), remote).toBe('');
      expect(normalisiereRepoUrl(remote), remote).toBeNull();
      // Marke je Sitzung, nicht je Repo.
      expect(readdirSync(join(ordner, '.cache', 'seatmeter'))[0], remote).toMatch(
        /^s\d+-sitzung-123$/,
      );
    }
  });

  it('sendet kaputte Remotes nicht: Reste von Zugangsdaten und lokale Pfade bleiben auf dem Rechner', () => {
    for (const remote of [
      'https://nutzer:ge/heim@host.example/o/r',
      'C://Users/alice/repo',
      'nutzer:geheim@host.example:o/r.git',
      'nutzer:ge/heim@host.example:o/r.git',
      'https://host.example/nutzer@geheim/r',
      'git@host.example:o/ge@heim.git',
    ]) {
      rmSync(protokoll, { force: true });
      rmSync(join(ordner, '.cache'), { recursive: true, force: true });
      const r = lauf({ remote, antwort: 'zugeordnet\n' });
      expect(r.curl, remote).toContain('[repo=]');
      expect(r.curl, remote).not.toMatch(/geheim|heim|alice|host\.example/);
      expect(readdirSync(join(ordner, '.cache', 'seatmeter'))[0], remote).toMatch(/^s\d+-/);
    }
  });

  it('sendet nur Sitzungs-ID und Repo-URL ohne Zugangsdaten, nie den Prompt', () => {
    const r = lauf({ antwort: 'zugeordnet\n' });
    expect(r.status).toBe(0);
    expect(r.curl).toContain('[sitzung=sitzung-123]');
    expect(r.curl).toContain('[repo=https://git.example.org/o/r.git]');
    expect(r.curl).toContain(`[${URL_INGEST}${PROJEKTWAHL_PRUEF_PFAD}]`);
    expect(r.curl).toContain('--max-time] [2]');
    expect(r.curl).not.toContain('geheim');
    expect(r.curl).not.toContain('GEHEIMER-PROMPT');
    expect(r.curl).not.toContain('gefaelscht');
    expect(r.stdout + r.stderr).not.toContain('GEHEIMER-PROMPT');
  });

  it('das Token steht nicht in den Argumenten, sondern in der Konfiguration auf stdin', () => {
    const r = lauf();
    const [args, stdin] = r.curl.split('\nSTDIN:');
    expect(args).not.toContain(TOKEN);
    expect(stdin).toContain(`header = "Authorization: Bearer ${TOKEN}"`);
  });

  it('blockiert mit JSON und dem Link, wenn der Server eine Wahl verlangt', () => {
    const link = 'https://seatmeter.example.org/projektwahl/abc.def_1-2';
    const r = lauf({ antwort: `waehlen ${link}\n` });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(j.decision).toBe('block');
    expect(j.reason).toContain(link);
    expect(j.reason).toContain('\n');
  });

  it('lässt durch: bei Netzfehler, unbekannter Antwort und fremden Zeichen im Link', () => {
    for (const o of [
      { curlFehler: true },
      { antwort: 'etwas anderes\n' },
      { antwort: 'waehlen https://x.example.org/"$(id)\n' },
    ]) {
      const r = lauf(o);
      expect(r.status, JSON.stringify(o)).toBe(0);
      expect(r.stdout, JSON.stringify(o)).toBe('');
    }
  });

  it('lässt ohne Token, bei kaputtem Token und ohne Sitzungs-ID durch, ohne etwas zu senden', () => {
    for (const o of [
      { env: { [PROJEKTWAHL_TOKEN_VARIABLE]: '' } },
      { env: { [PROJEKTWAHL_TOKEN_VARIABLE]: 'a"b' } },
      { stdin: '{"prompt":"x"}\n' },
    ]) {
      const r = lauf(o);
      expect(r.status, JSON.stringify(o)).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.curl, JSON.stringify(o)).toBe('');
    }
  });

  it('merkt sich die Zuordnung je Repo: kein zweiter Aufruf, auch in einer neuen Sitzung', () => {
    lauf({ antwort: 'zugeordnet\n' });
    const zweite = lauf({ antwort: 'waehlen https://x.example.org/y\n', stdin: eingabe('andere') });
    expect(zweite.stdout).toBe('');
    expect(zweite.curl.match(/ARGS:/g)).toHaveLength(1);
    expect(readdirSync(join(ordner, '.cache', 'seatmeter'))).toHaveLength(1);
  });

  it('merkt sich „frei“ getrennt und nur kurz; ein anderes Repo fragt wieder', () => {
    lauf({ antwort: 'frei\n' });
    expect(readdirSync(join(ordner, '.cache', 'seatmeter'))[0]).toMatch(/\.frei$/);
    const anderes = lauf({ remote: 'git@git.example.org:o/anderes.git' });
    expect(anderes.curl.match(/ARGS:/g)).toHaveLength(2);
    expect(anderes.curl).toContain('[repo=git@git.example.org:o/anderes.git]');
  });

  it('warnen: Prompt läuft weiter, Link als systemMessage, danach eine Stunde Ruhe', () => {
    const link = 'https://x.example.org/projektwahl/abc-1';
    const r = lauf({ antwort: `warnen ${link}\n` });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as Record<string, string>;
    expect(j.decision).toBeUndefined();
    expect(j.systemMessage).toContain(link);
    expect(readdirSync(join(ordner, '.cache', 'seatmeter'))[0]).toMatch(/\.warn$/);
    const zweiter = lauf({ antwort: `warnen ${link}\n` });
    expect(zweiter.stdout).toBe('');
    expect(zweiter.curl.match(/ARGS:/g)).toHaveLength(1);
    // Fremde Zeichen im Link: nichts anzeigen, nichts merken.
    spawnSync('rm', ['-rf', join(ordner, '.cache')]);
    const boese = lauf({ antwort: 'warnen https://x.example.org/"$(id)\n' });
    expect(boese.stdout).toBe('');
    expect(existsSync(join(ordner, '.cache', 'seatmeter'))).toBe(false);
  });

  describe('Cache-Ordner nicht beschreibbar', () => {
    const link = 'https://x.example.org/projektwahl/abc-1';
    // Eine Datei statt des Ordners: Das schlägt auch für root fehl, anders als fehlende Schreibrechte.
    const cacheSperren = () => writeFileSync(join(ordner, '.cache'), '');
    const ersatz = () => join(temp, `seatmeter-${process.getuid?.() ?? 0}`);

    it('warnen: Marke im Ersatzordner unter TMPDIR, danach eine Stunde Ruhe', () => {
      cacheSperren();
      const erster = lauf({ antwort: `warnen ${link}\n` });
      expect(erster.status).toBe(0);
      expect((JSON.parse(erster.stdout) as Record<string, string>).systemMessage).toContain(link);
      expect(readdirSync(ersatz())[0]).toMatch(/\.warn$/);
      const zweiter = lauf({ antwort: `warnen ${link}\n` });
      expect(zweiter.stdout).toBe('');
      expect(zweiter.curl.match(/ARGS:/g)).toHaveLength(1);
    });

    it('zugeordnet und frei nutzen den Ersatzordner auch', () => {
      cacheSperren();
      lauf({ antwort: 'zugeordnet\n' });
      const zweiter = lauf({ antwort: 'waehlen https://x.example.org/y\n' });
      expect(zweiter.stdout).toBe('');
      expect(zweiter.curl.match(/ARGS:/g)).toHaveLength(1);
    });

    it('ist gar keine Marke möglich, warnt der Hook nicht bei jedem Prompt, sondern gar nicht', () => {
      cacheSperren();
      const env = { TMPDIR: join(ordner, '.cache', 'gibt-es-nicht') };
      for (let i = 0; i < 2; i += 1) {
        const r = lauf({ antwort: `warnen ${link}\n`, env });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
      }
    });

    it('ein verlinkter Ersatzordner zählt nicht: nichts schreiben, nichts lesen, still bleiben', () => {
      cacheSperren();
      const fremd = join(ordner, 'fremd');
      mkdirSync(fremd);
      symlinkSync(fremd, ersatz());
      const r = lauf({ antwort: `warnen ${link}\n` });
      expect(r.stdout).toBe('');
      expect(readdirSync(fremd)).toEqual([]);
      // Eine dort abgelegte Marke hebt die Prüfung nicht auf.
      lauf({ antwort: 'zugeordnet\n' });
      expect(readdirSync(fremd)).toEqual([]);
      const danach = lauf({ antwort: 'waehlen https://x.example.org/y\n' });
      expect(danach.stdout).toContain('"decision":"block"');
    });

    it('blockieren bleibt unverändert: blockiert und schreibt keine Marke', () => {
      cacheSperren();
      const r = lauf({ antwort: 'waehlen https://x.example.org/y\n' });
      expect(r.stdout).toContain('"decision":"block"');
      expect(existsSync(ersatz())).toBe(false);
    });
  });

  it('Marken gelten je Token: Die Zuordnung einer Organisation winkt eine andere nicht durch', () => {
    lauf({ antwort: 'zugeordnet\n' });
    const andere = lauf({
      antwort: 'waehlen https://x.example.org/y\n',
      env: { [PROJEKTWAHL_TOKEN_VARIABLE]: 'smi_anderes-Token_987654' },
    });
    expect(andere.curl.match(/ARGS:/g)).toHaveLength(2);
    expect(andere.stdout).toContain('"decision":"block"');
    lauf({ antwort: 'frei\n', remote: null });
    const anderesOhneRepo = lauf({
      antwort: 'waehlen https://x.example.org/y\n',
      remote: null,
      env: { [PROJEKTWAHL_TOKEN_VARIABLE]: 'smi_anderes-Token_987654' },
    });
    expect(anderesOhneRepo.stdout).toContain('"decision":"block"');
  });

  it('merkt sich nichts, solange blockiert wird', () => {
    lauf({ antwort: 'waehlen https://x.example.org/y\n' });
    expect(existsSync(join(ordner, '.cache', 'seatmeter'))).toBe(false);
  });

  it('Ordner ohne Repo: leere Repo-URL, Marke je Sitzung', () => {
    const r = lauf({ remote: null, antwort: 'zugeordnet\n' });
    expect(r.curl).toContain('[repo=]');
    expect(readdirSync(join(ordner, '.cache', 'seatmeter'))[0]).toMatch(/^s\d+-sitzung-123$/);
    const neue = lauf({ remote: null, antwort: 'zugeordnet\n', stdin: eingabe('neu') });
    expect(neue.curl.match(/ARGS:/g)).toHaveLength(2);
  });

  it('`claude -p` und SDK (`sdk-*`) werden nie blockiert und senden nichts', () => {
    const r = lauf({
      antwort: 'waehlen https://x.example.org/y\n',
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.curl).toBe('');
  });

  it('Nutzung außerhalb des Abos: sofort durch, nichts gesendet, kein Block', () => {
    for (const env of [
      { ANTHROPIC_API_KEY: 'x' },
      { ANTHROPIC_AUTH_TOKEN: 'x' },
      { CLAUDE_CODE_USE_BEDROCK: '1' },
      { CLAUDE_CODE_USE_VERTEX: '1' },
      { CLAUDE_CODE_USE_FOUNDRY: '1' },
      { ANTHROPIC_BASE_URL: 'https://llm.example.org' },
    ]) {
      const r = lauf({ env, antwort: 'waehlen https://d.example.org/projektwahl/abc\n' });
      expect(r.status, JSON.stringify(env)).toBe(0);
      expect(r.stdout, JSON.stringify(env)).toBe('');
      expect(r.curl, JSON.stringify(env)).toBe('');
    }
    for (const basis of ['https://api.anthropic.com', 'https://api.anthropic.com/']) {
      const r = lauf({
        env: { ANTHROPIC_BASE_URL: basis },
        antwort: 'waehlen https://d.example.org/projektwahl/abc\n',
      });
      expect(r.stdout, basis).toContain('"decision":"block"');
    }
  });

  it('Rechner-Token über den Agenten statt der Umgebungsvariable', () => {
    const agent = join(bin, 'agent');
    ausfuehrbar(agent, `#!/bin/bash\nprintf '{"Authorization":"Bearer smr_vom-agent"}\\n'\n`);
    const r = lauf({
      befehl: projektwahlHookBefehl({
        ingestUrl: URL_INGEST,
        helperBefehl: `${agent} otel-headers`,
      }),
      env: { [PROJEKTWAHL_TOKEN_VARIABLE]: '' },
    });
    expect(r.curl).toContain('Bearer smr_vom-agent');
  });

  it('die URL wird für die Shell gequotet, abschließender Schrägstrich fällt weg', () => {
    const b = projektwahlHookBefehl({ ingestUrl: "https://a.example.org/x'y/" });
    expect(b).toContain(`'https://a.example.org/x'\\''y${PROJEKTWAHL_PRUEF_PFAD}'`);
    expect(b).not.toContain('eval');
  });

  it('Einstellung: UserPromptSubmit, Befehl, Zeitlimit', () => {
    const e = projektwahlHookEinstellung({ ingestUrl: URL_INGEST });
    const h = e.UserPromptSubmit[0]?.hooks[0];
    expect(h?.type).toBe('command');
    expect(h?.timeout).toBe(5);
    expect(h?.command).toContain(PROJEKTWAHL_PRUEF_PFAD);
  });
});
