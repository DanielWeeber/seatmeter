# Modul `kalkulation`

Projektpreise je Monat (Architektur §5), Monatsabschluss und Wechselkurs. Rechenkern `berechneProjektpreise` aus `@seatmeter/shared` (Varianten `person`, `gleich`, `pool`; Golden-Tests in `packages/shared/src/preise/golden.test.ts` und `packages/server/test/kalkulation.test.ts`). Antworttypen und zod-Schemas: `@seatmeter/shared` (`KalkulationAntwort`, `Monatsabschluss`, `Kurs`, `KurseAntwort`).

## Rechnung (`rechnen.ts`, `kalkuliereMonat`)

- **Schatten** je Person/Projekt/Tag aus `tag_aggregat.schatten_usd_micros` (Preis zum Anfragetag, Aggregation); Monat = Kalendertage in der Mandanten-Zeitzone. `abo_anteil` wird nicht angewandt (bleibt 1,0 im Kern); den Abzug der Überschreitung rechnet die Kalkulation selbst.
- **Sitzkosten** K_p = Preis des Sitztyps (`sitzkosten`, jüngstes `gueltig_ab` vor Monatsende) × `code_anteil_sitz`, anteilig nach Tagen, an denen der Sitz (`person_sitz`) im Monat gilt. Sitzkosten in EUR werden mit dem Monatskurs in USD umgerechnet; andere Währungen bleiben mit Hinweis außen vor.
- **Verteilung** laut `mandant.sitzkosten_verteilung`: `person` = nach Schattenanteil je Person (Personen ohne Nutzung → Topf „ungenutzt“), `gleich` = gleichmäßig auf die Projekte, die die Person im Monat genutzt hat (ohne Projekte → „ungenutzt“), `pool` = alle Sitzkosten (auch ungenutzte, Formel §5) nach dem Schattenanteil der Projekte („ungenutzt“ nur ohne jeden Schatten). Der Topf „unzugeordnet“ zählt wie ein Projekt.
- **Überschreitung** aus der Tabelle `ueberschreitung` (Quelle C, ee). Gibt es für den Monat keine Zeile, wird nichts abgezogen und `ueberschreitung_abgezogen = false` (Hinweis „Überschreitung nicht abgezogen“).
- **Projektpreis** = `schatten_faktor` · Schatten + Sitzanteil + Überschreitung; Rundung erst auf US-Cent, dann × Kurs auf EUR-Cent. Ohne Kurs sind die EUR-Werte `null`.
- **Sicht:** Die Rechnung läuft immer über alle Projekte (Sitzanteile hängen von allen ab); Projektleiter bekommen danach nur ihre Projekte (ohne „unzugeordnet“/„ungenutzt“, `sitzkosten_usd_micros: null`), Summen über die sichtbaren Zeilen.

## Routen (Dashboard-Sitzung, RLS über `withMandant`)

| Route | Rollen | Inhalt |
|---|---|---|
| `GET /api/v1/kalkulation?monat=JJJJ-MM` | mandanten_admin, controller, projektleiter (eigene Projekte) | Live-Kalkulation `KalkulationAntwort`; Betriebsrat 403 |
| `GET /api/v1/monatsabschluss?monat=` | wie oben | `{ monat, abgeschlossen, abschluss }` mit den eingefrorenen Werten |
| `POST /api/v1/jobs/kalkulation/monatsabschluss?monat=&erzwingen=1` | mandanten_admin | Abschluss anlegen (`angelegt`), vorhandenen stehen lassen (`vorhanden`) oder mit `erzwingen=1` neu schreiben (`ueberschrieben`); CSRF, `job_lauf`, Audit |
| `GET /api/v1/kurse` | alle | `{ zeilen: Kurs[] }`, neuester Monat zuerst (höchstens 36) |
| `GET /api/v1/kurs?monat=` | alle | `Kurs` (`usd_eur` = EUR je 1 USD, `quelle` ezb/manuell, `vorlaeufig`) |
| `PUT /api/v1/kurs?monat=` | mandanten_admin | `{ usd_eur }` setzt einen manuellen Kurs (geht EZB vor), Audit „Kurs gesetzt“ |
| `DELETE /api/v1/kurs?monat=` | mandanten_admin | manuellen Kurs entfernen (der nächste EZB-Abruf füllt den Monat), Audit „Kurs gelöscht“ |
| `POST /api/v1/jobs/kurs/ezb` | mandanten_admin | EZB-Abruf für den eigenen Mandanten (502 bei Fehler der EZB) |

## Jobs

| Job | Zeitplan (UTC) | Inhalt |
|---|---|---|
| `kurs.ezb` | `0 3 * * *` | EZB Data API, Reihe `EXR` USD/EUR: Monatsmittel `M.USD.EUR.SP00.A` (`lastNObservations=3`, endgültig) und Tageskurse `D.USD.EUR.SP00.A` ab dem Vormonat (Mittel je Monat, `vorlaeufig`, nur wo das Monatsmittel fehlt). Gespeichert wird der Kehrwert auf 6 Stellen für alle Mandanten. Manuelle Kurse bleiben, endgültige Werte werden nie durch vorläufige ersetzt. Täglich statt nur am Monatsersten, damit der laufende Monat aktuell ist und der Abschluss um 03:30 alle Tageskurse des Vormonats hat. |
| `kalkulation.monatsabschluss` | `30 3 1 * *` | je Mandant den Vormonat (Mandanten-Zeitzone) einfrieren; vorhandene Abschlüsse bleiben unverändert |

Einmal von Hand: `node dist/main.js --einmal kurs.ezb` bzw. `--einmal kalkulation.monatsabschluss`.

## Monatsabschluss (`abschluss.ts`)

Je Zeile (Projekt, „unzugeordnet“, „ungenutzt“) in `monatsabschluss`: Schatten, Sitzanteil, Überschreitung, Projektpreis in Mikro-USD und US-Cent, EUR-Cent, Tokens, Anfragen, Kurs mit Quelle und „vorläufig“, Preisversion, Verteilung, `code_anteil_sitz`, `schatten_faktor`, `cache_write_annahme`, `ueberschreitung_abgezogen`, `erzwungen` (Migration `2026_10_22_0012`). Spätere Preis-, Kurs- oder Datenänderungen wirken nur auf die Live-Sicht. Ein leerer Monat ohne Vorgänger schreibt nichts (auch kein Audit). Audit: „Monatsabschluss erstellt“ (Job: ohne Benutzer) bzw. „Monatsabschluss überschrieben“.
