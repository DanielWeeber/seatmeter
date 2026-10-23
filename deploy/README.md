# seatmeter betreiben

Ein Container `server` (API, Ingest, Dashboard) und ein Postgres 18. Der Server liefert das Dashboard selbst aus (`SEATMETER_WEB_DIST=/app/web` im Image), migriert die Datenbank beim Start und braucht davor einen Reverse-Proxy mit TLS.

| Datei | Zweck |
|---|---|
| `../Dockerfile` | Image bauen (mehrstufig: pnpm install mit fester Lock-Datei, Build von shared/server/web/agent, Laufzeit `node:24-bookworm-slim` als Benutzer `node`, `HEALTHCHECK` auf `/api/health`) |
| `compose.yml` | Betrieb mit Docker Compose: `server` (kein veröffentlichter Port, externes Proxy-Netz plus internes Netz) und `postgres` (nur internes Netz, Volume `pg-data`) |
| `env.example` | Vorlage für `deploy/.env` (Werte nie committen) |
| `backup.sh` | nächtlicher `pg_dump -Fc` mit Prüfung, Rotation und optionaler Rückmeldung (Heartbeat) |
| `compose.dev.yml` | nur Entwicklung (Werkzeuge im Container), nicht für den Betrieb |

## Erststart

1. Proxy-Netz anlegen, falls es noch keines gibt: `docker network create proxy` (oder den Namen in `SEATMETER_PROXY_NETZ` setzen).
2. Umgebung anlegen: `cp deploy/env.example deploy/.env && chmod 600 deploy/.env`, dann die Werte setzen:
   - `POSTGRES_PASSWORD`: `openssl rand -hex 24` (nur Buchstaben und Ziffern, weil es in `DATABASE_URL` steht)
   - `SEATMETER_MASTER_KEY`: `openssl rand -base64 32` (32 Byte, Base64 oder Hex)
3. Starten: `docker compose -f deploy/compose.yml up -d --build`. Der Server wartet auf Postgres, migriert unter einem Advisory-Lock und legt die Monatspartitionen an.
4. Prüfen: `docker compose -f deploy/compose.yml ps` zeigt `healthy`; im Proxy-Netz antwortet `http://<container>:8080/api/health` mit `{"status":"ok","db":"ok"}`.
5. Erste Anmeldung: Ohne Proxy-Anmeldung schreibt der Server beim ersten Start ein **Einrichtungs-Token** ins Log (`docker compose -f deploy/compose.yml logs server | grep -i einrichtung`). Die Seite „Einrichtung“ im Dashboard fragt Token, Login und Passwort (mindestens 12 Zeichen) ab und legt den lokalen Admin an. Das Token gilt nur einmal.
6. Den Master-Schlüssel getrennt vom Server sichern (Passwort-Manager, Schlüsselbund). Er steckt nicht im Datenbank-Backup; ohne ihn lassen sich die verschlüsselten Mandanten-Salts nicht mehr lesen und die Pseudonyme nicht fortführen.

