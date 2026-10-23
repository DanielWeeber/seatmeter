# Modul `ausrollen`

Ausroll-Paket (Architektur §10): liefert die Werte für die Dashboard-Seite „Ausrollen“ (Schnipsel-Generator
für Managed Settings, Server-Managed Settings, Benutzer-Einstellungen, Start-Wrapper und Agent-Installation).
Kern (frei), nur Rolle `mandanten_admin`.

| Route | Verhalten |
|---|---|
| `GET /api/v1/ausrollen` | `ausrollenKonfigurationSchema` (`@seatmeter/shared`): Mandant (Slug, Name, Plan), `ingest_url` und `otlp_endpoint` (= `<ingest_url>/otlp`), Herkunft der URL (`konfiguration` = `SEATMETER_INGEST_URL`, `oeffentlich` = `SEATMETER_PUBLIC_URL`, `anfrage` = aus `X-Forwarded-*` bzw. der Anfrage), Org-Positivliste, `agent.release_url` (`SEATMETER_AGENT_RELEASE_URL`, nur http/https) und `agent.server_version`. Enthält nie ein Token. |
| `POST /api/v1/ausrollen/mandanten-token` | Neues Mandanten-Token (`smi_…`) für Schnipsel mit festem Header: 201 `{ token, praefix, erstellt }` mit `Cache-Control: no-store`; nur SHA-256 und Präfix landen in `ingest_token`, Audit `Ingest-Token erzeugt` mit `ingest_token:<präfix>`. |

Umgebungsvariablen werden je Anfrage gelesen. Gesendet wird nach dem Commit (die Transaktion gibt nur Daten
zurück, siehe „Antworten aus Transaktionen“ in `packages/server/README` bzw. `ee/server/src/gemeinsam/antwort.ts`).
Widerruf eines Mandanten-Tokens: `DELETE /api/v1/mandant/tokens/:tokenId` (Modul `mandant`).
