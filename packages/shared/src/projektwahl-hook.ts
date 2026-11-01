// Befehl des verwalteten `UserPromptSubmit`-Hooks (Modul projektkatalog): prüft vor dem Prompt, ob das Repo
// (bzw. die Sitzung ohne Repo) einem Projekt zugeordnet ist, und blockiert sonst mit dem Link zur Auswahl.
// Läuft inline in bash 3.2 (macOS), Linux/WSL und Git Bash, ohne jq und ohne installierte Dateien.
//
// Regeln: Der Prompt verlässt den Rechner nie (`sed` gibt nur die Sitzungs-ID aus, der Prompt landet in keiner
// Variablen). Gesendet werden nur Sitzungs-ID und Repo-URL ohne Zugangsdaten, lokale Pfade nie. Kein `eval`. Jeder Fehler
// (kein Token, kein Netz, Server nicht erreichbar, unbekannte Antwort) lässt den Prompt durch. Eine Marke im
// Cache-Ordner spart die Netzanfrage je Prompt; sie läuft ab, damit spätere Änderungen am Server wirken. Ihr Name enthält
// eine Prüfsumme des Tokens, damit sich zwei Organisationen im selben Repo nicht gegenseitig durchwinken. Geht der
// Cache-Ordner nicht, dient ein eigener Ordner unter TMPDIR; fremde oder verlinkte Ordner dort zählen nicht.
//
// Die Stufe steht auf dem Server und wirkt ohne neue Verteilung: `warnen` lässt den Prompt durch und zeigt den Link als
// `systemMessage` (lässt sich keine Marke schreiben, bleibt er still, statt bei jedem Prompt zu warnen), `waehlen` blockiert. Blockiert wird mit JSON (`decision: block`) statt Exit 2: Bei Exit 2 stellt Claude Code der Meldung den ganzen
// Hook-Befehl voran, die Person sähe das Skript statt des Links (geprüft mit Version 2.1.316). `claude -p` und das
// Agent SDK (`CLAUDE_CODE_ENTRYPOINT=sdk-…`, Variable nicht dokumentiert) werden nie blockiert, sonst brächen
// Skripte in Ordnern ohne Repo bei jedem Lauf; die Nutzung im Repo ist nach der Zuordnung trotzdem richtig gebucht.
// Nutzung außerhalb des Abos (API-Schlüssel, Bedrock, Vertex, Foundry, eigene Basis-URL) zählt seatmeter nicht, darum
// lässt der Hook sie sofort durch, ohne etwas zu senden.

/** Geltung der Marke „zugeordnet“ in Minuten (ein Tag). */
export const PROJEKTWAHL_MARKE_ZUGEORDNET_MINUTEN = 1440;
/** Geltung der Marken „frei“ (Stufe aus oder Katalog leer) und „gewarnt“ in Minuten; so lange gilt auch der Link. */
export const PROJEKTWAHL_MARKE_FREI_MINUTEN = 60;
/** Pfad der Prüf-Route unter der Ingest-Basis-URL. */
export const PROJEKTWAHL_PRUEF_PFAD = '/api/ingest/v1/projektwahl';
/** Zeitlimit des Hooks in Sekunden (Eintrag `timeout` in den Einstellungen). */
export const PROJEKTWAHL_HOOK_TIMEOUT_SEKUNDEN = 5;
/**
 * Umgebungsvariable mit dem Mandanten-Token für den Hook. Eigene Variable, weil Claude Code `OTEL_*` nicht an
 * Hooks weiterreicht (geprüft mit Version 2.1.316); andere Werte aus `env` der Einstellungen kommen dort an.
 */
export const PROJEKTWAHL_TOKEN_VARIABLE = 'SEATMETER_PROJEKTWAHL_TOKEN';

export interface ProjektwahlHookOptionen {
  /** Basis-URL des Ingest-Hosts ohne abschließenden Schrägstrich. */
  ingestUrl: string;
  /**
   * Befehl, der die Kopfzeile mit dem Rechner-Token ausgibt (`<agent> otel-headers`, bereits für die Shell
   * aufbereitet). Ohne Befehl kommt das Mandanten-Token aus `SEATMETER_PROJEKTWAHL_TOKEN`.
   */
  helperBefehl?: string | null;
}

/**
 * Was der Hook als Repo sendet: `schema://host/pfad` oder scp-Form `[nutzer@]host:pfad`, wie `normalisiereRepoUrl`.
 * Alles andere (lokale Pfade, Windows-Laufwerke) bleibt auf dem Rechner und zählt als Ordner ohne Repo; sonst bekäme
 * eine Wahl je Sitzung eine Marke je Repo. Nach dem Entfernen der Zugangsdaten darf kein `@` übrig sein (außer dem
 * Nutzer der scp-Form), sonst könnte ein Rest davon gesendet werden; das Schema hat mindestens zwei Zeichen (`C://…`).
 * Der Hook prüft das, bevor er `?` und `#` abschneidet, und danach noch einmal: Abgeschnitten verschwände ein `@` hinter
 * einem `?` im Passwort, und der Anfang des Passworts ginge durch. Den Nutzer der scp-Form ersetzt er durch `git`: Dort kann
 * auch ein Token stehen, und für den Schlüssel des Repos zählt er nicht (`normalisiereRepoUrl` ignoriert ihn).
 */
