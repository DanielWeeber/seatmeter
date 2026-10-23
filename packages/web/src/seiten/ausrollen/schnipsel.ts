// Reine Schnipsel-Bausteine der Seite „Ausrollen“ (Architektur §10): Managed Settings, Benutzer-
// Einstellungen, Start-Wrapper und Agent-Befehle aus der Konfiguration des Mandanten. Ohne React,
// damit jede Ausgabe einzeln testbar ist. Ein echtes Token kommt nur über `token` herein (frisch
// erzeugtes Mandanten-Token); sonst steht der Platzhalter im Schnipsel.
import type { AusrollenKonfiguration } from '@seatmeter/shared';

export const TOKEN_PLATZHALTER = '<MANDANTEN-TOKEN>';
export const EINMALCODE_PLATZHALTER = '<EINMALCODE>';
export const PFAD_PLATZHALTER = '<PFAD>';

/** Standard der Pfadliste für Start-Wrapper und Sweeper (`--include`). */
export const STANDARD_PFADE = '$HOME/kunden';

/**
 * `helper` = Rechner-Token über den Agenten (`otelHeadersHelper`, empfohlen),
 * `fest` = ein Mandanten-Token für alle Rechner (`OTEL_EXPORTER_OTLP_HEADERS`).
 */
export type KopfzeilenArt = 'helper' | 'fest';

export interface SchnipselOptionen {
  kopfzeilen: KopfzeilenArt;
  /** Klartext eines frisch erzeugten Mandanten-Tokens (nur Variante `fest`), sonst Platzhalter. */
  token?: string | null;
  /** Befehl bzw. Pfad des Agenten, z. B. `AGENT_STANDARD_PFAD`. */
  agentPfad: string;
  /** `forceLoginMethod`/`forceLoginOrgUUID` setzen (nur mit Organisationen, nur MDM). */
  orgFestlegen: boolean;
}

// ---------------------------------------------------------------------------------------------
// Shell-Quoting

