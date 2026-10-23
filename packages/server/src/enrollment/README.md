# Modul `enrollment`

Rechner-Registrierung (Architektur §2.2 `enroll <code>`, §6) und Mandanten-Einrichtung per CLI.

## Agent-Routen (öffentlicher Ingest-Host)

| Route | Auth | Verhalten |
|---|---|---|
| `POST /api/agent/v1/enroll` | keine (Einmalcode im Körper, `enrollmentAnfrageSchema`; je Client-IP `SEATMETER_RATE_ENROLL` = 10 Versuche/min und `SEATMETER_RATE_ENROLL_FEHLVERSUCHE` = nach 5 falschen Codes 1 je Minute, dann 429 mit `Retry-After`, auch für einen richtigen Code) | Code (groß, ohne `-`/Leerraum) → SHA-256 → `einmalcode_aufloesen`; verbraucht den Code atomar, legt `rechner` (os, agent_version) und `ingest_token` typ `rechner` an. 201 mit `enrollmentAntwortSchema`, das Token (`smr_…`) nur in dieser Antwort (`Cache-Control: no-store`). Ungültig, abgelaufen oder genutzt → 401 |
| `GET /api/agent/v1/config` | `Bearer smr_…` (Ratenlimit je Rechner wie `/api/ingest/v1/*`) | `agentKonfigurationSchema` mit Standardwerten (Modus `hooks`, Sweeper 10 min, keine Pfadfilter, 30 Tage Rückfüllung); `server_url` aus `SEATMETER_INGEST_URL`, sonst aus `X-Forwarded-Proto/-Host` bzw. der Anfrage. Widerrufen → 401 |
| `POST /api/agent/v1/heartbeat` | `Bearer smr_…` | Lebenszeichen nach jedem Push-Lauf des Agenten (ab v0.1.2), Körper `agentHeartbeatSchema` (strikt, nur `agent_version`; andere Felder → 400). Setzt `rechner.zuletzt_gesehen` (Server-Uhr), `rechner.agent_version` und `ingest_token.zuletzt_genutzt` ohne Minuten-Drosselung; 204 ohne Körper. Widerrufen oder Mandanten-Token → 401. Grundlage für `agenten` in `/api/health/ingest` |

## Dashboard-Routen (Rolle `mandanten_admin`)

| Route | Verhalten |
|---|---|
| `POST /api/v1/rechner/einmalcode` | Körper `{ bezeichnung?, person_id?, pseudonym? }`; 201 `{ code, laeuft_ab, person_id, bezeichnung }`, Code `XXXX-XXXX-XXXX` (60 Bit), 24 h gültig, nur einmal angezeigt; unbekannte Person → 404. Die Bezeichnung (Spalte `einmalcode.bezeichnung`, Migration 0011) wird beim Enrollment zu `rechner.bezeichnung` |
| `GET /api/v1/rechner` | `{ rechner: [{ id, bezeichnung, os, agent_version, registriert, zuletzt_gesehen, widerrufen, person_id, person_pseudonym }] }` (Zeitpunkte ISO oder `null`) |
| `POST /api/v1/rechner/:id/widerrufen` | setzt `rechner.widerrufen` und widerruft alle Tokens des Rechners; 204, 404 wenn unbekannt |

Anmeldung: `requireRolle('mandanten_admin')` aus dem Modul `auth` (Cookie-Sitzung mit CSRF, Header-Modus oder Plugin-Provider); ohne Anmeldung 401, ohne Rolle 403. Erzeugte Einmalcodes und Widerrufe landen im `audit` (`Einmalcode erzeugt` mit `person:<id>`, falls gebunden; `Rechner widerrufen` mit `rechner:<id>`).

## CLI `mandant:anlegen`

```sh
pnpm --filter @seatmeter/server build
pnpm --filter @seatmeter/server mandant:anlegen --slug pilot --name "Pilot" --org <org-uuid> [--org …] [--plan max_pilot] [--neues-token]
```

Braucht `DATABASE_URL` und `SEATMETER_MASTER_KEY`, führt offene Migrationen aus. Idempotent über den Slug: legt Mandant, `mandant_geheimnis` (Personen- und Projekt-Salt, je 32 Byte, verschlüsselt mit `krypto.ts`) und die Org-Positivliste an. Ein Mandanten-Token (`smi_…`) entsteht nur, wenn noch keines aktiv ist oder `--neues-token` gesetzt ist; der Klartext erscheint nur in dieser Ausgabe.
