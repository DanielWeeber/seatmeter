# seatmeter-agent (Quelle B)

Lokaler Agent für seatmeter (Architektur §2.2). Er liest die Transkripte von Claude Code
(`~/.claude/projects/<ordner>/<session>.jsonl` samt `<session>/subagents/**.jsonl`) und überträgt je
API-Anfrage nur Zähler und Metadaten an den seatmeter-Server. Einzeldatei-Bündel
`dist/seatmeter-agent.mjs` (esbuild, Node ≥ 22, keine weiteren Pakete).

## Installation

```sh
# 1. Agent aus dem Release installieren (nach ~/.seatmeter/bin): Binary für macOS arm64 und Linux x64,
#    sonst JS-Bündel (Node ≥ 22); Prüfsumme aus SHA256SUMS des Releases. Privates Repo: zusätzlich
#    SEATMETER_DOWNLOAD_TOKEN (Lese-Token) setzen.
R=https://<forgejo-host>/weeberwrk/seatmeter/releases/download/v0.1.3
curl -fsSL "$R/agent-install.sh" | SEATMETER_RELEASE_URL="$R" sh

# 2. Einmalcode im Dashboard (Rechner/Agenten oder Ausrollen) erzeugen und den Rechner registrieren
~/.seatmeter/bin/seatmeter-agent enroll ABCD-EFGH-IJKL --server https://<ingest-host>

# 3. Betriebsart wählen (siehe unten) und prüfen
~/.seatmeter/bin/seatmeter-agent install --sweeper-only --include ~/kunden --projekt-pfad ~/kunden=kunden/sonstiges
~/.seatmeter/bin/seatmeter-agent status
```

`enroll` legt das Rechner-Token (`smr_…`) im macOS-Schlüsselbund ab (Dienst `seatmeter-agent`,
Konto `rechner-token`; das Token geht nur über stdin an `security`, nie als Argument), sonst in
`~/.seatmeter/token` mit Rechten 0600. Das Token erscheint nie in Ausgaben oder Protokollen.

## Befehle

| Befehl | Wirkung |
|---|---|
| `enroll <code> --server <url>` | Einmalcode gegen Rechner-Token tauschen (`POST /api/agent/v1/enroll`), Server-Konfiguration speichern |
| `install [--hooks\|--sweeper-only] [--include <pfad>…] [--exclude <pfad>…] [--projekt-pfad <pfad>=<name>…] [--intervall <min>] [--register\|--no-register]` | Betriebsart, Pfad-Filter und Pfad-Projekte in `~/.seatmeter/config.json`, Hooks und Sweeper einrichten |
| `hook <Event>` | Hook-Handler (SessionStart, Stop, SubagentStop, SessionEnd): scannt nur das Transkript der Sitzung, pusht, endet immer mit 0 (Budget 3 s) |
| `scan [--push]` | geänderte Transkripte inkrementell lesen, Warteschlange füllen; mit `--push` danach senden und einen Heartbeat schicken (so ruft der Sweeper auf) |
| `push` | Warteschlange senden (ignoriert den Backoff), danach Heartbeat |
| `otel-headers` | JSON `{"Authorization":"Bearer smr_…"}` für Claude Codes `otelHeadersHelper` |
| `otel-ressource` | für den Start-Wrapper (ab 0.1.3): `OTEL_RESOURCE_ATTRIBUTES` samt `seatmeter.issue_schluessel=ABC-123` aus dem aktuellen Branch des Arbeitsverzeichnisses (vorhandene Attribute bleiben); leer ohne Schlüssel oder außerhalb des Pfad-Filters; der Branch-Name wird nie ausgegeben |
| `status` | Registrierung, Modus, Pfad-Filter, Sweeper, letzter Scan/Push/Heartbeat, Warteschlange |
| `uninstall [--alles]` | eigene Hooks und Sweeper entfernen; `--alles` löscht auch Token und `~/.seatmeter` |

`--verbose` schreibt das Protokoll zusätzlich auf stderr.

## Betriebsarten