## Umgebungsvariablen

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `POSTGRES_PASSWORD` | ja | Passwort der Rolle `seatmeter`; Compose baut daraus `DATABASE_URL` |
| `DATABASE_URL` | (gesetzt) | `postgres://…`; nur ändern, wenn eine externe Datenbank genutzt wird |
| `SEATMETER_MASTER_KEY` | ja | 32 Byte (Base64/Hex), verschlüsselt Salts und Schlüssel (AES-256-GCM) |
| `PORT` | nein | Standard 8080 |
| `LOG_LEVEL` | nein | `info` (Standard), `debug`, `warn` …; Logs enthalten nie Körper, Header-Werte oder IP-Adressen |
| `SEATMETER_PUBLIC_URL` | empfohlen | Basis-URL des Dashboards, z. B. `https://seatmeter.example.org` |
| `SEATMETER_TRUST_REMOTE_USER_HEADER` | nein | Name des Headers (z. B. `Remote-Email`), dem der Server als angemeldetem Benutzer vertraut. **Nur** setzen, wenn ein vorgeschalteter Proxy (z. B. Authelia per `forward_auth`) diesen Header auf allen Dashboard-Pfaden selbst setzt und ihn auf den freien Pfaden entfernt. Dann entfällt die Login-Seite. |
| `SEATMETER_AUTO_MANDANT` | nein | Slug des Mandanten, dem Proxy-Benutzer ohne eigenes Konto zugeordnet werden |
| `SEATMETER_WEB_DIST` | (Image) | Verzeichnis mit dem Dashboard-Build; im Image `/app/web`. Leer = nur API |
| `SEATMETER_INGEST_URL` | empfohlen | Öffentliche Basis-URL des Ingest-Hosts (z. B. `https://ingest.example.org`) für die Agent-Konfiguration und die Seite „Ausrollen“; ohne sie leitet der Server die URL aus der Anfrage ab (Dashboard-Host, meist falsch für die Rechner) |
| `SEATMETER_AGENT_RELEASE_URL` | nein | Download-Ordner des Agent-Releases, z. B. `https://<forgejo-host>/<org>/seatmeter/releases/download/v0.1.0`; die Seite „Ausrollen“ baut daraus den Installationsbefehl |
| `SEATMETER_TRUST_PROXY` | hinter Proxy | Woher die Client-IP für Ratenlimits und Anmelde-Sperre kommt: leer/`aus` = Socket-Adresse (X-Forwarded-For wird ignoriert); `1` (Anzahl der Proxy-Stufen) oder kommagetrennte IPs/CIDRs der Proxys = aus `X-Forwarded-For`. Nur setzen, wenn alle Anfragen über den Proxy kommen und er X-Forwarded-For selbst setzt (Caddy tut das) |
| `SEATMETER_RATE_OTLP`, `SEATMETER_RATE_AGENT`, `SEATMETER_RATE_IP`, `SEATMETER_RATE_FEHLVERSUCHE`, `SEATMETER_RATE_ENROLL`, `SEATMETER_RATE_ENROLL_FEHLVERSUCHE` | nein | Ratenlimits der Ingest-Pfade als `<anfragen_pro_minute>/<stoss>`, siehe „Ratenlimits“ |
| `SEATMETER_PLUGINS` | nein | kommagetrennte Plugin-Module (ee, nur mit Lizenz) |
| `SEATMETER_LIZENZ_DATEI` | nur ee | Pfad der signierten Lizenzdatei (read-only gemountet), siehe „Lizenz und ee-Image“ |
| `SEATMETER_OIDC_ISSUER`, `SEATMETER_OIDC_CLIENT_ID`, `SEATMETER_OIDC_CLIENT_SECRET` | nur ee | OIDC-Anmeldung (Authelia als Referenz); weitere Variablen in `ee/server/README.md` |
| `SEATMETER_OIDC_GRUPPEN` | nein (ee) | Gruppen → Rollen als JSON, z. B. `{"admins":[{"mandant":"meine-firma","rolle":"mandanten_admin"},{"plattform_admin":true}]}` |

## Reverse-Proxy

Pfade und ihr Schutz:

| Pfad | Schutz |
|---|---|
| `/otlp/*`, `/api/ingest/*`, `/api/agent/*` | Bearer-Token der App (Mandanten- bzw. Rechner-Token); **ohne** vorgeschaltete Anmeldung, `Remote-*`-Header entfernen |
| `/api/health`, `/api/health/ingest` | ohne Anmeldung (Monitoring) |
| alles andere (Dashboard, `/api/v1/*`) | vorgeschaltete Anmeldung (z. B. Authelia `forward_auth`) oder der lokale Login der App |

Beispiel Caddy mit Authelia (Hostnamen anpassen):

```caddyfile
seatmeter.example.org {
	encode zstd gzip
	request_body {
		max_size 8MB
	}
	@frei path /otlp/* /api/ingest/* /api/agent/* /api/health /api/health/*
	handle @frei {
		reverse_proxy seatmeter-server-1:8080 {
			header_up -Remote-User
			header_up -Remote-Groups
			header_up -Remote-Email
			header_up -Remote-Name
		}
	}
	handle {
		forward_auth authelia:9091 {
			uri /api/authz/forward-auth
			copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
		}
		reverse_proxy seatmeter-server-1:8080
	}
}
```

Hinter dem Proxy `SEATMETER_TRUST_PROXY=1` setzen, sonst sieht der Server alle Clients unter der Adresse des Proxys (ein gemeinsamer Eimer je IP). Für einen Host über den Cloudflare-Tunnel setzt Caddy `X-Forwarded-For` auf `CF-Connecting-IP` (`header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}`).

