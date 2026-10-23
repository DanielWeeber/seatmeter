# Modul `preise`

Preistabelle, Sitzkosten und Sitzliste (Architektur §2.5, §5). Rechenkern: `schattenpreis`/`findePreis` aus `@seatmeter/shared`.

- **Start:** `preiseSeedEinspielen(db)` schreibt die globalen Zeilen (`mandant_id` NULL) aus `PREIS_SEED` per Upsert (als Eigentümer; Mandanten-Zeilen bleiben unberührt).
- **Effektive Tabelle** (`effektivePreistabelle`, `ladeEffektivePreistabelle`): Hat der Mandant für einen Präfix eigene Zeilen, entfallen alle globalen Zeilen dieses Präfixes; danach gilt `findePreis` (längster Präfix, jüngstes `gueltig_ab`). Die Aggregation rechnet mit dieser Tabelle.

| Route | Rollen | Inhalt |
|---|---|---|
| `GET /api/v1/preise` | alle | `PreiseAntwort` `{ zeilen: PreisDto[] }`: globale und eigene Zeilen (`herkunft`, `aktiv` = false bei überschriebenen globalen Zeilen) |
| `POST /api/v1/preise` | mandanten_admin | neue Mandanten-Zeile (`preisEingabeSchema`), 409 bei gleichem Präfix und `gueltig_ab` |
| `PUT /api/v1/preise/:id` | mandanten_admin | eigene Zeile ändern; globale oder fremde Zeilen → 404 |
| `GET /api/v1/sitzkosten` | alle | `SitzkostenAntwort` `{ zeilen: SitzkostenZeile[] }`: Sitzkosten je `sitz_typ` und `gueltig_ab` |
| `PUT /api/v1/sitzkosten` | mandanten_admin | Upsert, ein Objekt oder eine Liste (`sitzkostenEingabeSchema`) |
| `GET /api/v1/personen/:id/sitz` | mandanten_admin | Sitzhistorie einer Person |
| `PUT /api/v1/personen/:id/sitz` | mandanten_admin | Sitz ab `gueltig_ab` (`personSitzEingabeSchema`); offener Vorgänger endet am Vortag |

**Sitztypen** (`SITZ_TYPEN` in shared): `standard`, `premium`, `enterprise`, `max5` (Claude Max 5x), `max20` (Claude Max 20x); der frühere Platzhalter `max` ist seit Migration 0017 `max20`. **Standardpreise:** Jeder Mandant bekommt beim Anlegen `max5` 100 USD und `max20` 200 USD je Monat (monatlich, gültig ab 2025-01-01, `SITZ_STANDARDKOSTEN`); das erledigt der Datenbank-Trigger `mandant_sitzkosten_standard` (Funktion `sitzkosten_standard_anlegen`), damit Einrichtung, CLI und ee-Mandantenverwaltung gleich behandelt werden. Ein vorhandener Preis eines Typs wird nie überschrieben.

Antwortschemas (`preiseAntwortSchema`, `sitzkostenAntwortSchema`) liegen in `@seatmeter/shared` (`dashboard.ts`); die Server-Tests prüfen die echten Antworten damit, das Dashboard nutzt sie direkt.

Alle Änderungen mit CSRF-Header und Audit („Preis angelegt/geändert“, „Sitzkosten geändert“, „Sitz geändert“). Nach Preisänderungen alte Tage per `POST /api/v1/jobs/aggregation/tag` neu aufbauen.

Wechselkurse (`kurs`) und Monatsabschluss gehören zum Modul `kalkulation`; Sitzkosten und Sitzliste von hier fließen dort in die Sitzanteile ein (Preis des Sitztyps × `code_anteil_sitz`, anteilig nach Tagen mit gültigem Sitz).
