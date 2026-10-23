# Fixtures: Claude Enterprise Analytics API (per-User Usage und Cost)

Stand der Doku-Prüfung: 2026-10-22. Es gibt keine Live-Enterprise-Org; alle Dateien sind aus der offiziellen Doku abgeleitet, die Daten sind komplett fiktiv (example.com, erfundene IDs).

## Quellen

- Referenz usage: https://platform.claude.com/docs/en/api/beta/organization/analytics/user_usage_report
- Referenz cost: https://platform.claude.com/docs/en/api/beta/organization/analytics/user_cost_report
- Sammelseite (gleicher Inhalt): https://platform.claude.com/docs/en/api/admin/analytics
- Key, Plan, Frische, Rate Limit, Beträge: https://platform.claude.com/docs/en/manage-claude/analytics-api
- Plan-Hinweis (nicht Teams): https://code.claude.com/docs/en/analytics
- Fehlerformat: https://platform.claude.com/docs/en/api/errors
- Rate Limits / retry-after: https://platform.claude.com/docs/en/api/rate-limits
- Beta-Header-Tabelle (kein Analytics-Eintrag): https://platform.claude.com/docs/en/api/beta-headers
- Gegenprobe: npm-Paket @anthropic-ai/sdk 1.1.0, `client.beta.organization.analytics.userUsageReport.list` (Pfad, Query-Parameter, Cursor-Paging)
- Abgrenzung (Admin-Key, NICHT Enterprise): https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api

## Korrekturen an den ursprünglichen Annahmen

1. Kein Admin-Key. Nötig ist ein eigener Analytics-API-Key mit Scope `read:analytics`, anlegbar nur vom Primary Owner in claude.ai (Doku nennt `https://claude.ai/admin-settings/api-access`, die Claude-Code-Doku `https://claude.ai/analytics/api-keys`). Ein Admin-Key funktioniert dort nicht und umgekehrt.
2. Die beiden `user_*`-Endpunkte liefern flache Zeilen in `data[]` (eine Zeile je Nutzer x Zeitbucket x Gruppierung). Das verschachtelte `data[].results[]` gibt es nur bei den Bucket-Endpunkten `/usage_report` und `/cost_report`.
3. Beträge (`amount`, `list_amount`) sind Dezimal-Strings in Bruchteilen von Cent, nicht USD: `"41280.000000"` = 412,80 USD. Währung `currency` ist immer `"USD"`.
4. `starting_at` und `ending_at` sind RFC 3339 mit Zeitzone (nicht YYYY-MM-DD); `ending_at` ist exklusiv, bei `bucket_width` Pflicht, maximal 31 Tage Spanne.
5. Teams-Plan: nicht verfügbar. Nur Claude Enterprise. Bei seat-basierten Enterprise-Plänen spiegeln die Kosten-/Usage-Endpunkte nur Usage-Credits.
6. Nur Nutzung, die einem Seat-Nutzer zugeordnet ist; API-Key- und Automationsverkehr nur über die Bucket-Endpunkte. Claude Code über Amazon Bedrock fehlt.

## Request-Beispiele (verifiziert gegen Doku)

Basis `https://api.anthropic.com`. Header: `x-api-key: <Analytics-Key>` und `anthropic-version: 2023-06-01`. Kein `anthropic-beta`-Header dokumentiert (das SDK hängt nur `?beta=true` an die URL). Bei curl `-g` setzen (eckige Klammern), der SDK-Standard kodiert sie als `%5B%5D`.

Usage, Seite 1 (4 Zeilen je Seite):

    GET /v1/organizations/analytics/user_usage_report?starting_at=2026-10-05T00:00:00Z&ending_at=2026-10-07T00:00:00Z&bucket_width=1d&products[]=claude_code&group_by[]=model&limit=4

Usage, Seite 2: dieselben Parameter plus `page=<next_page aus Seite 1>` (Wert aus `usage-seite-1.json`: `page_ZXhhbXBsZS1jdXJzb3ItdXNhZ2UtcDI=`).

Cost (eine Seite, Standard-`limit=20` reicht):

    GET /v1/organizations/analytics/user_cost_report?starting_at=2026-10-05T00:00:00Z&ending_at=2026-10-07T00:00:00Z&bucket_width=1d&products[]=claude_code&group_by[]=model

Weitere Parameter (beide Endpunkte): `order` (asc/desc, Standard desc), `order_by` (usage: `total_tokens` Standard, `output_tokens`, `requests`, `uncached_input_tokens`; cost: `amount` Standard, `list_amount`), `models[]`, `user_ids[]`, `rbac_group_ids[]`, `exclude_deleted_users`, weitere `group_by[]`-Werte (`product`, `speed`, `context_window`, `inference_geo`, `rbac_group_id`; nur cost: `cost_type`, `token_type`).

## Paging