/** Zeichen, die in einem Shell-Wort ohne Anführungszeichen unverändert bleiben. */
const SICHER = /^[A-Za-z0-9_./:@%+=,-]+$/;
/** Führendes `~`, `$HOME` oder `${HOME}` (nur als ganzes Pfadelement). */
const HOME = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** Text in einfachen Anführungszeichen (keinerlei Ersetzung durch die Shell). */
export function shEinfach(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Shell-Wort: unverändert, wenn nur sichere Zeichen vorkommen, sonst in einfachen Anführungszeichen. */
export function shWort(text: string): string {
  return SICHER.test(text) ? text : shEinfach(text);
}

/** Inhalt für doppelte Anführungszeichen: `\`, `"`, `$` und Backtick maskieren. */
function doppeltInhalt(text: string): string {
  return text.replace(/[\\"$`]/g, '\\$&');
}

/** Zerlegt einen Pfad in `$HOME`-Anteil (`~`, `$HOME`, `${HOME}`) und Rest. */
function homeTeilen(pfad: string): { home: boolean; rest: string } {
  const m = HOME.exec(pfad);
  return m ? { home: true, rest: pfad.slice(m[0].length) } : { home: false, rest: pfad };
}

/**
 * Pfad als Shell-Wort, in dem `$HOME` (auch aus `~`) erweitert wird, alles andere wörtlich bleibt.
 * Ohne Sonderzeichen bleibt der Pfad lesbar (`$HOME/.seatmeter/bin/seatmeter-agent`).
 */
export function pfadWort(pfad: string): string {
  const { home, rest } = homeTeilen(pfad);
  // `name=…` am Zeilenanfang wäre eine Zuweisung, kein Befehl.
  const zuweisung = !home && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest);
  if (home ? rest === '' || SICHER.test(rest) : SICHER.test(rest) && !zuweisung)
    return home ? `$HOME${rest}` : rest;
  return `"${home ? '$HOME' : ''}${doppeltInhalt(rest)}"`;
}

/** Muster für `case "$PWD/" in …)`: Pfad in Anführungszeichen (wörtlich), danach `/*`. */
export function casePfadMuster(pfad: string): string {
  const { home, rest } = homeTeilen(pfad);
  return `"${home ? '$HOME' : ''}${doppeltInhalt(rest)}"/*`;
}

// ---------------------------------------------------------------------------------------------
// Pfadliste (Start-Wrapper, `--include`)

export interface PfadListe {
  pfade: string[];
  /** Je abgelehnter Zeile eine Meldung (Zeilennummer ab 1). */
  fehler: string[];
}

/**
 * Liest „einen Pfad je Zeile“: Leerzeilen fallen weg, abschließende Schrägstriche auch, doppelte
 * Pfade zählen einmal. Erlaubt sind absolute Pfade sowie `~`, `$HOME` oder `${HOME}` am Anfang.
 */
export function pfadeLesen(text: string): PfadListe {
  const pfade: string[] = [];
  const fehler: string[] = [];
  text.split(/\r?\n/).forEach((zeile, i) => {
    const roh = zeile.trim();
    if (!roh) return;
    const nr = i + 1;
    // Steuerzeichen (z. B. Tabulator mitten im Pfad) nie in eine Shell-Zeile übernehmen.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(roh)) {
      fehler.push(`Zeile ${nr}: Steuerzeichen sind nicht erlaubt.`);
      return;
    }
    const pfad = roh.replace(/\/+$/, '');
    if (pfad === '') {
      fehler.push(`Zeile ${nr}: „/“ würde jedes Verzeichnis erfassen.`);
      return;
    }
    if (!pfad.startsWith('/') && !HOME.test(pfad)) {
      fehler.push(`Zeile ${nr}: Pfad muss absolut sein oder mit ~ bzw. $HOME beginnen.`);
      return;
    }
    if (!pfade.includes(pfad)) pfade.push(pfad);
  });
  return { pfade, fehler };
}

// ---------------------------------------------------------------------------------------------
// Einstellungen (Managed Settings, Server-Managed Settings, Benutzer-Einstellungen)

/** Befehlszeile für `otelHeadersHelper` (Claude Code führt sie über die Shell aus). */
export function helperBefehl(agentPfad: string): string {
  return `${pfadWort(agentPfad)} otel-headers`;
}

/** `env`-Block für Claude Code (Quelle A); Inhalte (Prompts, Antworten, Werkzeugdetails) gesperrt. */
export function otelUmgebung(
  k: AusrollenKonfiguration,
  o: Pick<SchnipselOptionen, 'kopfzeilen' | 'token'>,
): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: k.otlp_endpoint,
  };
  if (o.kopfzeilen === 'fest')
    env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${o.token || TOKEN_PLATZHALTER}`;
  return {
    ...env,
    OTEL_METRICS_INCLUDE_REPOSITORY: 'true',
    OTEL_METRICS_INCLUDE_SESSION_ID: 'true',
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'true',
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_RAW_API_BODIES: '0',
  };
}

function einstellungen(
  k: AusrollenKonfiguration,
  o: SchnipselOptionen,
  mitAnmeldung: boolean,
): string {
  const s: Record<string, unknown> = { env: otelUmgebung(k, o) };
  if (o.kopfzeilen === 'helper') s.otelHeadersHelper = helperBefehl(o.agentPfad);
  if (mitAnmeldung && o.orgFestlegen && k.orgs.length > 0) {
    s.forceLoginMethod = 'claudeai';
    s.forceLoginOrgUUID = k.orgs.map((org) => org.org_uuid);
  }
  return `${JSON.stringify(s, null, 2)}\n`;
}

/** (a) `managed-settings.json` per MDM, auf Wunsch mit Festlegung der Anmeldung auf die Orgs. */
export function managedSettings(k: AusrollenKonfiguration, o: SchnipselOptionen): string {
  return einstellungen(k, o, true);
}

/** (b) Server-Managed Settings (claude.ai Admin): `force*` wirkt dort nicht, daher ohne. */
export function serverManagedSettings(k: AusrollenKonfiguration, o: SchnipselOptionen): string {
  return einstellungen(k, o, false);
}

/** (c) `~/.claude/settings.json` der Person (nicht gesperrt, ohne `force*`). */
export function benutzerEinstellungen(k: AusrollenKonfiguration, o: SchnipselOptionen): string {
  return einstellungen(k, o, false);
}

// ---------------------------------------------------------------------------------------------
// Start-Wrapper (Shell)

/**
 * (d) Shell-Funktion `claude` für `~/.zshrc`/`~/.bashrc` (bash und zsh): Telemetrie nur, wenn
 * Claude Code unter einem der Pfade startet. Immer mit Helper, nie mit festem Token in der Shell.
 * Der Issue-Schlüssel des Branches beim Start (z. B. `ABC-123`, nie der Branch-Name) kommt über
 * `<agent> otel-ressource` in `OTEL_RESOURCE_ATTRIBUTES`.
 * Ohne Pfade (`pfade` leer) `null`.
 */
export function startWrapper(
  k: AusrollenKonfiguration,
  agentPfad: string,
  pfade: readonly string[],
): string | null {
  if (pfade.length === 0) return null;
  const muster = pfade.map(casePfadMuster).join('|');
  const settings = shEinfach(JSON.stringify({ otelHeadersHelper: helperBefehl(agentPfad) }));
  return `${[
    '# seatmeter: Telemetrie nur unter den freigegebenen Pfaden (Quelle A)',
    'claude() {',
    '  case "$PWD/" in',
    `    ${muster})`,
    '      local sm_ressource',
    `      sm_ressource=$(${pfadWort(agentPfad)} otel-ressource 2>/dev/null)`,
    '      OTEL_RESOURCE_ATTRIBUTES="${sm_ressource:-${OTEL_RESOURCE_ATTRIBUTES:-}}" \\',
    '      CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp \\',
    `      OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_ENDPOINT=${shEinfach(k.otlp_endpoint)} \\`,
    '      OTEL_METRICS_INCLUDE_REPOSITORY=true OTEL_LOG_USER_PROMPTS=0 OTEL_LOG_ASSISTANT_RESPONSES=0 OTEL_LOG_TOOL_DETAILS=0 OTEL_LOG_RAW_API_BODIES=0 \\',
    `      command claude --settings ${settings} "$@" ;;`,
    '    *) command claude "$@" ;;',
    '  esac',
    '}',
  ].join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Agent (Quelle B und Rechner-Token für den Helper)

/** Installationsbefehl aus der Release-URL des Servers; `null`, wenn keine konfiguriert ist. */
export function agentInstallBefehl(k: AusrollenKonfiguration): string | null {
  const basis = k.agent.release_url;
  if (!basis) return null;
  return `curl -fsSL ${shWort(`${basis}/agent-install.sh`)} | SEATMETER_RELEASE_URL=${shWort(basis)} sh`;
}

/** `enroll` mit Einmalcode (oder Platzhalter) gegen den Ingest-Host des Mandanten. */
export function enrollBefehl(
  k: AusrollenKonfiguration,
  agentPfad: string,
  code: string | null,
): string {
  const c = code ? shWort(code) : EINMALCODE_PLATZHALTER;
  return `${pfadWort(agentPfad)} enroll ${c} --server ${shWort(k.ingest_url)}`;
}

/** `install --sweeper-only` mit je einem `--include` je Pfad (ohne Pfade: Platzhalter). */
export function installSweeperBefehl(agentPfad: string, pfade: readonly string[]): string {
  const inc = pfade.length > 0 ? pfade.map(pfadWort) : [PFAD_PLATZHALTER];
  return [
    `${pfadWort(agentPfad)} install --sweeper-only`,
    ...inc.map((p) => `--include ${p}`),
  ].join(' ');
}

export function installHooksBefehl(agentPfad: string): string {
  return `${pfadWort(agentPfad)} install --hooks`;
}

export function statusBefehl(agentPfad: string): string {
  return `${pfadWort(agentPfad)} status`;
}
