# OTLP-Fixtures (von Hand erstellt)

Diese Dateien sind **von Hand erstellt** nach der öffentlichen Doku von Claude Code
(https://code.claude.com/docs/en/monitoring-usage, Stand 2026-10-22: Standardattribute, `vcs.*`,
Ereignisse `claude_code.api_request`, `claude_code.user_prompt`, `claude_code.auth`, Metrik
`claude_code.token.usage` mit Temporalität `delta`). Sie sind **keine Mitschnitte** echter Exporte und
enthalten nur erfundene Werte (Beispiel-Domains, erfundene UUIDs und Request-IDs, Test-E-Mail
`test.person@example.com`).

Form: OTLP/JSON (camelCase, int64 als String). Die Tests kodieren dieselben Objekte zusätzlich als
Protobuf (`protobufKodieren`), um JSON und Protobuf gegeneinander zu prüfen.

Platzhalter, die `test/ingest-hilfen.ts` beim Laden ersetzt (damit die Zeitstempel in den vorhandenen
Monatspartitionen und im Annahmefenster liegen):

| Platzhalter | Ersetzung |
|---|---|
| `{{JETZT_NANO}}` | jetzt in Nanosekunden seit 1970 (String) |
| `{{START_NANO}}` | jetzt minus 60 s in Nanosekunden |
| `{{JETZT_ISO}}` | jetzt als ISO-8601 |
| `{{REQUEST_ID}}` | Request-ID je Test (Standard `req_011FIXTURE0000000001`) |

| Datei | Inhalt |
|---|---|
| `logs-api-request.json` | ein `api_request` (OAuth, Org, Konto, E-Mail, `vcs.*`) und ein `auth`-Ereignis |
| `logs-user-prompt.json` | ein `user_prompt` mit Prompt-Text und ein `tool_decision` (ohne Inhalt) |
| `logs-api-key.json` | ein `api_request` nur mit `user.id` und `session.id` (API-Key-Fall) |
| `metrics-token-usage.json` | `claude_code.token.usage` (Summe, delta) und `claude_code.cost.usage` |
