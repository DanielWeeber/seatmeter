# Modul `hinweise`

Projekt-Hinweise je Monat und Regeln je Mandant. Bis 2026-10-24 ein ee-Modul (Lizenzmodul `budgets`), seitdem Kern ohne Lizenzprüfung (Entscheidung vom 2026-10-23); Routen ohne `/ee/`. Job `hinweise.erzeugen` (täglich 04:30 UTC). Dateien: `regeln.ts` (reine Funktion), `job.ts` (Monatssummen aus `tag_aggregat`, Upsert in `hinweis`), `routen.ts`.

| Route | Wer | Inhalt |
|---|---|---|
| `GET /api/v1/hinweise?monat=` | Admin, Controller, Projektleiter (eigene Projekte) | `{ monat, hinweise, regeln }` |
| `POST /api/v1/hinweise/:id/erledigt` | Admin, Projektleiter | erledigt bleibt erledigt, auch nach neuen Läufen |
| `PUT /api/v1/hinweise/regeln` | Admin | nur gesendete Schwellen ändern sich (`cache_write_prozent` 60, `fast_prozent` 20, `opus_prozent` 80, `unzugeordnet_prozent` 5, `mindest_usd` 5) |
| `POST /api/v1/jobs/hinweise/erzeugen?monat=` | Admin | Neuberechnung für den eigenen Mandanten |

Regeln (Anteile am Schattenpreis des Projekts im Monat, erst ab `mindest_usd`): Cache-Schreibkosten (Schatten nur der `cache_write`-Tokens, Näherung ohne Langkontext) „Prompt-Caching prüfen“; Fast Mode; Opus („Sonnet würde reichen“); mandantenweit: „unzugeordnet“ („Sitzungen ohne Git-Remote“), Topf „ungenutzt“ (Sitze ohne Nutzung), Modell ohne Preis (je Projekt), Prognose über Budget. Tabelle `hinweis` (Migration 0022, bis 2026-10-24 ee-Migration 0002; Schwellen in `ee_einstellung`, Name aus der ee-Zeit), ein Hinweis je (Monat, Projekt, Typ); offene Hinweise, deren Regel nicht mehr greift, löscht der Job. Datenqualitäts-Hinweise stehen im Modul `aggregation`.
