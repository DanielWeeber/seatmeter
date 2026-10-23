# Modul `budgets`

Budgets je Projekt oder mandantenweit, Alarme je Schwelle genau einmal, Alarmkanäle. Bis 2026-10-24 ein ee-Modul (Lizenzmodul `budgets`), seitdem Kern ohne Lizenzprüfung (Entscheidung vom 2026-10-23); Routen ohne `/ee/`. Job `budgets.pruefen` (stündlich, Minute 7). Tabellen `budget`, `alarm` (Grundschema, Migration 0014) und `alarm_kanal` (Migration 0022). Dateien: `prognose.ts` (Arbeitstage, Hochrechnung), `stand.ts` (Verbrauch aus `kalkuliereMonat`), `pruefen.ts` (Alarme anlegen und zustellen), `kanal.ts` (Webhook, SMTP, weeberwrk-Relay, Verschlüsselung), `routen.ts`.

| Route | Wer | Inhalt |
|---|---|---|
| `GET /api/v1/budgets?monat=` | Admin, Controller, Projektleiter (eigene Projekte) | Budgets mit Stand: Verbrauch bis heute, Prognose zum Monatsende, Prozent, Arbeitstage |
| `POST /api/v1/budgets`, `PUT …/:id`, `DELETE …/:id` | Admin; Projektleiter nur eigene Projekte (nicht mandantenweit) | `{ projekt_id (null = mandantenweit), bezeichnung?, betrag, waehrung EUR/USD, basis projektpreis/tokens, schwellen [50,80,100], ausloeser verbrauch/prognose, aktiv }` |
| `GET /api/v1/alarme?monat=&offen=1` | wie Budgets | Alarme mit Zustellstatus (`offen`, `zugestellt`, `fehler`, `ohne_kanal`) |
| `POST /api/v1/alarme/:id/quittieren` | Admin, Projektleiter | quittiert (keine Entwarnung, kein erneuter Alarm) |
| `GET/POST /api/v1/alarmkanal`, `PUT/DELETE …/:id`, `POST …/:id/test` | Admin | Kanäle `webhook` (`{url}`, Geheimnis = Bearer-Token), `smtp` (`{host, port, secure, benutzer?, von, an[]}`, Geheimnis = Passwort), `weeberwrk-relay` (`{url, pfad /dm oder /alert, prio, bot?}`, Geheimnis = Relay-Token) |
| `POST /api/v1/jobs/budgets/pruefen` | Admin | Lauf für den eigenen Mandanten |

- **Verbrauch** aus der Live-Kalkulation des Kerns (`kalkuliereMonat`): Projektpreis in EUR bzw. USD (mandantenweit: Summe aller Töpfe) oder Tokens. EUR ohne Kurs = nicht berechenbar (kein Alarm, Hinweis im Stand).
- **Prognose** = Verbrauch / Arbeitstage bis heute · Arbeitstage im Monat (Mo–Fr, Mandanten-Zeitzone); ohne Arbeitstag bis heute über Kalendertage; abgeschlossene Monate = Verbrauch.
- **Alarm** je (Budget, Monat, Schwelle) genau einmal (`UNIQUE` + `ON CONFLICT DO NOTHING`), gemessen am Verbrauch oder (Auslöser `prognose`) an der Prognose. Zustellung an alle aktiven Kanäle; Fehlschläge bis zu 5-mal in späteren Läufen, Fehlertexte ohne Geheimnisse; ohne Kanal bleibt der Alarm `ohne_kanal` (keine nachträgliche Flut).
- **Geheimnisse** nur AES-256-GCM-verschlüsselt (`alarm_kanal.geheimnis`, AAD `alarm_kanal.geheimnis`); Antworten zeigen nur `geheimnis_gesetzt`. `PUT` ohne `geheimnis` behält es, `null` löscht es.
- **Relay-Vorlage:** `/dm` sendet `{ text, prio, bot? }` (Markdown: Kopfzeile als Link, Stichpunkte); der Test schickt `test: true` (das Relay sendet dann nichts). `/alert` sendet einen Vorfall mit Schlüssel `seatmeter|budget|<id>|<monat>|<schwelle>`, Topic `seatmeter`, `ttl_aktion: expire`. Header `X-Relay-Token`.
- Audit: Budget angelegt/geändert/gelöscht, Alarm quittiert, Alarmkanal angelegt/geändert/gelöscht/getestet.
