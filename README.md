# seatmeter

seatmeter zeigt Firmen mit Claude-Team- oder Claude-Enterprise-Sitzen, wie viele Tokens jede Person und jedes Projekt (= Repository = Kunde) aus dem Abo-Kontingent verbraucht. Gemessen wird die Nutzung von Claude Code im Abo, nicht API-Verkehr. Daraus rechnet seatmeter einen Preis je Projekt und zeigt Budgets je Projekt. Personen erscheinen standardmäßig nur pseudonym.

## Funktionen

- **Verbrauch je Person und Projekt:** Tokens (Eingabe, Ausgabe, Cache) je Anfrage, Modell, Tag, Repository und Person, zusammengeführt aus zwei Quellen ohne Doppelzählung.
- **Schattenpreis:** was die Nutzung zu API-Listenpreisen gekostet hätte, plus ein Anteil an den Sitzkosten (Verteilung nach Nutzung, gleich oder als Pool; ungenutzte Sitze als eigener Topf). Preise mit Gültigkeit, Umrechnung in EUR mit dem EZB-Kurs, Monatsabschluss, Projektabrechnung als CSV.
- **Budgets:** je Projekt oder für den ganzen Mandanten, in Geld oder Tokens, mit Prognose und Alarmen (Webhook, SMTP).
- **Datenschutz:** Personen pseudonym (HMAC mit Mandantensalt), Klarnamen nur per Opt-in, Auswertungsstufen und Mindestgruppen, keine Inhalte (Prompts, Antworten, Dateinamen, Befehle), Aufbewahrungsfristen mit Löschnachweis, Audit jedes Personenzugriffs, Bericht für den Betriebsrat.
- **Anmeldung und Konten:** lokaler Login, vorgeschaltete Anmeldung per Proxy-Header, SSO per OIDC, Benutzer und Gruppen per SCIM 2.0 (Entra ID, Okta).
- **Jira:** Kosten je Jira-Projekt und Issue über den Issue-Schlüssel im Branch-Namen.
- **Projektkatalog:** Projektliste aus dem Projektmanagement-Werkzeug, Repos zuordnen, Kosten je Projekt, Projektwahl auf Wunsch erzwungen.
- **Abgleich:** Enterprise Analytics API bzw. Team-Spend-Report (CSV), damit Überschreitungen des Kontingents nicht doppelt zählen.

## Aufbau

```
Claude Code ──OTel (Quelle A)──┐
                               ├──▶ seatmeter-Server (Fastify, Postgres 18 mit Row-Level-Security) ──▶ Dashboard (React)
seatmeter-agent ─(Quelle B)────┘
```

- **Quelle A:** Claude Code exportiert je API-Anfrage Zähler und Metadaten per OpenTelemetry (OTLP über HTTP) an den Server.
- **Quelle B:** Der lokale Agent `seatmeter-agent` liest nur die Zählerfelder der Claude-Code-Transkripte (Hooks und/oder Sweeper) und schickt sie nach; er fängt verlorene Exporte auf und ordnet jede Anfrage einem Projekt zu.
- **Server:** ein Container mit API, Ingest und Dashboard, Jobs (Tagesaggregat, Kurs, Monatsabschluss, Aufbewahrung) und Migrationen beim Start.

TypeScript (Node 24 LTS, React 19, Postgres 18), Monorepo mit pnpm workspaces:

| Ordner | Paket | Inhalt |
|---|---|---|
| `packages/shared` | `@seatmeter/shared` | zod-Schemas, Repo-URL-Normalisierung, HMAC/Pseudonyme, Preistabelle, Schattenpreis, Projektpreis |
| `packages/server` | `@seatmeter/server` | Fastify 5, Kysely mit Migrationen, Row-Level-Security (`withMandant`), Plugin-Schnittstelle `SeatmeterPlugin`; ein Modulordner mit Vertrag (`README.md`) je Fachbereich |
| `packages/web` | `@seatmeter/web` | Dashboard: Vite, React 19, Tailwind 4, TanStack Query |
| `packages/agent` | `@seatmeter/agent` | CLI `seatmeter-agent` (Quelle B), Doku `packages/agent/README.md` |
| `deploy/` | – | Betrieb mit Docker Compose, Backup-Skript, Installskript für den Agenten, Entwicklungsumgebung |
| `docs/` | – | Architektur, Ausrollen, SSO und SCIM, Jira, Projektkatalog, Vorlage für den Betriebsrat |

## Schnellstart mit Docker Compose

Voraussetzungen: Docker mit Compose und ein Reverse-Proxy mit TLS davor (Beispiel mit Caddy in `deploy/README.md`). Im geklonten Repository:

```sh
docker network create proxy                                # Netz, über das der Proxy den Server erreicht
cp deploy/env.example deploy/.env && chmod 600 deploy/.env
# in deploy/.env setzen: POSTGRES_PASSWORD (openssl rand -hex 24), SEATMETER_MASTER_KEY (openssl rand -base64 32),
# SEATMETER_PUBLIC_URL (z. B. https://seatmeter.example.com)
docker compose -f deploy/compose.yml up -d --build
docker compose -f deploy/compose.yml logs server | grep -i einrichtung   # Einrichtungs-Token für den ersten Admin
```