const REMOTE_MUSTER =
  '^([A-Za-z][A-Za-z0-9+.-]+://[^/@[:space:]]+/+[^/@[:space:]][^@[:space:]]*|([^@/:[:space:]]+@)?[^@:/[:space:]]{2,}:/?[^/@[:space:]][^@[:space:]]*)$';

function shEinfach(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Shell-Skript für `hooks.UserPromptSubmit[].hooks[].command` (eine Zeichenkette mit Zeilenumbrüchen). */
export function projektwahlHookBefehl(o: ProjektwahlHookOptionen): string {
  const url = `${o.ingestUrl.replace(/\/+$/, '')}${PROJEKTWAHL_PRUEF_PFAD}`;
  const token = o.helperBefehl
    ? `t=$(${o.helperBefehl} 2>/dev/null | sed -n 's/.*Bearer \\([A-Za-z0-9_-]*\\).*/\\1/p' | head -n 1)`
    : `t=\${${PROJEKTWAHL_TOKEN_VARIABLE}:-}`;
  return [
    `case "\${CLAUDE_CODE_ENTRYPOINT:-}" in sdk-*) exit 0 ;; esac`,
    `[ -z "\${ANTHROPIC_API_KEY:-}\${ANTHROPIC_AUTH_TOKEN:-}\${CLAUDE_CODE_USE_BEDROCK:-}\${CLAUDE_CODE_USE_VERTEX:-}\${CLAUDE_CODE_USE_FOUNDRY:-}" ] || exit 0`,
    `case "\${ANTHROPIC_BASE_URL:-https://api.anthropic.com}" in https://api.anthropic.com|https://api.anthropic.com/) ;; *) exit 0 ;; esac`,
    `s=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]\\{1,100\\}\\)".*/\\1/p' | head -n 1)`,
    token,
    `[ -n "$s" ] && [ -n "$t" ] || exit 0`,
    `case "$t" in *[!A-Za-z0-9_-]*) exit 0 ;; esac`,
    `p=${shEinfach(REMOTE_MUSTER)}`,
    `u=$(git remote get-url origin 2>/dev/null | head -n 1 | sed -E -e 's|^([A-Za-z][A-Za-z0-9+.-]*://)[^/?#]*@|\\1|' | grep -E "$p" | sed -E -e 's/[?#].*$//' -e 's|^[^@/:[:space:]]+@([^@:/[:space:]]+:)|git@\\1|' | grep -E "$p" | grep -Eiv '^file:')`,
    `h=$(printf %s "$t" | cksum | cut -d' ' -f1)`,
    `if [ -n "$u" ]; then k=r$h-$(printf %s "$u" | cksum | cut -d' ' -f1); else k=s$h-$s; fi`,
    `d=\${XDG_CACHE_HOME:-$HOME/.cache}/seatmeter`,
    `e=\${TMPDIR:-/tmp}/seatmeter-$(id -u)`,
    `[ -d "$e" ] && [ -O "$e" ] && [ ! -L "$e" ] && f=$e || f=`,
    `m() { { mkdir -p "$d" && touch "$d/$1"; } 2>/dev/null && return 0; mkdir -m 700 "$e" 2>/dev/null; [ -d "$e" ] && [ -O "$e" ] && [ ! -L "$e" ] && touch "$e/$1" 2>/dev/null; }`,
    `[ -n "$(find "$d" \${f:+"$f"} -maxdepth 1 \\( -name "$k" -mmin -${PROJEKTWAHL_MARKE_ZUGEORDNET_MINUTEN} -o -name "$k.frei" -mmin -${PROJEKTWAHL_MARKE_FREI_MINUTEN} -o -name "$k.warn" -mmin -${PROJEKTWAHL_MARKE_FREI_MINUTEN} \\) 2>/dev/null)" ] && exit 0`,
    `r=$(printf 'header = "Authorization: Bearer %s"\\n' "$t" | curl -K - -fsS --connect-timeout 1 --max-time 2 --data-urlencode "sitzung=$s" --data-urlencode "repo=$u" ${shEinfach(url)} 2>/dev/null) || exit 0`,
    `case "$r" in`,
    `  zugeordnet) m "$k" ;;`,
    `  frei) m "$k.frei" ;;`,
    `  "warnen "*)`,
    `    l=\${r#warnen }`,
    `    case "$l" in *[!A-Za-z0-9_./:%?=\\&-]*) exit 0 ;; esac`,
    `    m "$k.warn" || exit 0`,
    `    printf '{"systemMessage":"seatmeter: Bitte das Projekt wählen: %s"}\\n' "$l" ;;`,
    `  "waehlen "*)`,
    `    l=\${r#waehlen }`,
    `    case "$l" in *[!A-Za-z0-9_./:%?=\\&-]*) exit 0 ;; esac`,
    `    printf '{"decision":"block","reason":"seatmeter: Bitte zuerst das Projekt wählen: %s\\\\nDanach den Prompt erneut senden."}\\n' "$l" ;;`,
    `esac`,
    `exit 0`,
  ].join('\n');
}

/** Eintrag für `hooks` in den verwalteten Einstellungen. */
export function projektwahlHookEinstellung(o: ProjektwahlHookOptionen) {
  return {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: 'command' as const,
            command: projektwahlHookBefehl(o),
            timeout: PROJEKTWAHL_HOOK_TIMEOUT_SEKUNDEN,
          },
        ],
      },
    ],
  };
}
