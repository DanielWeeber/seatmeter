// Installation (Architektur §2.2, §10.3): Hooks in ~/.claude/settings.json mischen (fremde Hooks
// bleiben, Exec-Form, `async: true`) und den Sweeper einrichten: launchd (macOS), systemd-User-Timer
// (Linux), Aufgabenplanung-XML (Windows). Im Modus „nur Sweeper“ wird settings.json nicht angefasst,
// außer um früher installierte seatmeter-Hooks wieder zu entfernen.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { schreibeAtomar } from './dateien.js';
import type { Umgebung } from './umgebung.js';

export const HOOK_EREIGNISSE = ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd'] as const;
export const LAUNCHD_LABEL = 'de.weeberwrk.seatmeter-agent';
export const SYSTEMD_NAME = 'seatmeter-agent';

/** Aufruf des Agenten: Node-Binary und Bündel (bzw. Einzeldatei-Binary ohne Node). */
export interface Aufruf {
  programm: string[];
}

export function aktuellerAufruf(): Aufruf {
  const skript = process.argv[1];
  // Einzeldatei-Binary (SEA/bun): argv[1] ist kein Skript, execPath ist der Agent selbst.
  if (!skript || !/\.(mjs|js|cjs)$/.test(skript)) return { programm: [process.execPath] };
  return { programm: [process.execPath, skript] };
}

