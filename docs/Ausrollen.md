# seatmeter beim Kunden ausrollen

Runbook für Claude Team und Claude Enterprise (Architektur §10). Werkzeug ist die Dashboard-Seite **„Ausrollen“** (`/ausrollen`, Gruppe „Einrichtung“, nur Mandanten-Admin): Sie setzt die Werte des Mandanten (Ingest-URL, Org-UUIDs, Agent-Release) in fertige Schnipsel ein. Platzhalter in spitzen Klammern: `<ingest-host>`, `<dashboard-host>`, `<forgejo-host>`, `<org>`.

Vor dem Start: Betriebsvereinbarung bzw. Zustimmung des Betriebsrats ([Betriebsrat-Vorlage.md](Betriebsrat-Vorlage.md)).

## 1. Überblick

| Quelle                    | Was                                                                                  | Weg zum Server                         | Nötig                      |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------- |
| **A** Claude Code OTel    | Claude Code exportiert je API-Anfrage Zähler und Metadaten (OpenTelemetry, HTTP)     | `https://<ingest-host>/otlp/v1/*`      | **Minimum**                |
| **B** `seatmeter-agent`   | lokaler Agent liest nur die Zählerfelder der Transkripte (Hooks und/oder Sweeper)    | `https://<ingest-host>/api/ingest/v1/*` | empfohlen                  |
| **C** Abgleich (ee)       | Enterprise Analytics API bzw. Team-Spend-Report (CSV) für den Abzug der Überschreitung | Server ruft ab bzw. Upload im Dashboard | optional                   |

**Empfehlung:** A organisationsweit plus B auf allen Rechnern. B fängt verlorene OTel-Exporte auf, liefert die Aufteilung der Cache-Schreibvorgänge in 5 min/1 h und das Projekt je Anfrage (Sitzungen über mehrere Repos); A und B werden über die `request_id` zusammengeführt (keine Doppelzählung). Mit B kann A außerdem das Rechner-Token statt eines gemeinsamen Mandanten-Tokens nutzen. A allein ist das Minimum; dann gilt für Cache-Schreibvorgänge die Annahme „1 h“ (Einstellung `cache_write_annahme`).

## 2. Vorbereitung

1. **Mandant:** Free-Edition: genau ein Mandant aus der Einrichtung (Seite „Einrichtung“, `deploy/README.md`). ee: Ein Plattform-Admin legt den Mandanten im Plattform-Bereich auf der Seite „Mandanten“ an (`/plattform/mandanten`).
2. **Org-UUID(s)** aus den claude.ai-Admin-Einstellungen (Organisation) in die Positivliste eintragen: Free per CLI `mandant:anlegen --org <uuid>` (`deploy/README.md`), ee auf der Seite „Tokens und Orgs“ (Einrichtung, Mandanten-Admin) bzw. im Plattform-Bereich unter „Mandanten“ → Mandant. Nur Anfragen dieser Orgs zählen als Abo-Nutzung.
3. **Plan und Abrechnungsmodell** hinterlegen: `team` oder `enterprise`; Kontingent oder nutzungsbasiert (Architektur §4).
4. **Sitze:** Sitztypen und Preise auf „Preise & Sitzkosten“ (vorbelegt: Max 5x 100 USD und Max 20x 200 USD je Monat; Team-/Enterprise-Sitze `standard`, `premium`, `enterprise` mit den Preisen des Vertrags ergänzen), Sitz je Person (`PUT /api/v1/personen/<id>/sitz`). Personen erscheinen erst mit ihrer ersten Nutzung; der Upload einer Sitzliste (§10.1) ist noch nicht umgesetzt.
5. **Preise prüfen:** globale Preistabelle (Quelle und Prüfdatum je Zeile), bei Vertragspreisen eigene Zeilen des Mandanten.
6. **Auswertungsstufe** mit dem Betriebsrat festlegen und unter „Einstellungen“ setzen (Standard 1, Klarnamen aus).
7. **Öffentlicher Ingest-Host** `<ingest-host>`: gibt nur `/otlp/*`, `/api/ingest/*`, `/api/agent/*` und `/api/health` weiter, sonst 404. Das Dashboard (`<dashboard-host>`) bleibt intern oder hinter einer Anmeldung (`deploy/README.md`, „Reverse-Proxy“).
8. **Server-Umgebung:**

   | Variable                      | Wert                                                                       | Ohne sie                                                                                                       |
   | ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | `SEATMETER_INGEST_URL`        | öffentliche Basis-URL der Annahme, z. B. `https://<ingest-host>`           | Rückfall auf `SEATMETER_PUBLIC_URL`, sonst aus der Dashboard-Anfrage abgeleitet; die Seite warnt dann, weil das Dashboard oft intern läuft |
   | `SEATMETER_AGENT_RELEASE_URL` | `https://<forgejo-host>/<org>/seatmeter/releases/download/v<version>`      | kein Download-Befehl im Tab „Agent installieren“                                                               |