- `limit` 1 bis 1000, Standard 20. Bei `bucket_width` oder `group_by[]` zählt jede Nutzer/Bucket/Dimension-Zeile; `cost_type`/`token_type` zählen nicht mit.
- Weiter blättern, solange `has_more` true ist: `next_page` unverändert als `page` senden, alle anderen Parameter unverändert lassen (geänderte Parameter mit altem Cursor = 400).
- Cursor kann nach Datenaktualisierung ablaufen: HTTP 410, dann ab Seite 1 neu starten.
- `usage-seite-1.json` hat `has_more: true`, `usage-seite-2.json` `has_more: false, next_page: null`.

## Einheiten und Felder

- Tokens: ganze Zahlen. `total_tokens` = Summe aller Tokenarten (aus der Doku-Beschreibung abgeleitet, in den Fixtures als uncached + cache_read + cache_creation 5m + 1h + output gerechnet).
- Cache-Erstellung: `cache_creation.ephemeral_5m_input_tokens` und `cache_creation.ephemeral_1h_input_tokens`; Cache-Lesen: `cache_read_input_tokens`.
- `actor`: `type` (immer `user_actor`), `user_id`, `email_address` (null bei gelöschtem Konto/Service-Account), `name` (null, wenn nicht gesetzt; "Deleted User" bei gelöschtem Konto), `deleted`; `email` ist deprecated (gleicher Wert wie `email_address`, ignorieren). Als Schlüssel `user_id` nehmen.
- Nicht gruppierte Dimensionen (`product`, `speed`, `context_window`, ...) kommen als `null`.
- Kontrollsummen der Fixtures: Nutzer A (`user_01AbCdEfGhIjKlMnOpQrSt`) 36.341.500 Tokens, 434 Requests, amount 2375,44 Cent, list_amount 2393,65 Cent. Nutzer B (`user_01UvWxYzAbCdEfGhIjKlMn`, `name: null`, am 2026-10-06 ohne Opus-Zeile) 3.849.000 Tokens, 81 Requests, amount 182,69 Cent, list_amount 188,93 Cent. Zeilenschlüssel (user_id, starting_at, model) und `requests` sind in Usage und Cost identisch; Preise sind frei erfunden, nicht aus Tokens berechnet.

## Frische

- Kosten/Usage: typisch 4 Stunden Verzug, bis 24 Stunden; Werte können bis etwa 7 Tage nach Monatsende revidiert werden (Oktoberwerte bis ca. 7. November). Für rechnungsfeste Summen nur Monate abfragen, die mindestens 7 Tage zurückliegen.
- `data_refreshed_at` ist die Wasserlinie; Daten dahinter sind unvollständig. Für stabile Wiederholungen `ending_at` <= `data_refreshed_at` setzen.
- Daten gibt es erst ab 2026-01-01; `starting_at` höchstens 365 Tage zurück.

## Fehler

- Dokumentiertes Format (Fixtures `fehler-401.json`, `fehler-429.json`): `{"type":"error","error":{"type":...,"message":...},"request_id":"req_..."}`; zusätzlich Header `request-id`.
- Statuscodes laut Fehlerseite: 400 `invalid_request_error`, 401 `authentication_error`, 403 `permission_error`, 404 `not_found_error`, 429 `rate_limit_error`, 500 `api_error`, 529 `overloaded_error`; für diese Reports zusätzlich 410 (abgelaufener Cursor).
- Rate Limit: 60 Requests pro Minute je Organisation über alle Endpunkte dieser API (nicht je Key). Bei 429 `retry-after` (Sekunden) beachten; laut Doku trägt nicht jede 429 diesen Header.
- Die Nachrichtentexte in den Fixtures sind Beispiele (401 "invalid x-api-key" ist der übliche Text der Plattform); die Doku legt für diese Endpunkte keine festen Texte fest.

## Verifiziert (Doku) und nicht belegt

Verifiziert: Pfade und Methode, Query-Parameter samt Grenzen, Antwortfelder, Betragsformat, Paging (`has_more`, `next_page`, `page`, 410), 60 rpm, Plan (nur Enterprise, nicht Teams), Frische, Key-Typ und Scope, `anthropic-version` (laut Referenz optional, laut Anleitung bei jedem Request mitsenden), kein dokumentierter `anthropic-beta`-Header.

Nicht belegt (angenommen): Reihenfolge der Zeilen innerhalb eines Nutzers (Fixture: Tag, dann Modell; Client darf sich nicht darauf verlassen, nach (user_id, starting_at, model) aggregieren); Genauigkeit der Zeitstempel (Doku-Beispiel mit Millisekunden, Fixture ohne; beides als RFC 3339 parsen); Aufbau des Cursors (opak, `page_`-Präfix erfunden); exakter Status/Text bei fehlendem Scope (vermutlich 403) oder Teams-Plan; ob fehlende Felder als `null` oder gar nicht kommen (tolerant lesen); Key-Präfix. Nichts davon wurde live getestet.
