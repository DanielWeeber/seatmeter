// CLI `seatmeter-agent` (Architektur §2.2): enroll, install, hook, scan, push, otel-headers,
// status, uninstall. Texte deutsch. Der Agent sendet nur Zähler und Metadaten laut
// `agentPushSchema`; Inhalte, cwd, Pfade, Hostnamen, Branch-Namen und E-Mail verlassen den
// Rechner nie. Aus dem Branch-Namen wird nur der Issue-Schlüssel (z. B. `ABC-123`) gesendet.
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  enrollmentAntwortSchema,
  issueSchluesselAus,
  issueSchluesselOtelWert,
  OTEL_ATTRIBUT_ISSUE,
  type AgentSitzung,
} from '@seatmeter/shared';
import { authHinweis } from './auth-hinweis.js';
import { leseJson, schreibeJson } from './dateien.js';
import {
  istEingeschlossen,
  ladeLokal,
  istPfadProjektName,
  normalisierePfad,
  pfadServer,
  speichereLokal,
  speichereServerKonfig,
  wirksameKonfig,
  type LokaleKonfig,
} from './konfig.js';
import {
  aktuellerAufruf,
  befehleAusfuehren,
  hooksEntfernen,
  hooksInstallieren,
  hooksInstalliert,
  sweeperDateien,
  sweeperEntfernen,
  sweeperInstalliert,
  sweeperSchreiben,
  type Aufruf,
} from './installieren.js';
import { logger, type Logger } from './log.js';
import { projektFuer } from './projekt.js';
import {
  AGENT_VERSION,
  heartbeat,
  konfigAktualisieren,
  pruefeServerUrl,
  pushe,
  type HeartbeatStatus,
} from './push.js';
import { dateienDerSitzung, scanne } from './scan.js';
import { mitSperre } from './sperre.js';
import { ladeToken, loescheToken, speichereToken } from './token.js';
import { standardUmgebung, type Umgebung } from './umgebung.js';
import { sitzungenMergen, warteschlangeGroesse } from './warteschlange.js';
import { ladeZustand, speichereZustand } from './zustand.js';

export { AGENT_VERSION } from './push.js';

export interface Ausgabe {
  out: (t: string) => void;
  err: (t: string) => void;
}

export interface CliOptionen {
  /** Für Tests: Umgebung ersetzen. */
  umgebung?: Umgebung;
  /** Für Tests: stdin des Hooks. */
  stdin?: () => Promise<string>;
  /** Für Tests: Aufruf des Agenten (Hooks, Sweeper). */
  aufruf?: Aufruf;
  /** Interaktiv (TTY): Sweeper sofort registrieren. */
  interaktiv?: boolean;
  /** Für Tests: Arbeitsverzeichnis (`otel-ressource`). */
  cwd?: string;
}

export const BEFEHLE: ReadonlyArray<[string, string]> = [
  [
    'enroll <code> --server <url>',
    'Rechner mit Einmalcode registrieren (Rechner-Token in den Schlüsselbund)',
  ],
  [
    'install [--hooks|--sweeper-only] [--include <pfad>…] [--exclude <pfad>…] [--projekt-pfad <pfad>=<name>…] [--register|--no-register]',
    'Hooks in ~/.claude/settings.json mischen und/oder Sweeper einrichten',
  ],
  [
    'hook <Event>',
    'Hook-Handler für SessionStart, Stop, SubagentStop, SessionEnd (endet immer mit 0)',
  ],
  ['scan [--push]', 'Geänderte Transkripte einlesen (nur usage-Felder), mit --push danach senden'],
  ['push', 'Warteschlange an den Server senden'],
  ['otel-headers', 'Header für otelHeadersHelper ausgeben (Rechner-Token)'],
  [
    'otel-ressource',
    'Für den Start-Wrapper: OTEL_RESOURCE_ATTRIBUTES mit dem Issue-Schlüssel des aktuellen Branches ausgeben (leer ohne Schlüssel)',
  ],
  ['status', 'Registrierung, Modus, Pfad-Filter, letzte Übertragung und Warteschlange anzeigen'],
  ['uninstall [--alles]', 'Hooks und Sweeper entfernen (--alles: auch Token und ~/.seatmeter)'],
];

