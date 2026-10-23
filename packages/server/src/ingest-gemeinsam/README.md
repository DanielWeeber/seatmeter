# `ingest-gemeinsam` (Hilfsteil der Module ingest-otlp, ingest-agent, enrollment)

Keine eigenen Routen. Gemeinsame Bausteine der drei Ingest-Module; andere Module nutzen davon höchstens
`geheimnis.ts` (Salts entschlüsseln) und `status.ts`.

- `registrieren.ts`: `ingestPlugin` (Eintrag in `kern.ts`) bzw. `ingestModuleRegistrieren(app, ctx)`.
- `zugang.ts`: Tokens (`smi_`/`smr_`, SHA-256, `token_aufloesen`), `onRequest`-Hook (Ratenlimits, dann Token), Erkennung „DB nicht erreichbar“ (503), Fehler-Handler ohne Körperinhalte.
- `ratenlimit.ts`: Ratenlimits aller Ingest-Pfade (eine Instanz je App aus `registrieren.ts`, Token-Buckets im Speicher): je Client-IP, Fehlversuche je IP (danach 429 ohne DB-Abfrage, bekannte gültige Tokens ausgenommen), je Token (OTLP) bzw. je Rechner (Agent) mit der Grenze des Mandanten (`mandant.ratenlimit_otlp|agent`, 60 s zwischengespeichert), Enrollment je IP. 429 mit `Retry-After`, Log nur mit Schlüsselart (höchstens einmal je Minute und Art), Zähler der letzten 24 h für `/api/health/ingest` (prozessweit, ab Serverstart).
- `geheimnis.ts`: Salts aus `mandant_geheimnis` über `krypto.ts` (AES-256-GCM, AAD `mandant_geheimnis.<spalte>`, wie die Einrichtung im Modul `auth`); fehlende Salts werden beim ersten Ingest erzeugt.
- `kontext.ts`: Mandanten-Kontext (Zeitzone, Aufbewahrung, Org-Positivliste, Salts), Tag in Mandanten-Zeitzone, Annahmefenster, Partitionen bei Bedarf (Advisory-Lock), Zuordnung Auth-Klasse → Zähler.
- `speichern.ts`: Person, Projekt, Sitzung, Anfrage (Schlüssel-Upsert mit Fenster ±1 Tag und Advisory-Lock je Schlüssel), `ingest_statistik`, `zuletzt_genutzt`/`zuletzt_gesehen` (höchstens einmal je Minute).
- `status.ts`: Werte für `/api/health/ingest` (`letzte_annahme`, `stille_stunden`, `anfragen_24h`, `heute`, `abgelehnt_429_24h` je Quelle) und `agenten` (`agentenStatusLesen`, Schema `ingestAgentenSchema` in `@seatmeter/shared`): Rechner gesamt und aktiv (48 h), ältester/jüngster Heartbeat aus `rechner.zuletzt_gesehen`, `stille_trotz_heartbeat_stunden` und `luecke_zu_a_stunden` (ganze Stunden, für Monitoring-Bedingungen).