- **Hooks + Sweeper** (`install --hooks`, Standard des Servers): Die Hooks werden in
  `~/.claude/settings.json` gemischt (fremde Hooks bleiben, Sicherung `settings.json.seatmeter-sicherung`,
  Exec-Form mit absoluten Pfaden, `"async": true`, Timeout 10 s). Der Hook liest aus dem Hook-JSON nur
  `session_id`, `transcript_path`, `cwd` und `hook_event_name`.
- **Nur Sweeper** (`install --sweeper-only`, Pilot): `settings.json` wird nicht angefasst (früher
  eingetragene seatmeter-Hooks werden entfernt). Der Sweeper läuft alle 10 min (5–15 einstellbar):
  - macOS: `~/Library/LaunchAgents/de.weeberwrk.seatmeter-agent.plist` (`launchctl bootstrap gui/<uid> …`)
  - Linux: `~/.config/systemd/user/seatmeter-agent.{service,timer}` (`systemctl --user enable --now seatmeter-agent.timer`)
  - Windows: `~/.seatmeter/seatmeter-agent-aufgabe.xml` (`schtasks /Create /TN seatmeter-agent /XML <datei> /F`)

  Registriert wird nur interaktiv (Terminal) oder mit `--register`; sonst gibt `install` den Befehl aus.

Die Server-Konfiguration (`GET /api/agent/v1/config`, täglich aufgefrischt) liefert Vorgaben;
`~/.seatmeter/config.json` überschreibt sie je Feld. `exclude_paths` aus Server und lokal werden
vereinigt.

## Pfad-Filter

Eine Anfrage zählt nur, wenn das `cwd` ihrer Transkriptzeile unter einem `include_paths`-Eintrag liegt
und unter keinem `exclude_paths`-Eintrag (Ausschluss geht vor; leeres `include_paths` = alle).
Anfragen außerhalb verlassen den Rechner nicht, auch nicht ihre Sitzungs-IDs.

Zusätzlich liest der Agent Projektordner unter `~/.claude/projects`, deren Name zu keinem
eingeschlossenen Pfad passen kann, gar nicht erst (Claude Code benennt den Ordner nach dem
Startverzeichnis, jedes Zeichen außer Buchstaben und Ziffern wird `-`). Folge: Eine Sitzung, die
außerhalb startet und später in einen eingeschlossenen Pfad wechselt, wird nicht gezählt.

## Pfad-Projekte (`pfad_projekte`)

Sitzungen, deren `cwd` kein Git-Remote hat (z. B. ein Bereichsordner über mehreren Repos), landen sonst
in „unzugeordnet“. `install --projekt-pfad <pfad>=<name>` (mehrfach möglich, ersetzt die Liste) legt in
`~/.seatmeter/config.json` eine Zuordnung `pfad_projekte: { "<pfad>": "<name>" }` an: Liegt das `cwd` unter
`<pfad>` (Pfadgrenze, der längste Pfad gewinnt) und hat es kein Remote, meldet der Agent das Projekt als
`{ "typ": "pfad", "name": "<name>" }`. Ein Git-Remote geht immer vor. Gesendet wird nur die Bezeichnung
(Buchstaben, Ziffern, Leerzeichen, `._/-`, höchstens 100 Zeichen, nicht mit `/` oder `~` beginnend), nie
der Pfad. Der Server legt dafür ein eigenes Projekt an (`provider = 'pfad'`, `url_norm` leer,
`anzeigename` = Bezeichnung, Schlüssel HMAC(projekt_salt, `pfad:` + Name)). Die Option ist nur lokal (nicht
in der Server-Konfiguration), weil Pfade je Rechner verschieden sind. Bereits gesendete Anfragen werden nicht
umgebucht; nur neue Anfragen tragen das Pfad-Projekt.

## Was gesendet wird – und was nie

