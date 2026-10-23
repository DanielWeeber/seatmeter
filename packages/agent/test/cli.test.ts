// CLI: enroll, install/uninstall (Hooks mischen, Sweeper-Dateien), hook, push-Regeln, otel-headers.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_VERSION, BEFEHLE, main } from '../src/cli.js';
import { LAUNCHD_LABEL } from '../src/installieren.js';
import { ladeAnfragen } from '../src/warteschlange.js';
import { ladeZustand } from '../src/zustand.js';
import { ausgabe, eingerichtet, json, S1, serverOk, testUmgebung } from './hilfen.js';

const AUFRUF = { programm: ['/opt/node/bin/node', '/home/dev/.seatmeter/bin/seatmeter-agent.mjs'] };

describe('seatmeter-agent CLI', () => {
  it('--version und --help', async () => {
    const a = ausgabe();
    expect(await main(['--version'], a.aus)).toBe(0);
    expect(a.o.out).toBe(`${AGENT_VERSION}\n`);
    const h = ausgabe();
    expect(await main(['--help'], h.aus)).toBe(0);
    for (const [b] of BEFEHLE) expect(h.o.out).toContain(b);
    expect(await main(['gibtsnicht'], ausgabe().aus, { umgebung: testUmgebung() })).toBe(1);
  });

  it('enroll: Einmalcode → Token in Datei 0600, Server-Konfiguration und Rechner abgelegt', async () => {
    const u = testUmgebung({
      antworter: (url, koerper) => {
        expect(url).toBe('https://ingest.example.org/api/agent/v1/enroll');
        expect(JSON.parse(koerper)).toEqual({
          code: 'ABCD-EFGH-IJKL',
          os: 'linux',
          agent_version: AGENT_VERSION,
        });
        return json(
          {
            rechner_id: '0192f0a0-0000-7000-8000-000000000001',
            token: 'smr_neuestoken000000000000000000000',
            konfiguration: {
              server_url: 'https://ingest.example.org',
              modus: 'hooks',
              sweeper_intervall_min: 10,
              include_paths: [],
              exclude_paths: [],
              rueckfuellung_tage: 30,
            },
          },
          201,
        );
      },
    });
    const a = ausgabe();
    expect(
      await main(['enroll', 'ABCD-EFGH-IJKL', '--server', 'https://ingest.example.org/'], a.aus, {
        umgebung: u,
      }),
    ).toBe(0);
    const token = join(u.agentDir, 'token');
    expect(readFileSync(token, 'utf8').trim()).toBe('smr_neuestoken000000000000000000000');
    expect(statSync(token).mode & 0o777).toBe(0o600);
    expect(a.o.out).not.toContain('smr_');
    expect(JSON.parse(readFileSync(join(u.agentDir, 'config.json'), 'utf8')).server_url).toBe(
      'https://ingest.example.org',
    );
    const o = ausgabe();
    await main(['otel-headers'], o.aus, { umgebung: u });
    expect(JSON.parse(o.o.out)).toEqual({
      Authorization: 'Bearer smr_neuestoken000000000000000000000',
    });
  });

  it('enroll: abgelaufener Code → 401 → Fehlermeldung, kein Token', async () => {
    const u = testUmgebung({ antworter: () => json({ fehler: 'x' }, 401) });
    const a = ausgabe();
    expect(
      await main(['enroll', 'XXXX-XXXX-XXXX', '--server', 'https://ingest.example.org'], a.aus, {
        umgebung: u,
      }),
    ).toBe(1);
    expect(a.o.err).toContain('Einmalcode ungültig');
    expect(existsSync(join(u.agentDir, 'token'))).toBe(false);
    expect(
      await main(['enroll', 'X', '--server', 'http://ingest.example.org'], ausgabe().aus, {
        umgebung: u,
      }),
    ).toBe(1);
  });

  it('install --hooks mischt Hooks ein, fremde bleiben; uninstall entfernt nur die eigenen', async () => {
    const u = testUmgebung({ fixtures: false });
    eingerichtet(u, { modus: 'hooks' });
    const fremd = {
      theme: 'dark',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/fremder-hook' }] }] },
    };
    writeFileSync(join(u.claudeDir, 'settings.json'), JSON.stringify(fremd));
    expect(
      await main(['install', '--hooks', '--no-register'], ausgabe().aus, {
        umgebung: u,
        aufruf: AUFRUF,
      }),
    ).toBe(0);
    // zweimal installieren: keine Doppelten
    await main(['install', '--hooks', '--no-register'], ausgabe().aus, {
      umgebung: u,
      aufruf: AUFRUF,
    });
    const s = JSON.parse(readFileSync(join(u.claudeDir, 'settings.json'), 'utf8'));
    expect(s.theme).toBe('dark');
    expect(Object.keys(s.hooks).sort()).toEqual([
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
    ]);
    const stop = s.hooks.Stop.flatMap(
      (g: { hooks: { command: string; async?: boolean }[] }) => g.hooks,
    );
    expect(stop.map((h: { command: string }) => h.command)).toEqual([
      '/usr/local/bin/fremder-hook',
      '/opt/node/bin/node /home/dev/.seatmeter/bin/seatmeter-agent.mjs hook Stop',
    ]);
    expect(stop[1].async).toBe(true);
    expect(existsSync(join(u.claudeDir, 'settings.json.seatmeter-sicherung'))).toBe(true);
    await main(['uninstall'], ausgabe().aus, { umgebung: u, aufruf: AUFRUF });
    expect(JSON.parse(readFileSync(join(u.claudeDir, 'settings.json'), 'utf8'))).toEqual(fremd);
  });

  it('install --sweeper-only fasst settings.json nicht an und schreibt systemd-Timer (Linux)', async () => {
    const u = testUmgebung({ fixtures: false });
    eingerichtet(u, { modus: 'hooks' });
    const settings = join(u.claudeDir, 'settings.json');
    writeFileSync(settings, '{"theme":"dark"}');
    const vorher = statSync(settings).mtimeMs;
    const a = ausgabe();
    expect(
      await main(
        [
          'install',
          '--sweeper-only',
          '--include',
          '~/kunden',
          '--exclude',
          '~/kunden/intern',
          '--no-register',
        ],
        a.aus,
        {
          umgebung: u,
          aufruf: AUFRUF,
        },
      ),
    ).toBe(0);
    expect(readFileSync(settings, 'utf8')).toBe('{"theme":"dark"}');
    expect(statSync(settings).mtimeMs).toBe(vorher);
    const k = JSON.parse(readFileSync(join(u.agentDir, 'config.json'), 'utf8'));
    expect(k).toMatchObject({
      modus: 'nur_sweeper',
      include_paths: [join(u.home, 'kunden')],
      exclude_paths: [join(u.home, 'kunden/intern')],
    });
    const timer = readFileSync(join(u.home, '.config/systemd/user/seatmeter-agent.timer'), 'utf8');
    expect(timer).toContain('OnUnitActiveSec=10min');
    const dienst = readFileSync(
      join(u.home, '.config/systemd/user/seatmeter-agent.service'),
      'utf8',
    );
    expect(dienst).toContain(
      'ExecStart=/opt/node/bin/node /home/dev/.seatmeter/bin/seatmeter-agent.mjs scan --push',
    );
    expect(a.o.out).toContain('systemctl --user enable --now seatmeter-agent.timer');
  });

  it('install auf macOS schreibt eine launchd-plist, auf Windows eine Aufgaben-XML', async () => {
    const mac = testUmgebung({ fixtures: false, plattform: 'darwin' });
    eingerichtet(mac);
    await main(['install', '--sweeper-only', '--no-register'], ausgabe().aus, {
      umgebung: mac,
      aufruf: AUFRUF,
    });
    const plist = readFileSync(
      join(mac.home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`),
      'utf8',
    );
    expect(plist).toContain('<integer>600</integer>');
    expect(plist).toContain('<string>scan</string>');
    expect(plist).toContain('<string>--push</string>');
    const win = testUmgebung({ fixtures: false, plattform: 'win32' });
    eingerichtet(win);
    await main(['install', '--sweeper-only'], ausgabe().aus, {
      umgebung: win,
      aufruf: AUFRUF,
      interaktiv: true,
    });
    expect(readFileSync(join(win.agentDir, 'seatmeter-agent-aufgabe.xml'), 'utf8')).toContain(
      '<Interval>PT10M</Interval>',
    );
    const st = ausgabe();
    await main(['status'], st.aus, { umgebung: mac, aufruf: AUFRUF });
    expect(st.o.out).toContain('nur Sweeper');
    expect(st.o.out).toContain('eingerichtet');
  });

  it('hook endet immer mit 0 (Müll auf stdin, fehlende Konfiguration, Modus nur Sweeper)', async () => {
    const u = testUmgebung();
    expect(
      await main(['hook', 'Stop'], ausgabe().aus, { umgebung: u, stdin: async () => 'kein json' }),
    ).toBe(0);
    eingerichtet(u);
    expect(
      await main(['hook', 'Stop'], ausgabe().aus, { umgebung: u, stdin: async () => '{}' }),
    ).toBe(0);
    expect(u.fetch.mitschnitt).toHaveLength(0);
  });

  it('hook Stop scannt nur das Transkript der Sitzung (inkl. Subagenten) und pusht; liest nur 4 Felder', async () => {
    const u = testUmgebung();
    eingerichtet(u, { modus: 'hooks' });
    const transkript = join(u.claudeDir, 'projects', '-home-dev-kunden-alpha', `${S1}.jsonl`);
    const eingabe = JSON.stringify({
      session_id: S1,
      transcript_path: transkript,
      cwd: '/home/dev/kunden/alpha',
      hook_event_name: 'Stop',
      last_assistant_message: 'GEHEIMER-INHALT aus dem Hook',
      tool_input: { command: 'GEHEIM' },
    });
    const start = Date.now();
    expect(
      await main(['hook', 'Stop'], ausgabe().aus, { umgebung: u, stdin: async () => eingabe }),
    ).toBe(0);
    expect(Date.now() - start).toBeLessThan(3500);
    const koerper = u.fetch.mitschnitt.map((m) => m.koerper).join('\n');
    expect(koerper).toContain('req_S1FIX');
    expect(koerper).not.toContain('GEHEIM');
    expect(Object.keys(ladeZustand(u).dateien)).toHaveLength(2);
  });

  it('push: 401 hält an und markiert das Token als ungültig; Warteschlange bleibt', async () => {
    const u = testUmgebung({ antworter: () => json({ fehler: 'x' }, 401) });
    eingerichtet(u);
    const a = ausgabe();
    expect(await main(['scan', '--push'], a.aus, { umgebung: u })).toBe(3);
    expect(ladeZustand(u).token_ungueltig).toBe(true);
    expect(ladeAnfragen(u)).toHaveLength(5);
    const ingest = () => u.fetch.mitschnitt.filter((m) => m.url.includes('/api/ingest/'));
    expect(ingest()).toHaveLength(1);
    // Weitere Läufe senden nichts mehr bis zum neuen enroll.
    await main(['push'], ausgabe().aus, { umgebung: u });
    expect(ingest()).toHaveLength(1);
  });

  it('push: 413 teilt den Batch, 400 verwirft nur den einzelnen Datensatz', async () => {
    let n = 0;
    const u = testUmgebung({
      antworter: (url, koerper, nr) => {
        if (!url.endsWith('/anfragen')) return serverOk(url, koerper, nr);
        const d = JSON.parse(koerper) as { anfragen: { message_id: string }[] };
        n++;
        if (d.anfragen.length > 2) return json({ fehler: 'zu groß' }, 413);
        if (d.anfragen.some((a) => a.message_id === 'msg_04FIX') && d.anfragen.length === 1)
          return json({ fehler: 'x' }, 400);
        if (d.anfragen.some((a) => a.message_id === 'msg_04FIX')) return json({ fehler: 'x' }, 400);
        return serverOk(url, koerper, nr);
      },
    });
    eingerichtet(u);
    const a = ausgabe();
    expect(await main(['scan', '--push'], a.aus, { umgebung: u })).toBe(0);
    expect(n).toBeGreaterThan(3);
    expect(a.o.out).toMatch(/gesendet 4 .*abgelehnt 1/);
    expect(ladeAnfragen(u)).toHaveLength(0);
  });

  it('push: 503 mit Retry-After → Backoff, nächster Sweeper-Lauf wartet', async () => {
    const u = testUmgebung({
      antworter: () => json({ fehler: 'db' }, 503, { 'retry-after': '120' }),
    });
    eingerichtet(u);
    await main(['scan', '--push'], ausgabe().aus, { umgebung: u });
    const z = ladeZustand(u);
    expect(z.push.naechster_versuch).toBe(new Date(u.jetzt().getTime() + 120_000).toISOString());
    expect(z.push.fehlversuche).toBe(1);
    await main(['scan', '--push'], ausgabe().aus, { umgebung: u });
    expect(u.fetch.mitschnitt.filter((m) => m.url.includes('/ingest/'))).toHaveLength(1);
    expect(ladeAnfragen(u)).toHaveLength(5);
  });

  it('leerer Sweeper-Lauf schickt einen Heartbeat (nur Agent-Version), sonst nichts', async () => {
    const u = testUmgebung({ fixtures: false });
    eingerichtet(u);
    const a = ausgabe();
    expect(await main(['scan', '--push'], a.aus, { umgebung: u })).toBe(0);
    expect(a.o.out).toContain('Push: leer, gesendet 0');
    expect(a.o.out).toContain('Heartbeat: ok');
    expect(u.fetch.mitschnitt.filter((m) => m.url.includes('/api/ingest/'))).toHaveLength(0);
    const hb = u.fetch.mitschnitt.filter((m) => m.url.endsWith('/api/agent/v1/heartbeat'));
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({
      url: 'https://ingest.example.org/api/agent/v1/heartbeat',
      methode: 'POST',
    });
    expect(hb[0]?.kopf.authorization).toBe('Bearer smr_testtoken0000000000000000000000');
    expect(JSON.parse(hb[0]?.koerper ?? '{}')).toEqual({ agent_version: AGENT_VERSION });
    const z = ladeZustand(u);
    expect(z.heartbeat).toEqual({ letzter_erfolg: u.jetzt().toISOString(), letzter_fehler: null });
    const s = ausgabe();
    await main(['status'], s.aus, { umgebung: u });
    expect(s.o.out).toContain(`Heartbeat:        ${u.jetzt().toISOString()}`);
    // Auch der Handbefehl push meldet sich.
    await main(['push'], ausgabe().aus, { umgebung: u });
    expect(u.fetch.mitschnitt.filter((m) => m.url.endsWith('/heartbeat'))).toHaveLength(2);
  });

  it('Heartbeat-Fehler (HTTP 500, Netz) blockieren den Push nicht und ändern den Exit-Code nicht', async () => {
    const u = testUmgebung({
      antworter: (url, koerper, nr) =>
        url.endsWith('/heartbeat') ? json({ fehler: 'x' }, 500) : serverOk(url, koerper, nr),
    });
    eingerichtet(u);
    const a = ausgabe();
    expect(await main(['scan', '--push'], a.aus, { umgebung: u })).toBe(0);
    expect(a.o.out).toMatch(/Push: ok, gesendet 5/);
    expect(a.o.out).toContain('Heartbeat: fehlgeschlagen (ignoriert)');
    expect(ladeAnfragen(u)).toHaveLength(0);
    let z = ladeZustand(u);
    expect(z.push.letzter_erfolg).not.toBeNull();
    expect(z.heartbeat).toEqual({
      letzter_erfolg: null,
      letzter_fehler: 'Server antwortet mit HTTP 500',
    });

    const netz = testUmgebung({
      fixtures: false,
      antworter: () => {
        throw new TypeError('fetch failed');
      },
    });
    eingerichtet(netz);
    expect(await main(['scan', '--push'], ausgabe().aus, { umgebung: netz })).toBe(0);
    z = ladeZustand(netz);
    expect(z.heartbeat.letzter_fehler).toBe('Server nicht erreichbar');
    expect(z.token_ungueltig).toBe(false);
  });

  it('Heartbeat 401 markiert das Token als ungültig (Rechner widerrufen), danach kein Heartbeat mehr', async () => {
    const u = testUmgebung({
      fixtures: false,
      antworter: (url, koerper, nr) =>
        url.endsWith('/heartbeat') ? json({ fehler: 'x' }, 401) : serverOk(url, koerper, nr),
    });
    eingerichtet(u);
    const a = ausgabe();
    expect(await main(['scan', '--push'], a.aus, { umgebung: u })).toBe(3);
    expect(a.o.err).toContain('neu registrieren');
    expect(ladeZustand(u).token_ungueltig).toBe(true);
    await main(['scan', '--push'], ausgabe().aus, { umgebung: u });
    expect(u.fetch.mitschnitt.filter((m) => m.url.endsWith('/heartbeat'))).toHaveLength(1);
  });

  it('install --projekt-pfad speichert Pfad → Bezeichnung; ungültige Bezeichnung → Fehler', async () => {
    const u = testUmgebung({ fixtures: false });
    eingerichtet(u);
    const a = ausgabe();
    expect(
      await main(
        [
          'install',
          '--sweeper-only',
          '--include',
          '~/Kunden/acme.de',
          '--projekt-pfad',
          '~/Kunden/acme.de=acme/bereich',
          '--no-register',
        ],
        a.aus,
        { umgebung: u, aufruf: AUFRUF },
      ),
    ).toBe(0);
    const k = JSON.parse(readFileSync(join(u.agentDir, 'config.json'), 'utf8'));
    expect(k.pfad_projekte).toEqual({
      [join(u.home, 'Kunden/acme.de')]: 'acme/bereich',
    });
    const s = ausgabe();
    expect(await main(['status'], s.aus, { umgebung: u, aufruf: AUFRUF })).toBe(0);
    expect(s.o.out).toContain('→ acme/bereich');

    const f = ausgabe();
    expect(
      await main(['install', '--projekt-pfad', '~/x=/etc/passwd', '--no-register'], f.aus, {
        umgebung: u,
        aufruf: AUFRUF,
      }),
    ).toBe(1);
    expect(f.o.err).toContain('--projekt-pfad');
  });
});
