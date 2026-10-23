# Modul `merge`

Job `merge.ab` (Cron `*/5 * * * *`, Einmallauf `node dist/main.js --einmal merge.ab`); keine eigenen
Routen. Umsetzung von Architektur §3.4 für Anfragen, die sich beim Ingest nicht über den Schlüssel
getroffen haben. Der Schlüssel-Upsert (Modul `ingest-gemeinsam`) bleibt für Treffer über `request_id`
zuständig (Bits, Feldvorrang, `abweichung_ab` beim ersten Zusammentreffen).

## Vertrag

| | |
|---|---|
| Fenster | Anfragen der letzten 35 Tage (`MERGE_TAGE`) |
| Kandidaten | Zeile Y nur aus B (`quellen = 2`), Zeile X mit A-Bit; mindestens einer der Schlüssel beginnt mit `msg:`; gleiche `session_id`, gleiches `model`, `ts` ± 2 s |
| Zusammenführen | nur bei exakt gleichem Tupel (`input`, `output`, `cache_read`, `cache_write`) und nur eindeutige Paare (je Y genau ein X und umgekehrt). X behält Schlüssel, `ts`, Tokens, Person und Auth-Klasse aus A; bekommt Bit B, `heuristisch = true` und die B-Felder `cache_write_1h`, `web_search`, `inference_geo`, `service_tier`, `ist_subagent`, Projekt (B gewinnt). Y wird gelöscht |
| Nie | Zeilen mit verschiedenem Tupel zusammenführen. Ist ein solches Paar sonst eindeutig, bekommen beide `abweichung_ab = true` (Datenqualität „Tokens A ≠ B“) |
| Mehrdeutig | mehrere gleiche Kandidaten: nichts tun, nur zählen (`mehrdeutig`) |
| Vollständigkeit | Σ (input + output + cache_read + cache_write) je Sitzung gegen Σ `otel_kontrollsumme` im Fenster; Sitzungen mit mehr als 1 % Abweichung zählen als abweichend |
| Sperren | gleiche Advisory-Locks je Schlüssel wie der Ingest-Upsert; eine Transaktion je Mandant unter `withMandant` (RLS) |
| `job_lauf.ergebnis` | `{ mandanten, zusammengefuehrt, mehrdeutig, abweichung_markiert, sitzungen_geprueft, sitzungen_abweichend, abdeckung_prozent }`, nur Zähler |

Idempotent: Ein zweiter Lauf findet keine passende B-Zeile mehr. Schickt der Agent eine schon
zusammengeführte `msg:`-Anfrage erneut, entsteht kurz wieder eine B-Zeile, die der nächste Lauf
(≤ 5 min) erneut zusammenführt; das Tagesaggregat läuft nachts und sieht nur den bereinigten Stand.

Die Vollständigkeit je Sitzung wird nicht gespeichert (keine eigene Tabelle); das Dashboard
(Datenqualität) rechnet sie je Monat selbst, der Job meldet die Summe für den Betrieb.

Tests: `packages/server/test/merge-ab.test.ts` (echter Agent aus `packages/agent` gegen den Server im
Prozess, Quelle A über die OTLP-Fixture).
