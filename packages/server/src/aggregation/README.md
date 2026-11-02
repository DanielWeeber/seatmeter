# Modul `aggregation`

Tagesaggregat und Dashboard-Lesezugriffe (Architektur §2.3, §2.4, §3.1, §5, §7).

## Jobs

| Job | Zeitplan (UTC) | Inhalt |
|---|---|---|
| `aggregation.tag` | `15 2 * * *` | je Mandant heute und die 34 Tage davor (Mandanten-Zeitzone) neu aufbauen |
| `aggregation.nah` | alle `SEATMETER_AGGREGATION_INTERVALL_MIN` Minuten (Standard 5, 0 = aus, höchstens 60), eine Minute nach `merge.ab` | je Mandant heute und gestern, siehe unten |
| `partitionen.anlegen` | `5 0 * * *` | `anfragePartitionenAnlegen` (laufender und nächster Monat) |

`aggregiereTage(db, mandantId, von, bis)`: je Tag eine Transaktion, Zeilen des Tages löschen und aus `anfrage` (nur `zaehlt_als_abo`) neu schreiben, gruppiert nach (tag, person, projekt, model, speed, auth_klasse). `speed` NULL → `normal`; „kein Fast-Modus“ heißt immer `normal` (Quelle A meldet `normal`, die Transkripte von B `standard`, das `agentAnfrageSchema` in shared bildet `standard` beim Ingest auf `normal` ab; Altzeilen gleicht Migration 0016 an).
Schattenpreis je Anfrage mit `schattenpreis` aus `@seatmeter/shared` (Preis nach `ts` der Anfrage, effektive Preistabelle des Mandanten, `cache_write_annahme`), dann summiert. `cache_write_1h` = 1h-Anteil wie im Schattenpreis (bekannt aus Quelle B, sonst nach Annahme). `preis_version` = `global|mandant:<präfix>@<gueltig_ab>` (mehrere kommagetrennt), NULL ohne passenden Preis (Datenqualität „Modelle ohne Preis“). `abo_anteil` = 1 (Abzug der Überschreitung: ee, Phase 4).

`aggregation.nah` (`nah.ts`) rechnet mit derselben Funktion `tagBerechnen`, also genau wie nachts; ein Test vergleicht jede Zeile und Spalte. Unterschiede: Ein Tag wird nur gerechnet, wenn sich eine Signatur über alle Eingaben geändert hat (Felder der Anfragen, Preise, `cache_write_annahme`; auch ohne neue Anfrage, `merge.ab` ändert Zeilen). Geschrieben werden nur geänderte Zeilen, in einer Transaktion je Mandant, also nie ein halber Stand. Die Signaturen liegen im Speicher des Prozesses, darum keine Migration; nach einem Neustart rechnet der erste Lauf einmal und schreibt nichts, wenn nichts anders ist. `issue_aggregat` liest den ganzen Monat und läuft darum höchstens stündlich: So lange kann „ohne Issue-Schlüssel“ auf der Issue-Seite tagsüber zu hoch stehen.

Sperren: `pg_advisory_xact_lock` je Mandant (`sperre.ts`) hält der nächtliche Lauf je Tag, der Neuaufbau auf Anforderung und `schliesseMonat`; `aggregation.nah` versucht sie nur und überspringt den Mandanten. Läuft `aggregation.tag` oder `kalkulation.monatsabschluss` (nachgesehen in `pg_locks`, nie selbst gesperrt, das könnte den nächtlichen Lauf verdrängen), setzt der Lauf ganz aus. Überspringen schreibt keine Zeile in `job_lauf`. Scheitert ein Mandant, laufen die anderen weiter, und der Lauf endet mit Fehler. Erfolgreiche Läufe bleiben eine Woche in `job_lauf`.

Abgeschlossene Monate bleiben unberührt: `monatsabschluss` und `katalog_abschluss` sind eigene Stände, das Tagesaggregat ihrer Tage folgt wie nachts. Budgets rechnen auf frischeren Daten: Ein Alarm kommt am selben Tag statt am nächsten Morgen, je Schwelle weiter genau einmal.

## Routen (alle mit Dashboard-Sitzung, Mandant aus der Sitzung, RLS über `withMandant`)

| Route | Rollen | Inhalt |
|---|---|---|
| `POST /api/v1/jobs/aggregation/tag?von=&bis=` | mandanten_admin | Neuaufbau für den eigenen Mandanten (Standard 35 Tage, höchstens 400; nie vor der Anfrage-Aufbewahrung), CSRF, `job_lauf` mit `ausloeser=api`, Audit |
| `GET /api/v1/uebersicht?monat=JJJJ-MM` | alle | Tokens je Typ, Anfragen, Schatten, je Modell, Abdeckung A/B, gefilterte API-/Fremd-Org-Anfragen und verworfene Inhaltsereignisse (`ingest_statistik`) |
| `GET /api/v1/projekte?monat=` | alle | `ProjekteAntwort` (`projekteAntwortSchema`): Liste mit Kennzahlen und Personenzahl; „unzugeordnet“ mit `id: null` |
| `GET /api/v1/projekte/:id?monat=` | alle | `:id` = UUID oder `unzugeordnet`; je Modell, je Tag, Personen gemäß Stufe; Rollen ohne Personensicht bekommen `personen: null` + `personen_hinweis: "Rolle ohne Personensicht"` |
| `GET /api/v1/personen?monat=` | mandanten_admin, projektleiter | Pseudonyme mit Monatssummen; Klarnamen nur bei `klarnamen_aktiv` und `person_klar`; andere Rollen 403 `{ code: "rolle_fehlt", fehler: "Rolle ohne Personensicht" }` |
| `GET /api/v1/datenqualitaet?monat=` | alle | Abdeckung A/B, heuristisch, Abweichung A≠B, unzugeordnet, Modelle ohne Preis, `ingest_statistik` je Quelle, OTel-Kontrollsumme je Sitzung (Abweichung > 1 %) |

Antworttypen: `@seatmeter/shared` (`Uebersicht`, `ProjekteAntwort`/`ProjektZeile`, `ProjektDetail`, `PersonenAntwort`, `Datenqualitaet`).

Rechte-Linie (wie im Modul `auth`): ganze Ressource gesperrt → 403 `rolle_fehlt`; Felder einer erlaubten Ressource gesperrt → `null` mit Hinweisfeld.

Projektleiter (nur `projekt_ids`): Übersicht, Projekte, Personen und Datenqualität zählen nur ihre Projekte. In der Datenqualität gilt das auch für „Modelle ohne Preis“ und die Kontrollsumme (nur Sitzungen, deren Anfragen im Monat alle in sichtbaren Projekten liegen, weil die Kontrollsumme kein Projekt kennt). Die Ingest-Zähler (`ingest_statistik`, Übersicht `gefiltert`, Datenqualität `ingest`) haben keine Projektdimension und bleiben mandantenweit. Beträge in Mikro-USD, `monat` ohne Angabe = laufender Monat in der Mandanten-Zeitzone.

Auswertungsstufe (§7): 0 = keine Personen; 1 = Pseudonyme nur als Monatssummen und nur ab 3 Personen je Ausweis (sonst `personen: null`, `personen_hinweis: "zu wenige Personen"`); 2 = zusätzlich `nach_tag` je Person; Klarnamen über `klarnamen_aktiv`. Controller und Betriebsrat sehen keine Personen (`"Rolle ohne Personensicht"`), Projektleiter nur ihre `projekt_ids`.
Jede ausgelieferte Personensicht schreibt `audit` („Personensicht geöffnet“).