export function hilfe(): string {
  return [
    `seatmeter-agent ${AGENT_VERSION}`,
    '',
    'Aufruf: seatmeter-agent <befehl> [optionen] [--verbose]',
    '',
    'Befehle:',
    ...BEFEHLE.map(([b, t]) => `  ${b}\n      ${t}`),
    '',
    'Gesendet werden nur Token-Zähler, Modell, Zeitpunkt, Sitzungs-ID, die normalisierte Repo-URL',
    'und der Issue-Schlüssel aus dem Branch-Namen (z. B. ABC-123, nur der Schlüssel).',
    'Nie gesendet: Inhalte, Arbeitsverzeichnis, Dateipfade, Hostnamen, Branch-Namen, E-Mail.',
    '',
  ].join('\n');
}

interface Argumente {
  positionen: string[];
  flags: Set<string>;
  werte: Map<string, string[]>;
}

const MIT_WERT = new Set(['--server', '--include', '--exclude', '--intervall', '--projekt-pfad']);

export function parseArgumente(argv: string[]): Argumente {
  const a: Argumente = { positionen: [], flags: new Set(), werte: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i] as string;
    const gleich = x.indexOf('=');
    if (x.startsWith('--') && gleich > 0 && MIT_WERT.has(x.slice(0, gleich))) {
      const k = x.slice(0, gleich);
      a.werte.set(k, [...(a.werte.get(k) ?? []), x.slice(gleich + 1)]);
    } else if (MIT_WERT.has(x)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} braucht einen Wert`);
      a.werte.set(x, [...(a.werte.get(x) ?? []), v]);
    } else if (x.startsWith('-')) a.flags.add(x);
    else a.positionen.push(x);
  }
  return a;
}

function osName(u: Umgebung): 'macos' | 'linux' | 'windows' {
  return u.plattform === 'darwin' ? 'macos' : u.plattform === 'win32' ? 'windows' : 'linux';
}

const pfadRechner = (u: Umgebung) => join(u.agentDir, 'rechner.json');

async function stdinLesen(maxMs: number): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((fertig) => {
    let daten = '';
    const t = setTimeout(() => fertig(daten), maxMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      daten += c;
      if (daten.length > 1_000_000) {
        clearTimeout(t);
        fertig('');
      }
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      fertig(daten);
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      fertig('');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Befehle

async function enroll(u: Umgebung, a: Argumente, aus: Ausgabe, log: Logger): Promise<number> {
  const code = a.positionen[1];
  const server = a.werte.get('--server')?.at(-1) ?? ladeLokal(u).server_url;
  if (!code || !server) {
    aus.err('Aufruf: seatmeter-agent enroll <einmalcode> --server <https://ingest.example.org>\n');
    return 1;
  }
  const basis = pruefeServerUrl(server);
  let r: Response;
  try {
    r = await u.fetch(`${basis}/api/agent/v1/enroll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `seatmeter-agent/${AGENT_VERSION}`,
      },
      body: JSON.stringify({ code, os: osName(u), agent_version: AGENT_VERSION }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    aus.err('Server nicht erreichbar.\n');
    return 1;
  }
  if (r.status === 401) {
    aus.err('Einmalcode ungültig, abgelaufen oder schon benutzt.\n');
    return 1;
  }
  if (r.status !== 201) {
    aus.err(`Registrierung fehlgeschlagen (HTTP ${r.status}).\n`);
    return 1;
  }
  const antwort = enrollmentAntwortSchema.safeParse(await r.json().catch(() => null));
  if (!antwort.success) {
    aus.err('Unerwartete Antwort des Servers.\n');
    return 1;
  }
  const speicher = speichereToken(u, antwort.data.token);
  speichereServerKonfig(u, antwort.data.konfiguration);
  const lokal = ladeLokal(u);
  speichereLokal(u, { ...lokal, server_url: basis });
  schreibeJson(pfadRechner(u), {
    rechner_id: antwort.data.rechner_id,
    server_url: basis,
    registriert: u.jetzt().toISOString(),
  });
  const z = ladeZustand(u);
  z.token_ungueltig = false;
  z.push.naechster_versuch = null;
  speichereZustand(u, z);
  log.info('Rechner registriert', { speicher });
  aus.out(
    `Rechner registriert (ID ${antwort.data.rechner_id}). Token liegt im ${
      speicher === 'schluesselbund' ? 'Schlüsselbund' : `Datei ${join(u.agentDir, 'token')} (0600)`
    }.\nWeiter: seatmeter-agent install --sweeper-only --include <pfad>   oder   seatmeter-agent install --hooks\n`,
  );
  return 0;
}