Je Anfrage (`POST /api/ingest/v1/anfragen`, Schema `agentPushSchema`, strikt): `request_id`
(`requestId`), `message_id`, `session_id`, Zeitpunkt, Modell, Tokens (input, output, cache_read,
cache_creation, davon 5m/1h), Websuchen, `speed`, `service_tier`, `inference_geo`, Subagent ja/nein,
Claude-Code-Version, Projekt als normalisierte Repo-URL (`url_norm`, Owner, Name, Provider) und der
Auth-Hinweis (`oauth`/`api`, Org-UUID, Konto-UUID aus `~/.claude.json` → `oauthAccount`); ohne Remote
gegebenenfalls das Pfad-Projekt (nur die Bezeichnung). Ab 0.1.3 zusätzlich `issue_schluessel`: die
Issue-Schlüssel aus dem Branch-Namen der Transkriptzeile (z. B. `feature/ABC-123-titel` → `ABC-123`,
`ABC-123/ABC-124` → beide; Muster `[A-Z][A-Z0-9]+-[0-9]+`, Groß-/Kleinschreibung egal, gesendet groß,
höchstens 20; `[]` bei einem Branch ohne Schlüssel). Je Sitzung
(`POST /api/ingest/v1/sitzungen`): Start, Ende, Version, erstes Projekt, Auth-Hinweis.

**Nie gesendet:** Inhalte (Prompts, Antworten, Denkschritte, Tool-Eingaben und -Ergebnisse), `cwd`,
Datei- und Transkriptpfade, Hostnamen, Branch-Namen (nur der daraus erkannte Issue-Schlüssel), E-Mail,
Namen.

Umsetzung: Der Parser verwirft `content` (und `gitBranch`, `toolUseResult`) schon beim Einlesen
(JSON-Reviver; aus `gitBranch` liest er vorher nur die Issue-Schlüssel) und kopiert nur erlaubte Felder
in einen eigenen Datensatz. Vor dem Senden prüft der
Agent jeden Datensatz gegen das strikte Schema; der Server lehnt unbekannte Felder ebenfalls ab.
Tests: `test/scan.test.ts` (Kriterium d, mitgeschnittener Push) und `test/echtes-transkript.test.ts`
(echtes weeberwrk-Transkript dieses Rechners, nur lesend, in CI übersprungen).

## Zähllogik

- Nur Zeilen `type == "assistant"` mit `message.usage`; synthetische Zeilen (`<synthetic>`, API-Fehler)
  und Zeilen ohne Tokens werden übersprungen.
- Mehrere Zeilen je `message.id` (Streaming): die letzte gilt. Je Datei eine begrenzte Map
  `message.id → Beitrag` (1000 Einträge; die jüngsten 20 bleiben im Zustand), damit unveränderte
  Beiträge nicht erneut gesendet werden.
- Schlüssel: `requestId`, sonst `msg:<message.id>`; der Server-Upsert ist idempotent.
- Zustand je Datei (Inode, Größe, Offset) in `~/.seatmeter/state.json`; neue oder gekürzte Dateien werden
  von vorn gelesen. Halbe Zeilen am Dateiende bleiben bis zum nächsten Lauf liegen (Claude Code schreibt
  asynchron). Rückfüllung höchstens `rueckfuellung_tage` (Standard 30).
- Projekt je `cwd`: `git rev-parse --show-toplevel` (existiert das `cwd` nicht mehr, etwa ein gelöschter
  Agent-Worktree unter `<repo>/.claude/worktrees/<name>`, der nächste übergeordnete Ordner mit Repo, höchstens bis
  unterhalb des Home-Verzeichnisses) und `git config --get remote.origin.url` mit
  bereinigter Umgebung (`GIT_DIR`, `GIT_WORK_TREE` … entfernt), Normalisierung wie der Server
  (`normalisiereRepoUrl`); Home-Verzeichnis zählt nicht; Cache je cwd (24 h) im Zustand.
- Auth-Hinweis: `api`, wenn `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`,
  ein fremdes `ANTHROPIC_BASE_URL` oder `apiKeyHelper` (User- oder Managed-Settings) gesetzt ist, sonst `oauth`.

## Push

Batches ≤ 1000. 200 → aus der Warteschlange; 401/403 → anhalten, Token als ungültig markieren (neu
`enroll`); 413 → Batch teilen; 400 → teilen bis zum einzelnen Datensatz, der verworfen wird;
429/503/5xx/Netzfehler → Backoff (`Retry-After`, sonst 1, 2, 4 … 60 min). Warteschlange:
`~/.seatmeter/queue/anfragen.jsonl` und `queue/sitzungen.json`. Hook und Sweeper sperren sich
gegenseitig (`~/.seatmeter/lock`).