Ein eigener öffentlicher Ingest-Host (z. B. `ingest.example.org`) gibt nur `/otlp/*`, `/api/ingest/*`, `/api/agent/*` und `/api/health` weiter und antwortet sonst mit 404; das Dashboard bleibt intern oder hinter einer öffentlichen Anmeldung.

## Mandant, Org und Ingest-Token anlegen

Die CLI `mandant:anlegen` ist idempotent über den Slug: Ein schon vorhandener Mandant (etwa aus der Einrichtung im Dashboard) bekommt die Org in die Positivliste und, falls noch keines aktiv ist, ein Mandanten-Token (`smi_…`). Ein ausdrücklich angegebener `--plan` wird übernommen; `--neues-token` erzeugt zusätzlich ein neues Token.

```sh
docker compose -f deploy/compose.yml exec -T server \
  node /app/server/dist/enrollment/cli-mandant-anlegen.js \
  --slug <slug> --name <Name> --plan team|enterprise|max_pilot --org <organizationUuid>
```

Das Token steht nur in dieser einen Ausgabe. Nicht im Terminal stehen lassen, sondern direkt in den Passwort-Manager bzw. Schlüsselbund leiten (Zeile mit `smi_` herausfiltern); nie in Repos, Tickets oder `settings.json`.

## Health und Monitoring

Beide Health-Routen brauchen keine Anmeldung und gehören nur ins interne Netz (der öffentliche Ingest-Host gibt nur `/api/health` weiter).

| Route | Antwort |
|---|---|
| `GET /api/health` | 200 `{ status: "ok", db: "ok" }` mit DB-Ping, sonst 503 |
| `GET /api/health/ingest` | immer 200 (503 nur ohne DB); `quellen.a`/`quellen.b`: `letzte_annahme`, `stille_stunden`, `anfragen_24h`, `abgelehnt_429_24h`, `heute`; `agenten` (Schema `ingestAgentenSchema` in `@seatmeter/shared`), mandantenübergreifend; `ratenlimit` (`seit`, `abgelehnt_429_24h_je_art`) |

`agenten` (nicht widerrufene Rechner; Lebenszeichen = `rechner.zuletzt_gesehen`, gesetzt von jedem Push und ab Agent v0.1.2 vom Heartbeat nach jedem Sweeper-Lauf, `POST /api/agent/v1/heartbeat`):

| Feld | Bedeutung |
|---|---|
| `gesamt`, `aktiv_48h` | Rechner insgesamt bzw. mit Lebenszeichen in den letzten 48 h |
| `aeltester_heartbeat_stunden`, `juengster_heartbeat_stunden` | Stunden seit dem ältesten bzw. jüngsten Lebenszeichen (eine Nachkommastelle; `null` ohne Rechner) |
| `stille_trotz_heartbeat_stunden` | ganze Stunden ohne Lieferung von Quelle B, obwohl ein Agent in den letzten 2 h gelebt hat (sonst 0) |
| `luecke_zu_a_stunden` | ganze Stunden, über die Quelle A für Personen mit Agent-Daten Anfragen geliefert hat, ohne dass B nachzog (A-Anfragen ohne B-Gegenstück nach der jüngsten B-Anfrage derselben Person, letzte 30 Tage) |

Empfohlene Monitoring-Bedingungen (Gatus), beide ohne Fehlalarm nachts und am Wochenende:

| Prüfung | Bedingung | Bedeutung |
|---|---|---|
| Agenten leben | `[BODY].agenten.aktiv_48h > 0` | kein Rechner hat sich 48 h gemeldet: Sweeper aus, Rechner weg oder Token widerrufen |
| B fehlt trotz Arbeit | `[BODY].agenten.luecke_zu_a_stunden < 4` | A liefert seit über 4 h Anfragen, zu denen B nichts nachliefert: Agent hängt, Push scheitert oder Transkript-Format geändert. Setzt voraus, dass A und B dieselben Sitzungen sehen (gleicher Pfad-Bereich) |
| ohne Quelle A | `[BODY].agenten.stille_trotz_heartbeat_stunden < 72` | nur, wo A fehlt: Agenten leben, aber B liefert seit 72 h nichts. Falsch-positiv, wenn mit eingeschaltetem Rechner drei Tage niemand arbeitet |