async function install(
  u: Umgebung,
  a: Argumente,
  aus: Ausgabe,
  o: CliOptionen,
  log: Logger,
): Promise<number> {
  if (a.flags.has('--hooks') && a.flags.has('--sweeper-only')) {
    aus.err('--hooks und --sweeper-only schließen sich aus.\n');
    return 1;
  }
  const lokal: LokaleKonfig = { ...ladeLokal(u) };
  if (a.flags.has('--sweeper-only')) lokal.modus = 'nur_sweeper';
  if (a.flags.has('--hooks')) lokal.modus = 'hooks';
  const inc = a.werte.get('--include');
  const exc = a.werte.get('--exclude');
  if (inc) lokal.include_paths = inc.map((p) => normalisierePfad(u, p));
  if (exc) lokal.exclude_paths = exc.map((p) => normalisierePfad(u, p));
  // --projekt-pfad <pfad>=<name>: Sitzungen ohne Git-Remote unter <pfad> zählen als Projekt <name>.
  const pp = a.werte.get('--projekt-pfad');
  if (pp) {
    const regeln: Record<string, string> = {};
    for (const eintrag of pp) {
      const trenner = eintrag.lastIndexOf('=');
      const pfad = trenner > 0 ? eintrag.slice(0, trenner).trim() : '';
      const name = trenner > 0 ? eintrag.slice(trenner + 1).trim() : '';
      if (!pfad || !istPfadProjektName(name)) {
        aus.err(
          `--projekt-pfad erwartet <pfad>=<name> (Name: Buchstaben, Ziffern, Leerzeichen, ._/-; höchstens 100 Zeichen): ${eintrag}\n`,
        );
        return 1;
      }
      regeln[normalisierePfad(u, pfad)] = name;
    }
    lokal.pfad_projekte = regeln;
  }
  const intervall = a.werte.get('--intervall')?.at(-1);
  if (intervall) lokal.sweeper_intervall_min = Math.min(15, Math.max(5, Number(intervall) || 10));
  speichereLokal(u, lokal);
  const k = wirksameKonfig(u);
  const aufruf = o.aufruf ?? aktuellerAufruf();

  if (k.modus === 'hooks') {
    hooksInstallieren(u, aufruf);
    aus.out(`Hooks eingetragen (SessionStart, Stop, SubagentStop, SessionEnd; async).\n`);
  } else {
    const entfernt = hooksEntfernen(u);
    if (entfernt > 0)
      aus.out(`${entfernt} frühere seatmeter-Hooks entfernt (Modus nur Sweeper).\n`);
  }
  const d = sweeperDateien(u, aufruf, k.sweeper_intervall_min);
  sweeperSchreiben(d);
  aus.out(
    `Sweeper (${d.plattform}, alle ${k.sweeper_intervall_min} min): ${d.dateien.map((f) => f.pfad).join(', ')}\n`,
  );
  const registrieren =
    !a.flags.has('--no-register') &&
    d.plattform !== 'windows' &&
    (a.flags.has('--register') || (o.interaktiv ?? false));
  if (registrieren) {
    const ok = befehleAusfuehren(d.registrieren, d.plattform === 'macos');
    aus.out(
      ok
        ? 'Sweeper registriert.\n'
        : 'Sweeper konnte nicht registriert werden; Befehle siehe README.\n',
    );
  } else {
    aus.out(`Zum Aktivieren: ${d.registrieren.map((b) => b.join(' ')).at(-1)}\n`);
  }
  aus.out(
    `Pfad-Filter: ${k.include_paths.length ? k.include_paths.join(', ') : 'alle Sitzungen'}${
      k.exclude_paths.length ? `; ausgenommen ${k.exclude_paths.join(', ')}` : ''
    }\n`,
  );
  log.info('install', { modus: k.modus, registriert: registrieren });
  return 0;
}