Danach im Dashboard die Seite „Einrichtung“ öffnen, mit dem Token den ersten Admin anlegen und unter „Ausrollen“ die Schnipsel für Claude Code (Managed Settings bzw. Server-Managed Settings) und den Agenten abholen. Den Master-Schlüssel getrennt vom Server sichern: Ohne ihn lassen sich die Pseudonyme nicht fortführen. Alles Weitere (Umgebungsvariablen, Proxy-Pfade, Ratenlimits, Jobs, Update, Backup): [deploy/README.md](deploy/README.md).

## Agent installieren

Mit einem Einmalcode aus dem Dashboard (Seite „Ausrollen“ oder „Rechner/Agenten“), `<release-url>` ist der Download-Ordner eines Releases:

```sh
curl -fsSL <release-url>/agent-install.sh | SEATMETER_RELEASE_URL=<release-url> sh
~/.seatmeter/bin/seatmeter-agent enroll <einmalcode> --server https://<ingest-host> && ~/.seatmeter/bin/seatmeter-agent install
```

Betriebsarten, Pfad-Filter und Prüfung: [packages/agent/README.md](packages/agent/README.md) und [docs/Ausrollen.md](docs/Ausrollen.md).

## Entwicklung

Alle Werkzeuge laufen im Container `dev` (`node:24-bookworm-slim`, pnpm über corepack); Node und pnpm werden nicht auf dem Rechner installiert. Postgres 18 startet für die Tests mit.

```sh
alias sm='docker compose -f deploy/compose.dev.yml run --rm dev'

sm pnpm install          # Abhängigkeiten
sm pnpm lint             # ESLint
sm pnpm format:check     # Prettier (pnpm format schreibt)
sm pnpm typecheck        # tsc über alle Pakete
sm pnpm test             # Vitest; Server-Tests gegen Postgres im Compose-Netz
sm pnpm build            # tsc, Vite-Build, Agent-Bündel

# Server und Dashboard im Container starten (Ports 8080 und 5173 auf 127.0.0.1)
docker compose -f deploy/compose.dev.yml run --rm --service-ports dev \
  sh -c 'pnpm build && (node packages/server/dist/main.js & pnpm --filter @seatmeter/web dev)'

docker compose -f deploy/compose.dev.yml down   # aufräumen (mit -v auch Datenbank und pnpm-Store)
```

Die Server-Tests legen in der Datenbank aus `DATABASE_URL` eine frische Testdatenbank an und prüfen unter anderem Migrationen, Row-Level-Security (Mandant A sieht nichts von B), die Kalkulation per Golden-Test und dass Pushes keine Inhaltsfelder annehmen. Die CI führt auf jedem Pull Request lint, format:check, typecheck, test und build aus und baut das Image.

## Dokumentation

- [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md): Architektur, Datenmodell, Kalkulation, Datenschutz
- [deploy/README.md](deploy/README.md): Betrieb, Reverse-Proxy, Monitoring, Ratenlimits, Backup
- [docs/Ausrollen.md](docs/Ausrollen.md): Ausrollen bei Claude Team und Claude Enterprise
- [docs/SSO-und-SCIM.md](docs/SSO-und-SCIM.md): Anmeldung per OIDC, Konten per SCIM
- [docs/Jira.md](docs/Jira.md): Kosten je Jira-Projekt und Issue
- [docs/Projektkatalog.md](docs/Projektkatalog.md): Repos und Sitzungen Projekten zuordnen, Projektwahl erzwingen
- [docs/Betriebsrat-Vorlage.md](docs/Betriebsrat-Vorlage.md): Vorlage für Information und Zustimmung des Betriebsrats

## Lizenz

Open Core:

- Der Kern (alles in diesem Repository) steht unter der Apache License 2.0, siehe [LICENSE](LICENSE) und [NOTICE](NOTICE).
- Die Mandantenfähigkeit für Betreiber, die seatmeter für mehrere Kunden hosten oder weiterverkaufen, liegt im Ordner `ee/` unter der weeberwrk Enterprise-Lizenz (Quellcode einsehbar, produktive Nutzung nur mit Lizenzschlüssel von weeberwrk). `ee/` ist nicht Teil dieses öffentlichen Repositorys; der Kern läuft ohne ihn vollständig für eine Organisation.

## Mitwirken

Dieses GitHub-Repository ist ein automatisch erzeugter Export: Entwickelt wird im Forgejo von weeberwrk, jeder Stand von `main` dort erscheint hier als Snapshot-Commit. Issues und Pull Requests sind hier willkommen; angenommene Änderungen übernimmt weeberwrk in das Quell-Repository, mit dem nächsten Export kommen sie zurück. Ablauf und Regeln: [CONTRIBUTING.md](CONTRIBUTING.md).

## Inspiration

Das Design orientiert sich an [Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor). Genutzt wird nur das Konzept; der Code von seatmeter ist neu geschrieben.

---

Copyright 2026 Daniel Weeber (weeberwrk)
