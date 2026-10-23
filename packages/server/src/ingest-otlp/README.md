# Modul `ingest-otlp` (Quelle A)

Besitzt `POST /otlp/v1/logs` und `POST /otlp/v1/metrics` (Architektur §2.1). Registrierung über
`ingestModuleRegistrieren` (`src/ingest-gemeinsam/registrieren.ts`, eine Zeile in `app.ts`).

## Vertrag

| | |
|---|---|
| Content-Type | `application/x-protobuf` (protobufjs, Deskriptor `otlp-proto.generiert.ts` aus `proto/`, opentelemetry-proto v1.11.1) und `application/json` (OTLP/JSON, camelCase, int64 als String oder Zahl); andere → 415 |
| Content-Encoding | `identity` oder `gzip` (entpackt höchstens 16 MB) |
| Körper | höchstens 4 MB (413) |
| Auth | `Authorization: Bearer smi_…` (Mandant) oder `smr_…` (Rechner), SHA-256 über `token_aufloesen`; sonst 401. Geprüft im `onRequest`-Hook, bevor der Körper gelesen wird |
| Rate-Limit | `ingest-gemeinsam/ratenlimit.ts`: Eimer je Client-IP, Fehlversuchs-Sperre je IP, Eimer je Token (`SEATMETER_RATE_OTLP`, Standard 3000/min, Stoß 300; je Mandant `ratenlimit_otlp`); darüber 429 mit `Retry-After` (Körper `google.rpc.Status`) |
| Antwort 200 | `Export*ServiceResponse` im Format der Anfrage; `partialSuccess` (`rejectedLogRecords`/`rejectedDataPoints` + `errorMessage`) nur, wenn Datensätze abgelehnt wurden (fehlende Schlüssel, ungültige Tokenzahlen, Zeitstempel außerhalb des Annahmefensters). Verworfene Ereignisse (Allowlist, Abo-Regel) gelten nicht als abgelehnt |
| Fehler | Körper `google.rpc.Status` (Protobuf oder JSON): 400 nicht dekodierbar, 401, 413, 415, 429, 503 mit `Retry-After: 30` wenn die DB fehlt (SDK wiederholt), 500 |
| Logs | nur Methode, Pfad, Status; bei 500 nur Fehlerart und SQLSTATE. Nie Attribute, Körper oder Header |

## Allowlist (`auswertung.ts`)

- Logs: nur `claude_code.api_request` und `claude_code.auth` (Name aus `eventName`, Attribut `event.name` oder dem Körper `claude_code.*`). Gelesen werden nur die Werte erlaubter Attribute; bei allen anderen nur der Name.
- Andere Ereignisse werden vor jeder Speicherung verworfen. `user_prompt`, `tool_result`, `api_request_body`, `api_response_body`, `assistant_response` und jedes Ereignis mit einem Inhaltsattribut (`prompt`, `prompt_text`, `tool_parameters`, `tool_input`, `tool_output`, `tool_result`, `api_request_body`, …) zählen in `ingest_statistik.verworfen_inhalt`; der Rest (z. B. `tool_decision`) wird nur ignoriert.
- Metriken: nur `claude_code.token.usage` mit `type` ∈ `input`, `output`, `cacheRead`, `cacheCreation` als `otel_kontrollsumme` (`typ` = Attribut `type`; `delta` wird addiert, `cumulative` hält den Höchststand). `claude_code.cost.usage`, `claude_code.session.count` und alle übrigen Metriken werden ignoriert, weil die Datenqualität die Summe aller `wert` je Sitzung mit den gezählten Tokens vergleicht (Phase 1c).

## Normalisierung

- `user.email` → `key_email`, `user.account_uuid` (sonst `user.account_id`) → `key_konto`, sofort als HMAC mit dem Personen-Salt; Rohwerte verlassen `auswertung.ts` nicht.
- Abo-Regel §4: `abo` nur mit Konto (UUID/ID/E-Mail) und `organization.id` ∈ `anthropic_org`; nur `user.id` → `api` (`verworfen_api`); `identity.source = gateway-oidc` → `provider` (`verworfen_api`); Org nicht in der Liste → `fremd_org`; Konto ohne Org bzw. ganz ohne Kennung → `unbekannt` (beides `verworfen_fremd_org`). Nicht-Abo speichert nichts außer dem Zähler.
- Projekt aus `vcs.*` (erneut mit `normalisiereRepoUrl`), `projekt_key` = HMAC(projekt_salt, url_norm), `projekt_alias` zuerst; ohne `vcs.*` → `projekt_id` NULL und `unzugeordnet` +1.
- `anfrage_key` = `request_id`; fehlt sie, `msg:<client_request_id>`; fehlt beides → abgelehnt.
- `sitzung`: Bit A, Person/Org/Projekt nur ergänzen, Auth-Klasse aus A, `cc_version` aus `service.version` bzw. `app.version`, Start/Ende aus den Zeitstempeln. Erfolgreiche `auth`-Ereignisse legen nur die Sitzung an.
- Annahmefenster: nicht älter als `mandant.aufbewahrung_anfrage_tage`, höchstens 1 Tag in der Zukunft; fehlende Monatspartitionen werden angelegt.

## Dateien

`routes.ts` (Kontext, Parser, Hook), `protobuf.ts` (Kodierung), `auswertung.ts` (Allowlist, reine Funktionen), `verarbeiten.ts` (DB), `otlp-proto.generiert.ts` (erzeugt von `scripts/proto-generieren.mjs`).
