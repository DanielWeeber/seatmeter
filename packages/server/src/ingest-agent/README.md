# Modul `ingest-agent` (Quelle B)

Besitzt `POST /api/ingest/v1/anfragen` und `POST /api/ingest/v1/sitzungen` (Architektur §2.2).

## Vertrag

| | |
|---|---|
| Auth | nur `Authorization: Bearer smr_…` (Rechner-Token); Mandanten-Token → 401 |
| Rate-Limit | `ingest-gemeinsam/ratenlimit.ts`: Eimer je Client-IP, Fehlversuchs-Sperre je IP, Eimer je Rechner (`SEATMETER_RATE_AGENT`, Standard 300/min, Stoß 60; je Mandant `ratenlimit_agent`), gemeinsam mit `/api/agent/v1/{config,heartbeat}`; sonst 429 mit `Retry-After` und `{ fehler }` |
| `anfragen` | `agentPushSchema` (strikt, 1–1000 Einträge) |
| `sitzungen` | `agentSitzungenPushSchema` (strikt, 1–1000 Einträge; neu in `@seatmeter/shared`) |
| 400 | unbekannte Felder (z. B. `cwd`, `transcript_path`, Hostnamen, `content`), fehlende Felder, `projekt.url_norm`, die keine normalisierte Remote-URL ist. Die Antwort nennt nur Feldpfade, nie Werte |
| 200 | `{ angenommen, wiederholt, verworfen_api, verworfen_fremd_org, abgelehnt }` (`agentPushAntwortSchema`) |
| 503 | DB nicht erreichbar, mit `Retry-After` |

## Verarbeitung

- Abo-Regel für B: `auth_hinweis.klasse = api` → `verworfen_api`; `oauth` mit `org_uuid` ∈ `anthropic_org` → abo; andere Org → `fremd_org`; ohne Org → `unbekannt` (zählt als `verworfen_fremd_org`). Nur Abo wird gespeichert.
- Person: aus der Rechnerbindung (`rechner.person_id`), sonst `key_konto` aus `auth_hinweis.account_uuid`.
- Projekt aus `projekt.url_norm` (gleiche Normalisierung und HMAC wie A) oder Pfad-Projekt `projekt: { typ: 'pfad', name }` (Agent-Option `pfad_projekte`, strikt, Name ohne Pfad): eigenes Projekt mit `provider = 'pfad'`, `url_norm` NULL, `anzeigename` = Name, Schlüssel HMAC(projekt_salt, `pfad:` + Name). Alte Zeilen werden nicht umgebucht.
- `anfrage_key` = `request_id`, sonst `msg:<message_id>`. Schlüssel-Upsert (gemeinsam mit A, `ingest-gemeinsam/speichern.ts`): setzt Bit B = 2. Liegt A schon vor, bleiben Tokens, Person und Auth-Klasse aus A; B ergänzt `cache_write_1h` (5m/1h-Aufteilung nur aus B), `inference_geo`, `service_tier`, `ist_subagent`, `web_search`, und das Projekt aus B gewinnt. Beim ersten Zusammentreffen setzt der Upsert `abweichung_ab`, wenn die Tokens nicht übereinstimmen.
- Nicht hier: die Heuristik für `msg:`-Schlüssel (± 2 s, Token-Tupel) gehört zum Modul `merge` (Phase 2).
- `ingest_statistik` (quelle `b`), `rechner.zuletzt_gesehen` und `agent_version`, `ingest_token.zuletzt_genutzt`.