async function scanUndPush(
  u: Umgebung,
  aus: Ausgabe,
  log: Logger,
  mitPush: boolean,
  nurPush = false,
  erzwingen = false,
): Promise<number> {
  const k = wirksameKonfig(u);
  const r = await mitSperre(u, async () => {
    const z = ladeZustand(u);
    let s = null;
    if (!nurPush) {
      s = scanne(u, k, z, { hinweis: authHinweis(u) });
      speichereZustand(u, z);
      log.info('scan', { ...s });
    }
    let p = null;
    let hb: HeartbeatStatus | null = null;
    if (mitPush) {
      const t = ladeToken(u);
      // Server-Konfiguration höchstens einmal am Tag auffrischen.
      const alter = statSync(pfadServer(u), { throwIfNoEntry: false });
      if (t && k.server_url && (!alter || u.jetzt().getTime() - alter.mtimeMs > 86_400_000)) {
        await konfigAktualisieren(u, pruefeServerUrl(k.server_url), t.token);
      }
      p = await pushe(u, k, z, t?.token ?? null, log, { erzwingen });
      speichereZustand(u, z);
      log.info('push', { ...p });
      // Lebenszeichen nach jedem Push-Lauf, auch bei leerer Warteschlange (sonst bleibt
      // rechner.zuletzt_gesehen nachts stehen). Fehler blockieren nichts und ändern den Exit-Code nicht.
      hb = await heartbeat(u, k, z, t?.token ?? null, log);
      speichereZustand(u, z);
      if (hb !== 'ok') log.info('heartbeat', { status: hb });
    }
    return { s, p, hb };
  });
  if (r === 'gesperrt') {
    aus.err('Ein anderer seatmeter-agent-Lauf ist aktiv; übersprungen.\n');
    return 0;
  }
  if (r.s) {
    aus.out(
      `Scan: ${r.s.dateien} Transkripte, ${r.s.geaendert} geändert, ${r.s.anfragen} Anfragen neu in der Warteschlange, ${r.s.ausserhalb} Zeilen außerhalb des Pfad-Filters (bleiben lokal).\n`,
    );
  }
  if (r.p) {
    const p = r.p;
    aus.out(
      `Push: ${p.status}, gesendet ${p.gesendet} (neu ${p.angenommen}, wiederholt ${p.wiederholt}, verworfen ${p.verworfen}, abgelehnt ${p.abgelehnt}), Sitzungen ${p.sitzungen}, offen ${p.rest}.\n`,
    );
    if (r.hb && r.hb !== 'uebersprungen') {
      aus.out(
        `Heartbeat: ${r.hb === 'ok' ? 'ok' : r.hb === 'fehler' ? 'fehlgeschlagen (ignoriert)' : 'Token ungültig'}.\n`,
      );
    }
    if (p.status === 'token_ungueltig' || r.hb === 'token_ungueltig') {
      aus.err(
        'Rechner-Token ungültig oder widerrufen: bitte neu registrieren (seatmeter-agent enroll).\n',
      );
      return 3;
    }
    if (p.status === 'kein_server') {
      aus.err('Kein Server konfiguriert: zuerst seatmeter-agent enroll <code> --server <url>.\n');
      return 1;
    }
  }
  return 0;
}

interface HookEingabe {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
}

/** Hook: liest nur session_id, transcript_path, cwd, hook_event_name; endet immer mit 0. */
async function hook(u: Umgebung, a: Argumente, o: CliOptionen, log: Logger): Promise<number> {
  const start = Date.now();
  const budget = 3000;
  const arbeit = (async () => {
    const roh = await (o.stdin ? o.stdin() : stdinLesen(1000));
    let ein: HookEingabe = {};
    try {
      const d = JSON.parse(roh) as Record<string, unknown>;
      // Nur die vier erlaubten Felder übernehmen; tool_input, last_assistant_message usw. nie.
      ein = {
        session_id: d.session_id,
        transcript_path: d.transcript_path,
        cwd: d.cwd,
        hook_event_name: d.hook_event_name,
      };
    } catch {
      // ohne Eingabe: nur Push
    }
    const ereignis =
      typeof ein.hook_event_name === 'string' ? ein.hook_event_name : (a.positionen[1] ?? '');
    const k = wirksameKonfig(u);
    if (k.modus !== 'hooks') return;
    const cwd = typeof ein.cwd === 'string' ? ein.cwd : null;
    const sessionId =
      typeof ein.session_id === 'string' && ein.session_id.length <= 200 ? ein.session_id : null;
    const pfad = typeof ein.transcript_path === 'string' ? ein.transcript_path : null;
    await mitSperre(
      u,
      async () => {
        const z = ladeZustand(u);
        const hinweis = authHinweis(u);
        if (ereignis === 'SessionStart' && sessionId && istEingeschlossen(cwd, k)) {
          const s: AgentSitzung = {
            session_id: sessionId,
            start: u.jetzt().toISOString(),
            ende: null,
            cc_version: null,
            projekt: cwd ? projektFuer(u, z, cwd, k) : null,
            auth_hinweis: hinweis,
          };
          sitzungenMergen(u, [s]);
        } else if (pfad && sessionId) {
          const dateien = dateienDerSitzung(pfad);
          scanne(u, k, z, { hinweis, nurDateien: dateien });
        }
        speichereZustand(u, z);
        const rest = budget - (Date.now() - start) - 200;
        if (rest > 300) {
          const t = ladeToken(u);
          await pushe(u, k, z, t?.token ?? null, log, { timeoutMs: rest });
          speichereZustand(u, z);
        }
      },
      500,
    );
  })();
  try {
    await Promise.race([arbeit, new Promise((r) => setTimeout(r, budget).unref())]);
  } catch {
    log.fehler('Hook-Fehler (ignoriert)');
  }
  return 0;
}