## 3. Die Seite „Ausrollen“

Die Seite zeigt Mandant, Ingest-URL samt Herkunft, OTLP-Endpunkt (`<ingest-url>/otlp`), Orgs der Positivliste, Release-URL und Serverversion. Die Schnipsel enthalten nie ein Token, außer man erzeugt eines ausdrücklich (siehe unten).

### 3.1 Gemeinsame Optionen

| Option                    | Auswahl                                                                                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Header: Agent-Helper** (empfohlen) | `otelHeadersHelper` = `<agent> otel-headers`. Claude Code holt das Rechner-Token (`smr_…`) über den Agenten aus dem Schlüsselbund; je Rechner widerrufbar, an Person und Rechner gebunden. Voraussetzung: Agent auf jedem Rechner registriert, sonst lehnt der Server die Daten ab (401). |
| **Header: statisches Mandanten-Token** | `OTEL_EXPORTER_OTLP_HEADERS` = `Authorization=Bearer smi_…`. Geht ohne Agent, ist aber für alle Beschäftigten lesbar und erlaubt gefälschte Meldungen. Knopf **„Neues Mandanten-Token erzeugen“**: Das Token erscheint genau einmal im Schnipsel, das Audit vermerkt „Ingest-Token erzeugt“. Ältere Tokens bleiben gültig. |
| **Agent-Pfad**            | Standard `$HOME/.seatmeter/bin/seatmeter-agent` (Ziel des Installskripts); bei MDM-Paketen den tatsächlichen Installationsort eintragen.                                                                                                                                                     |
| **Anmeldung erzwingen**   | an: `forceLoginMethod: "claudeai"` und `forceLoginOrgUUID: [<Orgs>]`. Claude Code blockiert dann API-Schlüssel und fremde Orgs schon beim Start. Wirksam nur über Weg (a) auf dem Gerät.                                                                                                       |