Die Felder für Bedingungen sind ganze Zahlen: Gatus vergleicht Zahlen in Bedingungen als Ganzzahl (Kommazahlen werden abgeschnitten).

## Ratenlimits

Der Server begrenzt die Ingest-Pfade selbst (Token-Buckets im Speicher, eine Instanz). Grenzen als `<anfragen_pro_minute>/<stoss>` (Stoß = so viele Anfragen am Stück, danach gilt die Minutenrate); nur eine Zahl = Stoß gleich Minutenwert.

| Variable | Standard | Schlüssel | Gilt für |
|---|---|---|---|
| `SEATMETER_RATE_IP` | `12000/1200` | Client-IP | alle Ingest-Pfade, vor der Token-Prüfung |
| `SEATMETER_RATE_FEHLVERSUCHE` | `30/30` | Client-IP | nur Anfragen ohne gültiges Token (fehlt, unbekannt, widerrufen, falscher Typ). Ist der Vorrat leer, antwortet der Server mit 429, ohne die Datenbank zu fragen; Tokens, die in den letzten 10 min gültig waren, bleiben frei |
| `SEATMETER_RATE_OTLP` | `3000/300` | Token | `/otlp/v1/*`; je Mandant überschreibbar (`ratenlimit_otlp`) |
| `SEATMETER_RATE_AGENT` | `300/60` | Rechner | `/api/ingest/v1/*`, `/api/agent/v1/config`, `/api/agent/v1/heartbeat`; je Mandant überschreibbar (`ratenlimit_agent`) |
| `SEATMETER_RATE_ENROLL` | `10/10` | Client-IP | jeder Versuch auf `POST /api/agent/v1/enroll` |
| `SEATMETER_RATE_ENROLL_FEHLVERSUCHE` | `1/5` | Client-IP | falsche, abgelaufene oder genutzte Einmalcodes: nach 5 Fehlversuchen 1 je Minute, solange auch für richtige Codes 429 |

- Antwort: 429 mit `Retry-After` (Sekunden) und `{ "fehler": "Zu viele Anfragen, bitte in N s erneut versuchen" }`, auf `/otlp/v1/*` als `google.rpc.Status`. Agent und Claude Code warten danach selbst.
- Je Mandant: `PUT /api/v1/mandant/einstellungen` mit `{ "ratenlimit_otlp": 6000 }` bzw. `{ "ratenlimit_agent": 600 }` (Anfragen pro Minute, 10–1.000.000; `null` = Standard); der Stoß wächst im Verhältnis des Standards. Wirkt spätestens nach 60 s, steht im Audit.
- Beobachten: `/api/health/ingest` → `quellen.<a|b>.abgelehnt_429_24h` und `ratenlimit.abgelehnt_429_24h_je_art` (`ip`, `fehlversuch`, `token`, `rechner`, `enroll`, `enroll_fehlversuch`), gezählt im Speicher ab Serverstart (`ratenlimit.seit`). Das Log meldet je Schlüsselart höchstens einmal je Minute „Ratenlimit greift“ mit Art, Quelle und Wartezeit, nie Token, Hash oder IP.
- Die Client-IP stimmt nur mit `SEATMETER_TRUST_PROXY` (siehe Reverse-Proxy); ohne teilen sich alle Clients hinter dem Proxy einen Eimer je IP.

## Jobs

Der Server plant seine Jobs selbst (Cron in UTC, Advisory-Lock, Protokoll in `job_lauf`). Einmal von Hand: `docker compose -f deploy/compose.yml exec -T server node /app/server/dist/main.js --einmal <job>`.

