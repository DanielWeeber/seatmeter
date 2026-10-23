# Modul `berichte`

Projektabrechnung und Betriebsrats-Bericht (Architektur §7). Jeder Abruf schreibt `audit`:

- Projektabrechnung (CSV und JSON): „Export Projektabrechnung“, Objekt `monat:<JJJJ-MM> format:<format>`.
- Betriebsrats-Bericht öffnen (JSON-Ansicht im Dashboard, HTML-Seite im Browser): „Ansicht Betriebsrat“ (Ereignistyp Ansicht, Entscheidung Daniel 2026-10-22), Objekt `bericht:betriebsrat monat:<JJJJ-MM> zeitraum:<von>..<bis> format:<json|html>`; Mandant und Benutzer stehen in den Spalten, Inhalte nie.
- Betriebsrats-Bericht als CSV-Download: „Export Betriebsrat“, Objekt `monat:<JJJJ-MM> format:csv`.
 Antworttypen: `Projektabrechnung`, `BetriebsratBericht` aus `@seatmeter/shared`.

| Route | Rollen | Inhalt |
|---|---|---|
| `GET /api/v1/berichte/projektabrechnung?monat=&format=csv\|json` | mandanten_admin, controller, projektleiter (eigene Projekte) | je Projekt bzw. Topf: Tokens je Typ, Anfragen, Schatten, Sitzanteil, Überschreitung (mit Kennzeichen „abgezogen“), Projektpreis USD und EUR, Kurs mit Quelle, Preisversion, Verteilung; Summenzeile. Werte aus dem Monatsabschluss (`stand: abgeschlossen`), sonst live (`vorlaeufig`). Standard `csv` |
| `GET /api/v1/berichte/betriebsrat?monat=&format=html\|csv\|json` | mandanten_admin, betriebsrat | Zweck, Konfiguration (Stufe, Klarnamen, Mindestgruppe, Fristen, aktive Quellen, Konfigurationsänderungen ohne Benutzernamen), Datenkategorien, Zugriffe (Konten je Rolle als Anzahl, Personensichten, Exporte, Berichtsansichten, Audit je Aktion), Mengen (gezählte Personen, Rechner, Projekte, Anfragen, Tokens), Datenschutz (`ingest_statistik` inkl. verworfener Inhaltsereignisse, Löschläufe aus `loeschlauf`), Versionen, Hinweis Betriebsvereinbarung. Standard `html` |

- **Keine Personendaten:** Die Projektabrechnung enthält nur Projekte und Töpfe. Der Betriebsrats-Bericht enthält auf keiner Auswertungsstufe Daten einzelner Personen und keine Benutzernamen der Dashboard-Konten (im Header-Modus sind das E-Mail-Adressen); personenbezogene Audit-Aktionen wie „Sitz geändert“ erscheinen nur als Anzahl.
- **CSV:** Trennzeichen `;`, Dezimalkomma, UTF-8 mit BOM, CRLF (Excel). Textfelder, die mit `=`, `+`, `-`, `@` beginnen, bekommen ein `'` vorangestellt.
- **HTML:** eigenständige Seite mit `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, alle Werte maskiert.
- Zeitraum = Kalendermonat in der Mandanten-Zeitzone (Zeitstempel aus `audit` und `loeschlauf` danach gefiltert).
