# Modul `issues`

Kosten je Issue-Schlüssel (Architektur „Phase 5c“). Gespeichert wird nur der Schlüssel
(`ABC-123`, Muster `[A-Z][A-Z0-9]+-[0-9]+`), nie der Branch-Name.

## Daten

- `anfrage.issue_schluessel` (text[]): schreiben die Ingest-Pfade. Quelle B (Agent ab 0.1.3) je
  Transkriptzeile aus `gitBranch`, Quelle A aus dem Ressourcen-Attribut `seatmeter.issue_schluessel`
  (Start-Wrapper, Branch beim Sitzungsstart). Vorrang B vor A wie beim Projekt. `NULL` = unbekannt,
  `{}` = Branch ohne Schlüssel. Vor dem Speichern gefiltert nach `mandant.issue_praefixe`.
- `mandant.issue_praefixe` (text[]): Positivliste der Projektschlüssel; `NULL` = alle. Pflegt ee aus der
  Jira-Zuordnung (Option „nur zugeordnete Jira-Projekte“).
- `issue_aggregat`: je (Monat, Projekt, Schlüssel) Tokens, Anfragen, Sitzungen (verschieden im Monat) und
  Schattenpreis; nur `zaehlt_als_abo`. Eine Anfrage mit n Schlüsseln zählt zu je 1/n (ganzzahlig, Rest an
  die ersten Schlüssel). Aufbewahrung wie der Monatsabschluss.

## Jobs

Kein eigener Job: `aggregiereTage` (Modul `aggregation`, nächtlich und auf Anforderung) ruft danach
`aggregiereIssueMonate` für jeden berührten Monat auf. Ein Monat wird nur neu aufgebaut, wenn seine
Einzelanfragen vollständig vorliegen (Monatsbeginn nicht vor der Anfrage-Aufbewahrung); sonst bleibt sein
Stand eingefroren.

## Routen (Dashboard-Sitzung, RLS über `withMandant`)

| Route | Rollen | Inhalt |
|---|---|---|
| `GET /api/v1/projekte/:id/issues?monat=&format=json\|csv` | alle; Projektleiter nur eigene Projekte (sonst 404) | `ProjektIssuesAntwort`: Issues des Projekts, `ohne_schluessel` (Projektsumme minus Issues), `gesamt`; `:id` = UUID oder `unzugeordnet` |
| `GET /api/v1/issues?monat=&format=json\|csv` | alle; Projektleiter nur eigene Projekte | `IssuesAntwort`: je Schlüssel und Projekt |

CSV: `;`, Dezimalkomma, BOM (wie `berichte`), Audit „Export Issues“. Keine Personenangaben.