async function otelHeaders(u: Umgebung, aus: Ausgabe): Promise<number> {
  const t = ladeToken(u);
  aus.out(`${JSON.stringify(t ? { Authorization: `Bearer ${t.token}` } : {})}\n`);
  return 0;
}

/**
 * Start-Wrapper (Quelle A): Issue-Schlüssel des aktuellen Branches als Ressourcen-Attribut
 * `seatmeter.issue_schluessel`, angehängt an ein vorhandenes `OTEL_RESOURCE_ATTRIBUTES`. Ausgabe
 * leer, wenn der Branch keinen Schlüssel trägt oder das Verzeichnis außerhalb des Pfad-Filters
 * liegt. Näherung: Branch beim Start der Sitzung. Der Branch-Name wird nie ausgegeben.
 */
async function otelRessource(u: Umgebung, aus: Ausgabe, o: CliOptionen): Promise<number> {
  const cwd = o.cwd ?? process.cwd();
  if (!istEingeschlossen(cwd, wirksameKonfig(u))) return 0;
  const schluessel = issueSchluesselAus(u.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd));
  if (schluessel.length === 0) return 0;
  const vorhanden = (u.env.OTEL_RESOURCE_ATTRIBUTES ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '' && !t.startsWith(`${OTEL_ATTRIBUT_ISSUE}=`));
  aus.out(
    `${[...vorhanden, `${OTEL_ATTRIBUT_ISSUE}=${issueSchluesselOtelWert(schluessel)}`].join(',')}\n`,
  );
  return 0;
}

async function status(u: Umgebung, aus: Ausgabe, o: CliOptionen): Promise<number> {
  const k = wirksameKonfig(u);
  const z = ladeZustand(u);
  const t = ladeToken(u);
  const rechner = leseJson<{ rechner_id: string; server_url: string; registriert: string }>(
    pfadRechner(u),
  );
  const d = sweeperDateien(u, o.aufruf ?? aktuellerAufruf(), k.sweeper_intervall_min);
  const q = warteschlangeGroesse(u);
  const zeilen = [
    `seatmeter-agent ${AGENT_VERSION}`,
    `Registriert:      ${rechner ? `ja (Rechner ${rechner.rechner_id}, seit ${rechner.registriert})` : 'nein'}`,
    `Server:           ${k.server_url ?? '–'}`,
    `Token:            ${t ? (t.speicher === 'schluesselbund' ? 'Schlüsselbund' : 'Datei (0600)') : 'fehlt'}${z.token_ungueltig ? ' – UNGÜLTIG, neu registrieren' : ''}`,
    `Modus:            ${k.modus === 'hooks' ? 'Hooks + Sweeper' : 'nur Sweeper'}`,
    `Hooks:            ${hooksInstalliert(u) ? 'eingetragen' : 'keine'}`,
    `Sweeper:          ${sweeperInstalliert(d) ? `eingerichtet (${d.dateien.map((f) => f.pfad).join(', ')})` : 'nicht eingerichtet'}, alle ${k.sweeper_intervall_min} min`,
    `Pfad-Filter:      ${k.include_paths.length ? k.include_paths.join(', ') : 'alle Sitzungen'}`,
    `Ausgenommen:      ${k.exclude_paths.length ? k.exclude_paths.join(', ') : '–'}`,
    `Pfad-Projekte:    ${
      k.pfad_projekte.length
        ? [
            ...new Map(
              k.pfad_projekte.map((r) => [r.name + r.pfad, `${r.pfad} → ${r.name}`]),
            ).values(),
          ].join(', ')
        : '–'
    }`,
    `Rückfüllung:      ${k.rueckfuellung_tage} Tage`,
    `Letzter Scan:     ${z.letzter_scan ?? '–'} (${Object.keys(z.dateien).length} Transkripte im Zustand)`,
    `Letzter Push:     ${z.push.letzter_erfolg ?? '–'}${z.push.letzter_fehler ? ` (Fehler: ${z.push.letzter_fehler})` : ''}`,
    `Nächster Versuch: ${z.push.naechster_versuch ?? 'sofort'}`,
    `Heartbeat:        ${z.heartbeat.letzter_erfolg ?? '–'}${z.heartbeat.letzter_fehler ? ` (Fehler: ${z.heartbeat.letzter_fehler})` : ''}`,
    `Gesendet gesamt:  ${z.push.gesendet_gesamt} Anfragen`,
    `Warteschlange:    ${q.anfragen} Anfragen, ${q.sitzungen} Sitzungen`,
    '',
  ];
  aus.out(zeilen.join('\n'));
  return 0;
}

