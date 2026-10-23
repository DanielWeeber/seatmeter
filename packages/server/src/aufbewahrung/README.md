# Modul `aufbewahrung`

Job `aufbewahrung.loeschen` (`45 2 * * *` UTC), Fristen aus `mandant.aufbewahrung_*` (Architektur §3.5); keine Routen.

| Daten | Umsetzung |
|---|---|
| `anfrage` | Grenze je Mandant = Monatsbeginn des Tages „jetzt − Frist“. Partitionen, deren Monat für **alle** Mandanten vollständig älter ist, werden gezählt (je Mandant) und per `DROP TABLE` entfernt; Mandanten mit kürzerer Frist löschen ihre Zeilen ganzer Monate per `DELETE`. |
| `tag_aggregat` mit Person | nach `aufbewahrung_aggregat_monate`: in Zeilen ohne Person zusammengefasst (Projektsummen bleiben), Personenzeilen gelöscht |
| `tag_aggregat` ohne Person, `monatsabschluss` | nach `aufbewahrung_abschluss_monate` |
| `otel_kontrollsumme` | nach `aufbewahrung_kontrollsumme_tage` |
| `ingest_statistik` | nach `aufbewahrung_statistik_monate` |
| `audit` | nach `aufbewahrung_audit_monate` |
| `benutzer_sitzung`, `job_lauf` | abgelaufene Sitzungen; Job-Läufe älter als 90 Tage |

Jeder Lauf schreibt je Mandant und Tabelle eine Zeile in `loeschlauf` (Tabelle, Grenze `bis`, Anzahl, auch 0) für den Betriebsrats-Bericht. `aufbewahrungJob(ctx, jetzt)` nimmt den Stichtag für Tests.