**Heartbeat (ab v0.1.2):** Am Ende jedes Push-Laufs (`scan --push` des Sweepers und `push`) schickt der Agent
`POST /api/agent/v1/heartbeat` mit dem Rechner-Token und nur `{ "agent_version": "…" }` (Schema
`agentHeartbeatSchema`, strikt; den Zeitpunkt setzt der Server). So bleibt `rechner.zuletzt_gesehen` auch bei
leerer Warteschlange aktuell (nachts, am Wochenende), und das Monitoring unterscheidet „Agent lebt, niemand
arbeitet“ von „Agent fehlt“. Der Heartbeat läuft nach dem Push und unabhängig von dessen Ergebnis (auch im
Backoff); Netz- und Serverfehler werden nur in `state.json` vermerkt (`status`, Zeile „Heartbeat“) und ändern
weder Warteschlange noch Exit-Code. 401/403 markiert das Token als ungültig wie beim Push. Hooks schicken keinen
Heartbeat: Ihre Pushes setzen `zuletzt_gesehen` ohnehin, und der Sweeper meldet sich alle 5–15 min.

## Dateien unter `~/.seatmeter`

`config.json` (lokale Überschreibungen), `server-config.json`, `rechner.json` (Rechner-ID, Server),
`state.json`, `queue/`, `agent.log` (nur Zähler und Fehlerarten, keine Pfade oder Inhalte, rotiert bei
1 MB), `token` (nur ohne Schlüsselbund), `bin/` (vom Installskript).

## Release und Binaries

Seit v0.1.0 (2026-10-22) liegen die Agent-Dateien als Release-Anhänge auf Forgejo (`weeberwrk/seatmeter`,
Tag `v<version>`, später GitHub): `seatmeter-agent-darwin-arm64` und `seatmeter-agent-linux-x64`
(Einzeldatei-Binaries, `bun build --compile`, kein Node nötig), `seatmeter-agent.mjs` (JS-Bündel, Node ≥ 22),
`agent-install.sh` und `SHA256SUMS`. Gebaut im Container (bun 1.4.3), Größen v0.1.0: macOS arm64 72 MB,
Linux x64 92 MB, Bündel 0,8 MB:

```sh
pnpm --filter @seatmeter/shared build && pnpm --filter @seatmeter/agent build   # im dev-Container
mkdir -p rel && cp packages/agent/dist/seatmeter-agent.mjs deploy/agent-install.sh rel/
docker run --rm -v "$PWD/rel:/rel" oven/bun:1.4.3 sh -c 'cd /rel &&
  bun build --compile --target=bun-linux-x64 seatmeter-agent.mjs --outfile seatmeter-agent-linux-x64 &&
  bun build --compile --target=bun-darwin-arm64 seatmeter-agent.mjs --outfile seatmeter-agent-darwin-arm64'
(cd rel && shasum -a 256 seatmeter-agent.mjs seatmeter-agent-linux-x64 seatmeter-agent-darwin-arm64 agent-install.sh > SHA256SUMS)
```

Das macOS-Binary ist ad hoc (linker-)signiert und läuft ohne Notarisierung (v1), solange kein
Quarantäne-Attribut gesetzt ist; `curl` setzt keines, das Installskript entfernt es zur Sicherheit. Node SEA
wurde nicht weiter verfolgt (mehr Schritte: Blob, `postject`, Signatur entfernen und neu setzen). Nach einem
Update `install …` erneut ausführen, damit Sweeper bzw. Hooks auf die neue Datei zeigen.

## Entwicklung

```sh
docker compose -f deploy/compose.dev.yml run --rm dev pnpm exec vitest run --project agent
# mit echtem Transkript (nur lesend eingehängt, nur weeberwrk-Ordner):
docker compose -f deploy/compose.dev.yml run --rm \
  -v "$HOME/.claude/projects/<weeberwrk-ordner>:/echt/projects/<weeberwrk-ordner>:ro" \
  -e SEATMETER_ECHTE_TRANSKRIPTE=/echt/projects dev pnpm exec vitest run --project agent
```