Aufbau des Schnipsels (Variante Helper, Werte setzt die Seite ein):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://<ingest-host>/otlp",
    "OTEL_METRICS_INCLUDE_REPOSITORY": "true",
    "OTEL_METRICS_INCLUDE_SESSION_ID": "true",
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID": "true",
    "OTEL_LOG_USER_PROMPTS": "0",
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",
    "OTEL_LOG_TOOL_DETAILS": "0",
    "OTEL_LOG_RAW_API_BODIES": "0"
  },
  "otelHeadersHelper": "$HOME/.seatmeter/bin/seatmeter-agent otel-headers",
  "forceLoginMethod": "claudeai",
  "forceLoginOrgUUID": ["<ORG-UUID>"]
}
```

Der Endpunkt endet auf `/otlp` (Claude Code hängt `/v1/logs` bzw. `/v1/metrics` an). Protokolle `http/protobuf` oder `http/json`, kein gRPC. Die `OTEL_LOG_*`-Werte sind ausdrücklich `0`, damit sie in verwalteten Settings gesperrt sind.

### 3.2 Tabs

| Tab                                      | Für wen                                       | Ablage und Hinweise                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Managed Settings (MDM)**           | Firmen mit Geräteverwaltung                   | `managed-settings.json` per MDM verteilen: macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux `/etc/claude-code/managed-settings.json`, Windows `C:\Program Files\ClaudeCode\managed-settings.json`. Stärkste Bindung, Nutzer können nichts ändern; `forceLogin*` wirkt nur hier.                                                     |
| **(b) Server-Managed Settings**          | Team ohne MDM, auch Enterprise                | Owner in claude.ai → Admin-Einstellungen → Claude Code → Managed settings. Gilt einheitlich für alle Mitglieder (keine Gruppen) und nur für Sitzungen mit Anmeldung in dieser Org. Für den Telemetrie-Endpunkt erscheint je Konto und Org einmal ein **Freigabedialog**: vorher ankündigen. `forceLogin*` wirkt hier nicht, nur per Gerät über (a). |
| **(c) User-Settings**                    | einzelne Rechner ohne Admin-Rechte            | `~/.claude/settings.json`. Nicht gesperrt, Nutzer können es ändern. Nur mit Helper (kein Token in die Datei).                                                                                                                                                                                                                                                  |
| **(d) Start-Wrapper**                    | Freiberufler, gemischt genutzte Rechner       | Shell-Funktion `claude`, die die OTel-Variablen nur unter den eingetragenen Pfaden setzt. Der Helper kommt über `claude --settings '{"otelHeadersHelper":"<agent> otel-headers"}'`, weil `otelHeadersHelper` ein Settings-Schlüssel ist, keine Umgebungsvariable. Nicht gesperrt.                                                                       |
| **(e) Agent installieren**               | jeder Rechner mit Quelle B oder Helper        | Installbefehl aus dem Release, Knopf für einen **Einmalcode** (24 h gültig, nur einmal angezeigt), dann `enroll` und `install` (Abschnitt 7).                                                                                                                                                                                                                  |

Aufbau des Wrappers (d), die Seite setzt Pfade und Werte ein:

```sh
# in ~/.zshrc bzw. ~/.bashrc
claude() {
  case "$PWD/" in
    "$HOME/kunden/"*)
      local sm_ressource
      sm_ressource=$(<agent> otel-ressource 2>/dev/null)
      OTEL_RESOURCE_ATTRIBUTES="${sm_ressource:-${OTEL_RESOURCE_ATTRIBUTES:-}}" \
      CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp \
      OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
      OTEL_EXPORTER_OTLP_ENDPOINT=https://<ingest-host>/otlp \
      OTEL_METRICS_INCLUDE_REPOSITORY=true \
      OTEL_LOG_USER_PROMPTS=0 OTEL_LOG_ASSISTANT_RESPONSES=0 OTEL_LOG_TOOL_DETAILS=0 OTEL_LOG_RAW_API_BODIES=0 \
        command claude --settings '{"otelHeadersHelper":"<agent> otel-headers"}' "$@"
      ;;
    *) command claude "$@" ;;
  esac
}
```

`otel-ressource` (Agent ab 0.1.3) gibt den Issue-Schlüssel des Branches beim Start mit (z. B. `ABC-123`,
nie den Branch-Namen; Kosten je Issue, siehe `docs/Jira.md`). Ohne Schlüssel bleibt
`OTEL_RESOURCE_ATTRIBUTES` unverändert. Bei den Wegen (a) bis (c) gibt es keinen Wrapper; dort liefert nur
der Agent (Quelle B) die Schlüssel, je Transkriptzeile.

## 4. Ablauf Team ohne MDM

1. Vorbereitung (Abschnitt 2).
2. Header-Art wählen: **statisches Mandanten-Token**, solange nicht auf jedem Rechner der Agent läuft; **Helper**, sobald der Agent überall registriert ist (sonst fehlen die Daten dieser Rechner).
3. Beschäftigte informieren und den einmaligen Freigabedialog von Claude Code für den Telemetrie-Endpunkt ankündigen.
4. Owner fügt das JSON aus Tab (b) in claude.ai unter Admin-Einstellungen → Claude Code → Managed settings ein.
5. Optional Agent je Rechner (Tab e, Abschnitt 7) für Quelle B.
6. Prüfen (Abschnitt 8).

Ohne Weg (a) greift `forceLogin*` nicht. Sitzungen mit API-Schlüssel oder fremdem Konto bekommen die Server-Managed Settings aber gar nicht erst bzw. werden vom Abo-Filter verworfen.

## 5. Ablauf Enterprise bzw. mit MDM

1. Vorbereitung (Abschnitt 2).
2. `managed-settings.json` aus Tab (a) mit **Helper** und „Anmeldung erzwingen“ per MDM verteilen.
3. Agent-Paket je Rechner: Installskript bzw. Binary plus Einmalcode je Rechner (Seite „Rechner/Agenten“ oder Tab e, mit Rechner-Bezeichnung). Codes gelten 24 h, also kurz vor der Verteilung erzeugen. Im Paket `install --register` nutzen, weil der Sweeper ohne Terminal sonst nicht registriert wird.
4. Setzt der Kunde `allowManagedHooksOnly`, ignoriert Claude Code die Hooks in `~/.claude/settings.json`: entweder `install --sweeper-only` oder die Hook-Einträge, die `install --hooks` schreiben würde, in die Managed Settings übernehmen.
5. Abgleich (ee): **nur Enterprise** – der Primary Owner legt in claude.ai einen Analytics-Key (Scope `read:analytics`) an, der Mandanten-Admin hinterlegt ihn auf der Seite „Abgleich“. Team: Spend-Report-CSV dort hochladen.
6. Prüfen (Abschnitt 8).

Enterprise ohne MDM rollt wie Team über Weg (b) aus.

## 6. Freiberufler und mehrere Auftraggeber

- Keine verwalteten Settings auf fremden Rechnern; stattdessen **Start-Wrapper** (Tab d) nur für die Ordner des Auftraggebers.
- Agent nur als Sweeper mit Pfad-Filter: `seatmeter-agent install --sweeper-only --include <pfad>`. Anfragen außerhalb verlassen den Rechner nicht.
- Ordner ohne Git-Remote landen sonst in „unzugeordnet“: mit `--projekt-pfad <pfad>=<name>` einem Projekt zuordnen.
- Gezählt wird nur, was über ein Konto der Org des Auftraggebers läuft; ein eigenes Max- oder Pro-Konto zählt als fremde Org und wird verworfen.

## 7. Agent-Installation

```sh
curl -fsSL <release-url>/agent-install.sh | SEATMETER_RELEASE_URL=<release-url> sh
~/.seatmeter/bin/seatmeter-agent enroll <CODE> --server https://<ingest-host>
~/.seatmeter/bin/seatmeter-agent install --sweeper-only --include <pfad>   # oder: install --hooks
~/.seatmeter/bin/seatmeter-agent status
```

`<release-url>` = `SEATMETER_AGENT_RELEASE_URL` (Tab e setzt sie ein).

- **Installskript:** wählt das Binary für macOS arm64 oder Linux x64 (kein Node nötig; ad hoc signiert, in v1 nicht von Apple notarisiert, `curl` setzt kein Quarantäne-Attribut), sonst das JS-Bündel (Node ≥ 22). Jede Datei wird gegen `SHA256SUMS` des Releases geprüft; bei Abweichung bricht das Skript ab. Ziel `~/.seatmeter/bin`.
- **Privates Forgejo:** `SEATMETER_DOWNLOAD_TOKEN` (Token mit Lesezugriff) in der Umgebung setzen; dann braucht auch der Download des Skripts selbst den Zugang. Das Token nie in Chat, Tickets, Repos oder die Shell-Historie.
- **`enroll`** tauscht den Einmalcode gegen das Rechner-Token (`smr_…`): macOS-Schlüsselbund, sonst `~/.seatmeter/token` (0600).
- **Betriebsart:** `install --hooks` (Hooks in `~/.claude/settings.json` plus Sweeper, fremde Hooks bleiben) oder `install --sweeper-only` (Sweeper alle 10 min, `settings.json` bleibt unberührt). `--include`/`--exclude` setzen den Pfad-Filter.
- **`allowManagedHooksOnly`:** Hooks müssen in die Managed Settings (Abschnitt 5, Punkt 4).
- Details: `packages/agent/README.md`.

## 8. Prüfen nach dem Ausrollen

| Prüfung                         | Wo                                                         | Erwartung                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Abdeckung und Zuordnung         | Seite „Datenqualität“                                      | Abdeckung A und B je nach Ausbau (mit A+B nach einigen Tagen ≥ 99 %), „unzugeordnet“ < 5 %. Verworfene Inhaltsereignisse sind normal (Claude Code sendet weitere Ereignisse, die nur gezählt werden). Viele gefilterte API-/Fremd-Org-Anfragen: Org-Liste und „Anmeldung erzwingen“ prüfen. |
| Quellen liefern                 | `GET /api/health/ingest` (intern)                          | `quellen.a.stille_stunden` und `quellen.b.stille_stunden` klein; `null` = noch nie geliefert                                                    |
| Nur erwartete Repos             | Seite „Projekte“                                           | keine privaten oder fremden Repos; sonst Pfad-Filter bzw. Wrapper-Pfade korrigieren                                                            |
| Rechner                         | Seite „Rechner/Agenten“                                    | jeder registrierte Rechner mit „zuletzt gesehen“ und Agent-Version                                                                             |
| Monatswerte                     | „Übersicht“, „Projekte“                                    | füllen sich nach dem nächtlichen Tagesaggregat; sofort mit `--einmal aggregation.tag` (`deploy/README.md`)                                      |

**Monitoring** (z. B. Gatus) auf `/api/health/ingest`: `[BODY].quellen.a.stille_stunden < 24`; für B `[BODY].quellen.b.stille_stunden < 2`, wenn der Sweeper alle 10 min läuft. `null` gilt als Fehler. `stille_stunden` zählt ab der letzten angenommenen Lieferung, und der Agent sendet nichts, wenn niemand arbeitet: Prüfungen auf Arbeitszeiten beschränken (Wartungsfenster für Nacht und Wochenende) bzw. die Schwelle anpassen.

## 9. Rücknahme

1. Quelle A abschalten: Managed Settings entfernen (MDM-Datei löschen bzw. in claude.ai leeren) oder den Start-Wrapper aus der Shell-Konfiguration nehmen.
2. Je Rechner `seatmeter-agent uninstall --alles` (Hooks, Sweeper, Token und `~/.seatmeter`).
3. Rechner auf „Rechner/Agenten“ widerrufen (Audit „Rechner widerrufen“).
4. Mandanten-Token widerrufen: ee auf der Seite „Tokens und Orgs“ (bzw. Plattform-Bereich → „Mandanten“ → Mandant) → „Widerrufen“ (`DELETE /api/v1/ee/mandanten/<id>/tokens/<tokenId>`); Free-Edition noch ohne Dashboard-Funktion, dort setzt der Betrieb `ingest_token.widerrufen` (Präfix aus dem Audit-Eintrag „Ingest-Token erzeugt“, Objekt `ingest_token:<präfix>`).
5. Gespeicherte Daten laufen nach den Aufbewahrungsfristen ab. Sofort löschen (ee, Plattform-Admin): Plattform-Bereich → „Mandanten“ → Mandant → „Mandant löschen“ (`DELETE /api/v1/ee/mandanten/<id>`, Slug zur Bestätigung); der Löschnachweis steht im Plattform-Protokoll (Plattform-Bereich → „Protokoll“).

## 10. Bekannte Grenzen

- Repo-`.claude/settings.json` scheidet aus: Claude Code ignoriert dort die OTel-Exportvariablen.
- Eine Sitzung, die außerhalb eines eingeschlossenen Pfads startet und erst später hineinwechselt, zählt Quelle B nicht.
- Wird `--projekt-pfad` später ergänzt, bucht seatmeter alte Zeilen aus „unzugeordnet“ nicht um; nur neue Anfragen landen im Projekt.
- Server-Managed Settings gelten für alle Mitglieder gleich (keine Gruppen), und `forceLogin*` wirkt dort nicht.
- Das statische Mandanten-Token ist für alle lesbar und erlaubt gefälschte Meldungen; der Helper vermeidet das.
- Binaries gibt es in v1 nur für macOS arm64 und Linux x64; das Installskript ist ein POSIX-Shell-Skript, ein Windows-Installer fehlt.
- Der Helper-Befehl enthält den Agent-Pfad mit `$HOME`. Claude Code 2.1.308 startet den Helper unter macOS über eine Shell und löst `$HOME` auf (geprüft 2026-10-22 mit `--settings`); für Windows und MDM-Pakete trotzdem einen absoluten Pfad eintragen.