function shellZitat(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------------------------
// Hooks

interface HookEintrag {
  type?: string;
  command?: string;
  async?: boolean;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGruppe {
  matcher?: string;
  hooks?: HookEintrag[];
  [k: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGruppe[]> };

const istUnserHook = (h: HookEintrag) =>
  typeof h.command === 'string' && /seatmeter-agent/.test(h.command) && / hook /.test(h.command);

export const settingsPfad = (u: Umgebung) => join(u.claudeDir, 'settings.json');

function ladeSettings(u: Umgebung): Settings {
  const pfad = settingsPfad(u);
  if (!existsSync(pfad)) return {};
  const d = JSON.parse(readFileSync(pfad, 'utf8')) as unknown;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) {
    throw new Error('settings.json ist kein JSON-Objekt; nichts geändert');
  }
  return d as Settings;
}

function ohneUnsereHooks(s: Settings): { s: Settings; entfernt: number } {
  let entfernt = 0;
  const hooks: Record<string, HookGruppe[]> = {};
  for (const [ereignis, gruppen] of Object.entries(s.hooks ?? {})) {
    const neu: HookGruppe[] = [];
    for (const g of Array.isArray(gruppen) ? gruppen : []) {
      const liste = (g.hooks ?? []).filter((h) => {
        const unser = istUnserHook(h);
        if (unser) entfernt++;
        return !unser;
      });
      if (liste.length > 0 || !Array.isArray(g.hooks)) neu.push({ ...g, hooks: liste });
    }
    if (neu.length > 0) hooks[ereignis] = neu;
  }
  const kopie: Settings = { ...s };
  if (Object.keys(hooks).length > 0) kopie.hooks = hooks;
  else delete kopie.hooks;
  return { s: kopie, entfernt };
}

function schreibeSettings(u: Umgebung, s: Settings): void {
  const pfad = settingsPfad(u);
  if (existsSync(pfad)) copyFileSync(pfad, `${pfad}.seatmeter-sicherung`);
  schreibeAtomar(pfad, `${JSON.stringify(s, null, 2)}\n`, 0o600);
}

export function hookBefehl(a: Aufruf, ereignis: string): string {
  return [...a.programm, 'hook', ereignis].map(shellZitat).join(' ');
}

/** Mischt die seatmeter-Hooks ein (vorhandene seatmeter-Hooks werden ersetzt, fremde bleiben). */
export function hooksInstallieren(u: Umgebung, a: Aufruf): number {
  const { s } = ohneUnsereHooks(ladeSettings(u));
  const hooks = { ...(s.hooks ?? {}) };
  for (const ereignis of HOOK_EREIGNISSE) {
    hooks[ereignis] = [
      ...(hooks[ereignis] ?? []),
      { hooks: [{ type: 'command', command: hookBefehl(a, ereignis), async: true, timeout: 10 }] },
    ];
  }
  schreibeSettings(u, { ...s, hooks });
  return HOOK_EREIGNISSE.length;
}

/** Entfernt nur seatmeter-Hooks; schreibt settings.json nur, wenn es welche gab. */
export function hooksEntfernen(u: Umgebung): number {
  if (!existsSync(settingsPfad(u))) return 0;
  const { s, entfernt } = ohneUnsereHooks(ladeSettings(u));
  if (entfernt > 0) schreibeSettings(u, s);
  return entfernt;
}

export function hooksInstalliert(u: Umgebung): boolean {
  try {
    const s = ladeSettings(u);
    return Object.values(s.hooks ?? {}).some((g) =>
      (Array.isArray(g) ? g : []).some((x) => (x.hooks ?? []).some(istUnserHook)),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Sweeper

export interface SweeperDateien {
  plattform: 'macos' | 'linux' | 'windows';
  dateien: { pfad: string; inhalt: string }[];
  /** Befehle zum Registrieren (werden nur interaktiv bzw. mit --register ausgeführt). */
  registrieren: string[][];
  abmelden: string[][];
}

function sweeperArgumente(a: Aufruf): string[] {
  return [...a.programm, 'scan', '--push'];
}

function zusatzUmgebung(u: Umgebung): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['SEATMETER_HOME', 'CLAUDE_CONFIG_DIR', 'SEATMETER_TOKEN_DATEI']) {
    const v = u.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export function launchdPlist(u: Umgebung, a: Aufruf, intervallMin: number): string {
  const args = sweeperArgumente(a)
    .map((x) => `    <string>${xml(x)}</string>`)
    .join('\n');
  const env = Object.entries(zusatzUmgebung(u))
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env ? `  <key>EnvironmentVariables</key>\n  <dict>\n${env}\n  </dict>\n` : ''}  <key>StartInterval</key>
  <integer>${intervallMin * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function systemdDienst(u: Umgebung, a: Aufruf): string {
  const env = Object.entries(zusatzUmgebung(u))
    .map(([k, v]) => `Environment=${shellZitat(`${k}=${v}`)}\n`)
    .join('');
  return `[Unit]
Description=seatmeter-agent Sweeper (Transkript-Zähler, nur Nutzungsfelder)

[Service]
Type=oneshot
${env}ExecStart=${sweeperArgumente(a).map(shellZitat).join(' ')}
Nice=10
IOSchedulingClass=idle
`;
}

function systemdTimer(intervallMin: number): string {
  return `[Unit]
Description=seatmeter-agent Sweeper alle ${intervallMin} min

[Timer]
OnBootSec=2min
OnUnitActiveSec=${intervallMin}min
AccuracySec=1min

[Install]
WantedBy=timers.target
`;
}

function windowsAufgabe(a: Aufruf, intervallMin: number): string {
  const [prog, ...rest] = sweeperArgumente(a);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>seatmeter-agent Sweeper (Transkript-Zähler, nur Nutzungsfelder)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${intervallMin}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(prog ?? '')}</Command>
      <Arguments>${xml(rest.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function sweeperDateien(u: Umgebung, a: Aufruf, intervallMin: number): SweeperDateien {
  if (u.plattform === 'darwin') {
    const pfad = join(u.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    return {
      plattform: 'macos',
      dateien: [{ pfad, inhalt: launchdPlist(u, a, intervallMin) }],
      registrieren: [
        ['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`],
        ['launchctl', 'bootstrap', `gui/${uid}`, pfad],
      ],
      abmelden: [['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`]],
    };
  }
  if (u.plattform === 'win32') {
    const pfad = join(u.agentDir, 'seatmeter-agent-aufgabe.xml');
    return {
      plattform: 'windows',
      dateien: [{ pfad, inhalt: windowsAufgabe(a, intervallMin) }],
      registrieren: [['schtasks', '/Create', '/TN', SYSTEMD_NAME, '/XML', pfad, '/F']],
      abmelden: [['schtasks', '/Delete', '/TN', SYSTEMD_NAME, '/F']],
    };
  }
  const basis = join(u.env.XDG_CONFIG_HOME ?? join(u.home, '.config'), 'systemd', 'user');
  return {
    plattform: 'linux',
    dateien: [
      { pfad: join(basis, `${SYSTEMD_NAME}.service`), inhalt: systemdDienst(u, a) },
      { pfad: join(basis, `${SYSTEMD_NAME}.timer`), inhalt: systemdTimer(intervallMin) },
    ],
    registrieren: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', `${SYSTEMD_NAME}.timer`],
    ],
    abmelden: [
      ['systemctl', '--user', 'disable', '--now', `${SYSTEMD_NAME}.timer`],
      ['systemctl', '--user', 'daemon-reload'],
    ],
  };
}

export function sweeperSchreiben(d: SweeperDateien): void {
  for (const f of d.dateien) schreibeAtomar(f.pfad, f.inhalt, 0o644);
}

/** Führt Befehle aus; der erste darf scheitern (z. B. `bootout` ohne geladenen Dienst). */
export function befehleAusfuehren(befehle: string[][], ersterDarfScheitern: boolean): boolean {
  let ok = true;
  befehle.forEach(([prog, ...args], i) => {
    if (!prog) return;
    try {
      execFileSync(prog, args, { stdio: 'ignore', timeout: 15_000 });
    } catch {
      if (!(ersterDarfScheitern && i === 0)) ok = false;
    }
  });
  return ok;
}

export function sweeperEntfernen(d: SweeperDateien, abmelden: boolean): string[] {
  if (abmelden) befehleAusfuehren(d.abmelden, false);
  const entfernt: string[] = [];
  for (const f of d.dateien) {
    if (existsSync(f.pfad)) {
      rmSync(f.pfad, { force: true });
      entfernt.push(f.pfad);
    }
  }
  return entfernt;
}

export function sweeperInstalliert(d: SweeperDateien): boolean {
  return d.dateien.every((f) => existsSync(f.pfad));
}