| Job | Zeitplan (UTC) | Inhalt |
|---|---|---|
| `partitionen.anlegen` | täglich 00:05 | Monatspartitionen von `anfrage` |
| `merge.ab` | alle 5 Minuten | Zusammenführung A/B (Heuristik für `msg:`-Schlüssel, Modul `merge`) |
| `aggregation.tag` | täglich 02:15 | Tagesaggregat der letzten 35 Tage |
| `kurs.ezb` | täglich 03:00 | EZB-Kurs USD/EUR (Monatsmittel endgültig, laufender Monat vorläufig aus den Tageskursen); braucht ausgehendes HTTPS zu `data-api.ecb.europa.eu` |
| `kalkulation.monatsabschluss` | am 1. um 03:30 | Vormonat je Mandant einfrieren (vorhandene Abschlüsse bleiben) |
| `aufbewahrung.loeschen` | täglich 02:45 | Löschläufe laut Fristen, protokolliert in `loeschlauf` |
| `budgets.pruefen` (ee) | stündlich, Minute 7 | Budgets gegen Schwellen prüfen, je Schwelle ein Alarm, Zustellung über die Alarmkanäle |
| `hinweise.erzeugen` (ee) | täglich 04:30 | Projekt-Hinweise des laufenden Monats |
| `abgleich.analytics` (ee) | täglich 05:00 | Analytics API (nur Mandanten mit Key): letzte 8 UTC-Tage → `ueberschreitung`, `abgleich_lauf`; braucht ausgehendes HTTPS zu `api.anthropic.com` |

## Kalkulation einrichten (Sitzkosten, Kurs, Monatsabschluss)

Alles über die Dashboard-API mit Admin-Rolle (Seite „Preise & Sitzkosten“ bzw. „Einstellungen“) oder per `curl` im Proxy-Netz mit dem Header-Modus (`Remote-Email`) und dem CSRF-Header aus `GET /api/v1/auth/me` (`csrf`). Ein Cookie ist dafür nicht nötig: Der Header-Modus nutzt die offene Sitzung des Benutzers weiter (eine Sitzung und ein Audit-Eintrag „Anmeldung“ je Gültigkeitsdauer, nicht je Aufruf). Abweisungen kommen als `{ fehler, code }` (z. B. `code: "csrf"`, `"rolle_fehlt"`):

1. **Sitzkosten je Sitztyp:** `PUT /api/v1/sitzkosten` mit `{ "sitz_typ": "premium", "gueltig_ab": "2026-01-01", "preis_monat": 100, "waehrung": "USD", "abrechnung": "jaehrlich" }` (auch als Liste). Preise gelten ab `gueltig_ab`; eine Änderung ist eine neue Zeile.
2. **Sitz je Person:** `PUT /api/v1/personen/<person-id>/sitz` mit `{ "sitz_typ": "premium", "gueltig_ab": "2026-10-01" }` (Person-ID aus `GET /api/v1/personen`). Ein Sitz ab Monatsmitte zählt anteilig nach Tagen.
3. **Kurs:** kommt täglich von der EZB; sofort mit `POST /api/v1/jobs/kurs/ezb` oder `--einmal kurs.ezb`. Ein eigener Kurs (`PUT /api/v1/kurs?monat=2026-10` mit `{ "usd_eur": 0.86 }`, EUR je 1 USD) geht der EZB vor; `DELETE /api/v1/kurs?monat=` gibt den Monat wieder frei.
4. **Einstellungen:** `PUT /api/v1/mandant/einstellungen` (nur geänderte Felder): `sitzkosten_verteilung` (person, gleich, pool), `code_anteil_sitz` (0–1), `schatten_faktor`, `cache_write_annahme`, `auswertungsstufe`, `klarnamen_aktiv`, `zeitzone`, `waehrung`, `ratenlimit_otlp`, `ratenlimit_agent` (siehe „Ratenlimits“). Jede Änderung steht im Audit und im Betriebsrats-Bericht.
5. **Prüfen:** `GET /api/v1/kalkulation?monat=` (live), `GET /api/v1/monatsabschluss?monat=` (eingefroren). Ein Abschluss lässt sich mit `POST /api/v1/jobs/kalkulation/monatsabschluss?monat=&erzwingen=1` neu schreiben (Audit).

**Sitztypen:** `standard`, `premium`, `enterprise`, `max5` (Claude Max 5x) und `max20` (Claude Max 20x). Jeder Mandant hat ab dem Anlegen die Standardpreise `max5` 100 USD und `max20` 200 USD je Monat (monatlich, gültig ab 2025-01-01, Migration 0017); andere Preise als neue Zeile per `PUT /api/v1/sitzkosten`.

**Umstellung (Migration 0017):** Der frühere Platzhalter `max` (200 USD/Monat, monatlich) heißt seit Migration 0017 `max20`; Preis und Sitz bleiben. Ist ein Sitz eigentlich Max 5x, ihn ab dem passenden Tag auf `max5` setzen (`PUT /api/v1/personen/<id>/sitz`).