async function uninstall(u: Umgebung, a: Argumente, aus: Ausgabe, o: CliOptionen): Promise<number> {
  const entfernt = hooksEntfernen(u);
  const k = wirksameKonfig(u);
  const d = sweeperDateien(u, o.aufruf ?? aktuellerAufruf(), k.sweeper_intervall_min);
  const dateien = sweeperEntfernen(d, d.plattform !== 'windows' || (o.interaktiv ?? false));
  aus.out(
    `${entfernt} Hooks entfernt; Sweeper-Dateien entfernt: ${dateien.length ? dateien.join(', ') : 'keine'}.\n`,
  );
  if (a.flags.has('--alles')) {
    const rechner = leseJson<{ rechner_id: string }>(pfadRechner(u));
    loescheToken(u);
    if (existsSync(u.agentDir)) rmSync(u.agentDir, { recursive: true, force: true });
    aus.out(
      `Token und ${u.agentDir} gelöscht.${rechner ? ` Rechner ${rechner.rechner_id} im Dashboard widerrufen.` : ''}\n`,
    );
  }
  return 0;
}

export async function main(argv: string[], aus: Ausgabe, o: CliOptionen = {}): Promise<number> {
  let a: Argumente;
  try {
    a = parseArgumente(argv);
  } catch (f) {
    aus.err(`${f instanceof Error ? f.message : String(f)}\n`);
    return 1;
  }
  const befehl = a.positionen[0];
  if (a.flags.has('--version') || befehl === 'version') {
    aus.out(`${AGENT_VERSION}\n`);
    return 0;
  }
  if (!befehl || a.flags.has('--help') || a.flags.has('-h') || befehl === 'help') {
    aus.out(hilfe());
    return 0;
  }
  const u = o.umgebung ?? standardUmgebung(process.env, a.flags.has('--verbose'));
  const log = logger(u, aus.err);
  try {
    switch (befehl) {
      case 'enroll':
        return await enroll(u, a, aus, log);
      case 'install':
        return await install(u, a, aus, o, log);
      case 'hook':
        return await hook(u, a, o, log);
      case 'scan':
        return await scanUndPush(u, aus, log, a.flags.has('--push'));
      case 'push':
        return await scanUndPush(u, aus, log, true, true, true);
      case 'otel-headers':
        return await otelHeaders(u, aus);
      case 'otel-ressource':
        return await otelRessource(u, aus, o);
      case 'status':
        return await status(u, aus, o);
      case 'uninstall':
        return await uninstall(u, a, aus, o);
      default:
        aus.err(`Unbekannter Befehl: ${befehl}\n\n${hilfe()}`);
        return 1;
    }
  } catch (f) {
    if (befehl === 'hook' || befehl === 'otel-ressource') return 0;
    log.fehler('Befehl fehlgeschlagen', {
      befehl,
      fehler: f instanceof Error ? f.name : 'unbekannt',
    });
    aus.err(`Fehler: ${f instanceof Error ? f.message : String(f)}\n`);
    return 1;
  }
}
