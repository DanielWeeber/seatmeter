# Modul `mandant`

Einstellungen des aktiven Mandanten (Architektur §3.1 `mandant`, §5, §7). Mandant aus der Sitzung, RLS über `withMandant`.

| Route | Rollen | Inhalt |
|---|---|---|
| `GET /api/v1/mandant/einstellungen` | alle | `MandantEinstellungen` aus `@seatmeter/shared`: `zeitzone`, `waehrung` (EUR, USD), `sitzkosten_verteilung` (person, gleich, pool), `code_anteil_sitz` (0–1), `schatten_faktor` (0–10), `cache_write_annahme` (5m, 1h), `auswertungsstufe` (0–3), `klarnamen_aktiv`, `ratenlimit_otlp` und `ratenlimit_agent` (Anfragen pro Minute je Token bzw. Rechner, 10–1.000.000, `null` = Standard des Servers; Migration 0018; wirkt im Ingest nach spätestens 60 s) |
| `PUT /api/v1/mandant/einstellungen` | mandanten_admin | nur geänderte Felder (`mandantEinstellungenEingabeSchema`, mindestens eines); 400 mit `details` (zod-Meldungen auf Deutsch); CSRF; je geändertem Feld ein Audit-Eintrag „Einstellung geändert“ (`mandant.<feld>: alt → neu`) |

`code_anteil_sitz` und `schatten_faktor` werden auf 4 Nachkommastellen gerundet (Spalten `numeric(6,4)`).
Die Lese-Route `GET /api/v1/auth/mandant` (Modul `auth`) bleibt für Name, Plan und Aufbewahrungsfristen.
Änderungen an Auswertungsstufe und Klarnamen sind mitbestimmungspflichtig (Architektur §10.5); der Betriebsrats-Bericht listet sie im Abschnitt Konfiguration.