## Update

1. Backup ziehen (siehe unten). Migrationen laufen nur vorwärts; der Rückweg ist ein Restore.
2. Neuen Stand holen und bauen: `git pull` (bzw. gewünschtes Tag auschecken), `docker compose -f deploy/compose.yml build server`.
3. Nur den Server erneuern: `docker compose -f deploy/compose.yml up -d server`. Der Dienst fehlt dabei wenige Sekunden; Postgres läuft weiter.
4. Warten, bis `docker compose -f deploy/compose.yml ps` wieder `healthy` zeigt. Schlägt der Start fehl, steht der Grund im Log (`docker compose -f deploy/compose.yml logs --tail 50 server`); dann das vorige Image wieder als `seatmeter:latest` taggen und Schritt 3 wiederholen.

## Backup und Wiederherstellung

`backup.sh` sichert die Datenbank mit `pg_dump -Fc` (komprimiert) aus dem laufenden Postgres-Container, prüft den Dump mit `pg_restore -l` und behält 14 Tage. Einstellungen über Umgebung oder eine Datei `backup.env` neben dem Skript (`SEATMETER_BACKUP_DIR`, `SEATMETER_DB_CONTAINER`, `SEATMETER_BACKUP_TAGE`, `SEATMETER_BACKUP_HOOK`). Der Hook ist ein ausführbares Skript, das mit `ok` bzw. `fail <Text>` aufgerufen wird, etwa für einen Heartbeat an das Monitoring.

```sh
# cron, nachts
20 4 * * * root SEATMETER_BACKUP_DIR=/var/backups/seatmeter /opt/seatmeter/deploy/backup.sh
```

Wiederherstellen (ersetzt den Datenbankinhalt):

```sh
docker compose -f deploy/compose.yml stop server
docker exec -i seatmeter-postgres-1 pg_restore -U seatmeter -d seatmeter --clean --if-exists --no-owner \
  < /var/backups/seatmeter/seatmeter-JJJJ-MM-TT.dump
docker compose -f deploy/compose.yml start server
```

Dazu gehört derselbe `SEATMETER_MASTER_KEY` wie beim Backup. Die Wiederherstellung einmal in einer Wegwerf-Umgebung üben.

In ein **frisches** Postgres (neues Volume, Wegwerf-Container) zuerst die App-Rolle anlegen, denn Rollen gelten clusterweit und stehen nicht im Dump; sonst bricht `pg_restore` bei den `GRANT … TO seatmeter_app` ab: `docker exec <postgres> psql -U seatmeter -d seatmeter -c "CREATE ROLE seatmeter_app NOLOGIN NOBYPASSRLS"`. Im Pilot so geprüft (2026-10-22): Dump in einen Container ohne Netz eingespielt, Zeilenzahlen aller Kerntabellen gleich dem Live-Stand.

## Lizenz und ee-Image

Das Standard-Image (`docker build .`, Ziel `runtime`) enthält nur den Kern (Apache-2.0, `LICENSE` und `NOTICE` liegen unter `/app`). Bezahlte Erweiterungen aus `ee/` sind nicht enthalten.

Das ee-Image baut das Ziel `runtime-ee`: `docker build --target runtime-ee -t seatmeter-ee:latest --build-arg GIT_SHA=$(git rev-parse --short HEAD) .`

- Server: `/app/ee` ist der Prod-Stand von `@seatmeter/ee-server` samt `@seatmeter/server` (eine Kopie für Kern und Plugin); `/app/server` zeigt per Link darauf, Start und Einmal-Jobs (`node /app/server/dist/main.js --einmal <job>`) also wie im Kern-Image; `SEATMETER_PLUGINS=@seatmeter/ee-server` ist im Image gesetzt.
- Dashboard: gebaut mit `SEATMETER_WEB_PLUGINS=@seatmeter/ee-web` (Vite lädt die ee-Seiten über das virtuelle Modul `virtual:seatmeter-web-plugins`, `packages/web/web-plugins.ts`) und `VITE_SEATMETER_EE=1`.
- Lizenz: `ee/LICENSE` liegt als `/app/ee/LICENSE` im Image; die ee-Routen prüfen den Lizenzschlüssel (Modul `lizenz`, ee).

### Lizenzdatei, OIDC und Plattform-Admin (ee)

- **Lizenz:** weeberwrk stellt die Datei aus (`ee/server/README.md`, „Ausstellen“). Auf dem Host als `lizenz.json` (600) neben `compose.yml` ablegen, im Dienst `server` read-only mounten (`./lizenz.json:/run/seatmeter/lizenz.json:ro`) und `SEATMETER_LIZENZ_DATEI=/run/seatmeter/lizenz.json` setzen. Austausch ohne Neustart: Datei ersetzen (gleicher Pfad), der Server prüft alle 10 Minuten. Kontrolle: `GET /api/v1/ee/lizenz` (Admin) bzw. `ee` in `/api/v1/auth/me`.
- **OIDC:** Client beim Provider anlegen (Redirect `<SEATMETER_PUBLIC_URL>/api/v1/auth/oidc/callback`, Scopes `openid profile email groups`, PKCE S256, `client_secret_basic`, Gruppen möglichst im ID-Token), dann die `SEATMETER_OIDC_*`-Variablen setzen. Die Anmeldeseite zeigt danach „Mit <Bezeichnung> anmelden“.
- **Plattform-Admin:** über die Gruppen-Zuordnung (`{"plattform_admin":true}`) oder ohne Dashboard mit `docker exec <server> node /app/ee/dist/cli-plattform-admin.js --benutzer <anmeldename>`. Plattform-Admins legen Mandanten an (Dashboard „Mandanten“) und sehen jeden Mandanten nur aggregiert.

### Budgets, Alarmkanäle und Abgleich (ee)

- **Alarmkanal** (Dashboard „Budgets und Alarme“ oder `POST /api/v1/ee/alarmkanal`): `webhook` (JSON-POST, optional Bearer-Token), `smtp` (Host, Port, TLS, Absender, Empfänger; Passwort als Geheimnis) oder `weeberwrk-relay` (URL des Alarm-Relays, Pfad `/dm` oder `/alert`, Relay-Token als Geheimnis). Geheimnisse werden nur verschlüsselt gespeichert und nie angezeigt. „Testen“ schickt eine Testnachricht (Relay `/dm`: nur Prüfung, keine Nachricht).
- **Budget:** je Projekt oder mandantenweit, Betrag in EUR/USD (Projektpreis) oder Tokens, Schwellen Standard 50/80/100 %. Sofort prüfen: `node /app/server/dist/main.js --einmal budgets.pruefen`. Jede Schwelle meldet sich je Monat genau einmal; Quittieren beendet nur die Anzeige (keine Entwarnung).
- **Analytics-Key** (nur Claude Enterprise; Primary Owner legt in claude.ai einen Key mit Scope `read:analytics` an): `PUT /api/v1/ee/abgleich/analytics-key` mit `{ "key": "…" }`; sofort abgleichen mit `POST /api/v1/ee/abgleich/lauf?von=JJJJ-MM-TT&bis=JJJJ-MM-TT` oder `--einmal abgleich.analytics`.
- **Team-CSV:** Spend-Report aus den Org-Analytics hochladen (Seite „Abgleich“): erst Vorschau (`POST /api/v1/ee/abgleich/csv/vorschau`), Spalten bei Bedarf zuordnen, dann Import (`POST /api/v1/ee/abgleich/csv`, auch `Content-Type: text/csv`).
- Ohne Abgleich zieht die Kalkulation keine Überschreitung ab („Überschreitung nicht abgezogen“).

## Open-Source-Export

Öffentlich (GitHub) ist nicht dieses Repository, sondern ein erzeugter Export von `main`: der Kern (Apache-2.0) ohne `ee/`, ohne die Dateien für Agenten und Projekt-Memory und ohne interne Doku (Betrieb bei weeberwrk, Pilot, Kundentest). Entwickelt wird weiter hier; der Export entsteht bei jedem Push nach `main` von selbst. Die Werkzeuge und Listen dazu gehören selbst nicht zum Export.

| Datei | Zweck |
|---|---|
| `scripts/oss-export.sh <ziel>` | Export aus dem versionierten Baum (`git archive`, Standard `HEAD`, sonst `--ref <commit>`), nie aus dem Arbeitsordner. Entfernt die Pfade aus `deploy/oss/ausschluss.txt`, nimmt die ee-Verweise aus `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `package.json` und `Dockerfile` (ohne die Stufen `build-ee` und `runtime-ee`), setzt `.github/workflows/check.yml` ein und erzeugt `pnpm-lock.yaml` im Export neu (`pnpm install --lockfile-only`). Gleicher Commit = gleicher Export; ein früherer Export im Ziel wird ersetzt (ein `.git` darin bleibt) |
| `scripts/oss-pruefen.sh <ziel>` | 1. Inhalt: keine ausgeschlossenen Pfade, keine Muster aus `deploy/oss/verboten.txt`, kein Verweis auf ausgeschlossene Doku, keine ee-Reste in den Bau-Dateien. 2. In einer Kopie: `pnpm install --frozen-lockfile`, lint, format:check, typecheck, test (Postgres 18), build. 3. `docker build --target runtime` |
| `scripts/oss-snapshot.sh <ziel>` | nur CI: Snapshot-Commit „Export von main <sha>“ auf den Branch `oss` (eigene lineare Historie, Elter = voriger Snapshot; unveränderter Baum = kein neuer Commit), danach optional `main` auf GitHub |
| `deploy/oss/ausschluss.txt` | entfernte Pfade: `ee`, `CLAUDE.md`, `AGENTS.md`, `.beads`, `.claude`, `.agents`, `.codex`, `.cursor`, `.amp*`, `.forgejo`, die Export-Werkzeuge und die interne Doku |
| `deploy/oss/verboten.txt` | Muster (ERE, Groß-/Kleinschreibung zählt), die im Export nicht vorkommen dürfen: interne Hosts, Stacks und Pfade, Issue-IDs und bd-Befehle, Geheimnisse mit Wert |
| `deploy/oss/github-check.yml` | Workflow des öffentlichen Repos: lint, format:check, typecheck, test mit Postgres 18, build und Kern-Image auf Pull Request und Push nach `main` |
| `.forgejo/workflows/oss-export.yml` | Lauf auf Push nach `main` und von Hand: Export, Prüfung (ohne `docker build`, im Job-Container gibt es kein Docker), Snapshot. Von Hand auf einem anderen Branch gestartet, nur Export und Prüfung |

Lokal (Werkzeuge im Dev-Container, Compose-Projekt `sm-oss`, am Ende `down -v`; Podman ohne BuildKit):

```sh
sh scripts/oss-export.sh --pruefen /tmp/seatmeter-oss       # Export und vollständige Prüfung samt Image
sh scripts/oss-pruefen.sh --ohne-docker /tmp/seatmeter-oss  # nur erneut prüfen, ohne Image
```

Schon der Pull-Request-Check `check` prüft die Muster (Export `--ohne-install`, Prüfung `--nur-muster`, wenige Sekunden). Interne Angaben (Hosts, Stack-Pfade, Issue-IDs, Schlüsselbund-Namen, Pilot-Details) gehören deshalb nur in ausgeschlossene Dateien; neue interne Doku in die Liste `deploy/oss/ausschluss.txt` eintragen.

Secrets und Variablen (Repo-Einstellungen → Actions):

| Name | Art | Zweck |
|---|---|---|
| `OSS_PUSH_TOKEN` | Secret, optional | Token mit Schreibrecht auf dieses Repo für den Branch `oss`. Nur nötig, wenn Forgejo den Push mit dem Actions-Token ablehnt; der Lauf meldet das als Warnung und überspringt den Schritt |
| `OSS_GITHUB_TOKEN` | Secret | GitHub-Token (fine-grained, nur das Ziel-Repo, Rechte Contents und Workflows: Lesen und Schreiben; Workflows, weil der Export `.github/workflows/check.yml` enthält) |
| `OSS_GITHUB_REPO` | Variable | Ziel auf GitHub in der Form `owner/seatmeter` |

Fehlt `OSS_GITHUB_TOKEN` oder `OSS_GITHUB_REPO`, endet der Lauf nach dem Branch `oss` mit einem Hinweis. Der Push nach GitHub setzt dort `main` auf den Snapshot (`--force-with-lease` auf den eben gelesenen Stand): Auf GitHub wird nichts direkt gemergt. Beiträge von GitHub übernimmt weeberwrk hier als eigenen Pull Request (`CONTRIBUTING.md`); sie kommen mit dem nächsten Export zurück. Das ee-Image (`--target runtime-ee`) lässt sich nur hier bauen, nicht im Export.
