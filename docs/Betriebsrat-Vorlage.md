# seatmeter – Vorlage für den Betriebsrat

> **Entwurf – keine Rechtsberatung.** Stand 2026-10-22. Diese Vorlage beschreibt seatmeter für die Beteiligung des Betriebsrats und als Grundlage einer Betriebsvereinbarung. Vor der Verwendung von der Rechtsberatung und der bzw. dem Datenschutzbeauftragten des Unternehmens prüfen und an den Betrieb anpassen. Platzhalter stehen in spitzen Klammern, z. B. `<Firma>`.

## 1. Zweck

seatmeter zählt die Nutzung von Claude Code über die Abo-Sitze (Claude Team oder Enterprise) von `<Firma>` und ordnet sie Projekten zu (ein Projekt = ein Git-Repository, meist ein Kundenprojekt). Daraus entstehen:

- **Projektkalkulation:** ein Preis je Projekt aus dem Schattenpreis (was die Nutzung zu API-Listenpreisen gekostet hätte) und einem Anteil an den Sitzkosten.
- **Kostensteuerung:** Budgets und Hinweise je Projekt (Zusatzmodul).
- **Datenqualität:** Nachweis, dass die Zählung vollständig ist und keine Inhalte gespeichert werden.

**Ausdrücklich nicht** Zweck: Leistungs- oder Verhaltenskontrolle, Arbeitszeitkontrolle, Vergleich von Beschäftigten, automatisierte Entscheidungen über Beschäftigte (Art. 22 DSGVO).

Warum überhaupt Personenbezug? Sitzkosten fallen je Person an. Um sie auf Projekte zu verteilen, muss das System wissen, welche Nutzung zu welchem Sitz gehört. Auf Auswertungsstufe 0 (Abschnitt 6) dient der Personenbezug nur dazu.

## 2. Mitbestimmung und Rechtsgrundlage

- **§ 87 Abs. 1 Nr. 6 BetrVG:** Mitbestimmungspflichtig ist die Einführung und Anwendung technischer Einrichtungen, die zur Überwachung von Verhalten oder Leistung geeignet sind. Nach der Rechtsprechung des BAG genügt die objektive Eignung, eine Überwachungsabsicht ist nicht nötig. seatmeter ist objektiv geeignet (Nutzung je Pseudonym). Deshalb vor dem Einsatz eine Betriebsvereinbarung abschließen bzw. die Zustimmung des Betriebsrats einholen. Die Telemetrie-Einstellungen in Claude Code und der lokale Agent gehören zum selben Vorgang.
- Unterrichtung des Betriebsrats nach § 80 Abs. 2 BetrVG mit dieser Vorlage. Weitere Rechte (z. B. § 90 BetrVG bei der Einführung von Claude Code selbst) gesondert prüfen.
- **Rechtsgrundlage der Verarbeitung im Einzelfall prüfen**, z. B. Art. 6 Abs. 1 DSGVO, Art. 88 DSGVO in Verbindung mit der Betriebsvereinbarung als Kollektivvereinbarung, § 26 BDSG bzw. eine Nachfolgeregelung (Anwendbarkeit nach EuGH C-34/21 und aktuellen Gesetzgebungsstand zum Beschäftigtendatenschutz prüfen). Eine Einwilligung der Beschäftigten ist wegen der Freiwilligkeit in der Regel keine tragfähige Grundlage.
- Datenschutz-Folgenabschätzung (Art. 35 DSGVO) prüfen und das Ergebnis dokumentieren; Eintrag im Verzeichnis der Verarbeitungstätigkeiten (Art. 30 DSGVO); Information der Beschäftigten (Art. 13 DSGVO).

## 3. Das System in einfachen Worten

| Teil                          | Was passiert                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Quelle A** (Claude Code)    | Claude Code meldet über die Standardschnittstelle OpenTelemetry je Anfrage an das KI-Modell die verbrauchten Tokens an den seatmeter-Server. Eingeschaltet wird das zentral über die Firmeneinstellungen von Claude Code.                   |
| **Quelle B** (lokaler Agent)  | Optional. Ein kleines Programm (`seatmeter-agent`) auf dem Rechner liest aus den lokalen Protokolldateien von Claude Code nur die Zählerfelder und sendet sie. Es kann auf bestimmte Ordner beschränkt werden (Pfad-Filter).               |
| **Quelle C** (Abgleich)       | Optional, Zusatzmodul. Abgleich mit den Nutzungsberichten von Anthropic (Enterprise Analytics API bzw. Team-Spend-Report), um bezahlte Mehrnutzung herauszurechnen. Namen und E-Mail-Adressen daraus werden sofort gehasht bzw. verworfen. |
| **Server und Dashboard**      | Fasst die Zähler zu Tages- und Monatswerten zusammen, rechnet Preise je Projekt und erstellt Berichte. Zugang nur mit Rolle (Abschnitt 8).                                                                                                  |
| **Nur Abo-Nutzung zählt**     | Nutzung über API-Schlüssel, Cloud-Anbieter oder Claude-Konten anderer Organisationen (z. B. private Konten) wird verworfen und nur als Anzahl ohne Personen- und Projektbezug geführt.                                                      |

## 4. Erfasste und nicht erfasste Daten

### 4.1 Erfasst

| Datenkategorie         | Inhalt                                                                                                                                       | Wofür                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Token-Zähler           | je Anfrage: Input, Output, Cache lesen, Cache schreiben (5 min/1 h)                                                                          | Schattenpreis, Projektpreis               |
| Modell und Merkmale    | Modellname, Geschwindigkeitsmodus, Rechenregion, Subagent ja/nein, von Claude Code gemeldete Kosten                                          | Preisberechnung, Kontrolle                |
| Zeitpunkt je Anfrage   | gespeichert (90 Tage) für Tageszuordnung, Abgleich der Quellen und Monatsgrenzen; **nie als Stunden- oder Uhrzeitsicht je Person angezeigt** | Zuordnung zu Tag und Monat                |
| Projekt                | normalisierte Repo-URL (ohne Zugangsdaten), Owner, Repo-Name; Option „nur Hash“ mit eigenem Anzeigenamen                                     | Zuordnung zum Projekt                     |
| Projektzuordnung       | optional: Repo → Projekt aus dem Projektkatalog, in Ordnern ohne Repo Sitzungs-ID → Projekt; nicht, wer gewählt hat                          | Kosten je Projekt                       |
| Person                 | nur als Pseudonym (Abschnitt 5), Anzeige als Kurzcode `P-XXXXXX`; Sitztyp (z. B. Standard, Premium)                                          | Sitzkosten-Verteilung                     |
| Technische Kennungen   | Sitzungs- und Anfrage-ID von Claude Code                                                                                                     | doppelte Zählung vermeiden                |
| Rechner                | vom Admin vergebene Bezeichnung, Betriebssystem, Agent-Version, Zeitpunkt der letzten Meldung                                                | Betrieb des Agenten, Widerruf             |
| Claude-Code-Version    | Versionsnummer                                                                                                                               | Fehlersuche                               |
| Auth-Klasse            | Abo, API, Anbieter, fremde Organisation                                                                                                      | Filter „nur Abo“                          |
| Organisations-ID       | ID der Anthropic-Organisation von `<Firma>` (Positivliste)                                                                                   | Filter „nur Abo“                          |
| Dashboard-Konten       | Anmeldename, Rollen, Zugriffs- und Änderungsprotokoll; für Konten nur mit der Rolle `entwickler` (Projektwahl) weder Anmelde-Eintrag noch letzte Anmeldung; Anlegen und Rollenvergabe bei der ersten SSO-Anmeldung ohne Konto im Protokoll                                                                                        | Zugriffskontrolle, Nachweis               |

**Grenze bei der Projektwahl:** Welches Konto ein Projekt gewählt hat, speichert seatmeter nicht. Lädt aber ein Admin ein Konto ein oder vergibt von Hand eine Rolle, steht das mit Konto im Protokoll, weil der Admin es offen vornimmt. In einem kleinen Mandanten kann der zeitliche Abstand zwischen einer solchen Einladung und einer späteren Wahl einen Rückschluss auf die wählende Person erlauben. Über SSO angelegte Konten betrifft das nicht, dort stehen Anlegen und Rollenvergabe ohne Konto im Protokoll.

### 4.2 Ausdrücklich nicht erfasst

- Inhalte: Prompts, Antworten, Denkschritte, Tool-Eingaben und -Ausgaben
- Dateinamen und Dateiinhalte, Befehle, Branch-Namen
- Arbeitsverzeichnis und Pfade, Hostnamen; die Server-Protokolle enthalten keine Anfragekörper, Header-Werte oder IP-Adressen
- E-Mail-Adressen und Namen im Klartext (nur als HMAC; Ausnahme: Klarnamen bewusst aktiviert, Abschnitt 5)
- Stunden- oder Uhrzeitprofile je Person

### 4.3 Wie Inhalte draußen bleiben

- **Positivliste im Empfänger:** Übernommen werden nur das Ereignis „API-Anfrage“ mit Zählern und Metadaten, das Ereignis „Anmeldung“ (nur Art und Erfolg) und drei Zähler-Metriken. Alles andere verwirft der Server vor jeder Speicherung. Gezählt wird nur, wie viele Ereignisse mit Inhaltsattributen verworfen wurden; die Zahl steht im Betriebsrats-Bericht.
- **Agent:** Der Parser verwirft Inhaltsfelder schon beim Einlesen und kopiert nur erlaubte Zählerfelder in einen eigenen Datensatz. Pfade, Dateinamen und Branch-Namen verlassen den Rechner nicht.
- **Strenge Schemas:** Agent und Server prüfen jeden Datensatz gegen ein festes Schema; unbekannte Felder werden abgelehnt.
- **Gesperrte Einstellungen:** Die zentralen Firmeneinstellungen (Managed Settings) setzen `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` und `OTEL_LOG_RAW_API_BODIES` ausdrücklich auf `0`. Beschäftigte können den Export von Inhalten dann nicht einschalten.
- **Pseudonymisierung vor der Speicherung:** Konto-ID und E-Mail werden im Server gehasht, bevor etwas gespeichert oder protokolliert wird.

## 5. Pseudonymisierung

- Kennung der Person = `HMAC-SHA256(Mandantensalt, Konto-ID bzw. E-Mail)`. Das Salt (32 Byte) ist je Unternehmen eigen und geheim. Angezeigt wird ein Kurzcode wie `P-K7Q2MX`.
- Das Salt liegt verschlüsselt (AES-256-GCM) in der Datenbank. Der Hauptschlüssel wird getrennt von Server und Backups verwahrt.
- **Klarnamen sind standardmäßig aus.** Einschalten kann sie nur der Mandanten-Admin mit Verweis auf die Betriebsvereinbarung; die Änderung wird protokolliert und erscheint im Bericht. Erst dann werden E-Mail und Name verschlüsselt gespeichert.
- Pseudonymisierte Daten bleiben personenbezogene Daten (Art. 4 Nr. 5 DSGVO): Der Betreiber hält das Salt, und in kleinen Gruppen lässt sich eine Person über Zusatzwissen erkennen (z. B. einziger Premium-Sitz). Dagegen helfen Auswertungsstufe und Mindestgruppe (Abschnitt 6).
- **Pseudonym-Neustart:** Ein neues Salt erzeugt neue Pseudonyme, die mit den alten nicht verknüpfbar sind (z. B. zum Jahreswechsel). Das ist eine bewusste Entscheidung des Mandanten-Admins, kein automatischer Vorgang.

## 6. Auswertungsstufen

Die Stufe gilt für das ganze Unternehmen und wird mit dem Betriebsrat festgelegt (Standard: Stufe 1).

| Stufe                           | Personensicht im Dashboard                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0 „nur Projekte“                | keine; Personen dienen nur der Sitzkosten-Verteilung                                                               |
| 1 „Pseudonym, Monat“ (Standard) | Monatssummen je Pseudonym, nur wenn die jeweilige Auswahl mindestens 3 Personen umfasst (sonst „zu wenige Personen“) |
| 2 „Pseudonym, Tag“              | Tagesverlauf je Pseudonym und Projekt                                                                              |
| 3 „Klarnamen“                   | nur nach Aktivierung durch den Mandanten-Admin mit Verweis auf die Betriebsvereinbarung, protokolliert             |

Auf keiner Stufe gibt es Stunden- oder Uhrzeitsichten je Person. Einzelanfragen sind im Dashboard nicht sichtbar, nur Summen. Personensichten sehen nur die Rollen Mandanten-Admin und Projektleiter (Abschnitt 8).

## 7. Aufbewahrung und Löschung

Standardfristen (je Unternehmen änderbar; jede Änderung wird protokolliert und erscheint im Bericht):

| Daten                                               | Frist                 |
| --------------------------------------------------- | --------------------- |
| Einzelanfragen                                      | 90 Tage               |
| Tagessummen mit Person                              | 13 Monate             |
| Monatsabschluss je Projekt (ohne Person)            | 24 Monate             |
| Kontrollsummen / Annahme-Statistik                  | 30 Tage / 13 Monate   |
| Zugriffs- und Änderungsprotokoll (Audit)            | 24 Monate             |

- Gelöscht wird nächtlich automatisch. Tagessummen mit Person werden nach Ablauf zu Projektsummen ohne Person zusammengefasst.
- Jeder Löschlauf wird protokolliert und im monatlichen Betriebsrats-Bericht ausgewiesen.

## 8. Zugriff und Rollen

| Rolle                       | Darf                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandanten-Admin             | Einstellungen, Organisationen, Tokens, Preise, Sitzkosten, Auswertungsstufe, Klarnamen, Benutzer; Personensichten gemäß Stufe                |
| Controller                  | alle Projekte als Summen, keine Personen                                                                                                     |
| Projektleiter               | nur zugewiesene Projekte; Personensichten gemäß Stufe nur für diese Projekte                                                                 |
| Betriebsrat                 | Betriebsrats-Bericht, Zugriffsprotokoll, Einstellungen lesen; keine Personensichten, keine Kalkulation                                       |
| Plattform-Admin (nur Mehrmandantenbetrieb) | Mandanten anlegen; sieht jeden Mandanten nur als Summen, keine Personensichten; Zugriffe stehen im Protokoll des Mandanten |

- **Jede Personensicht, jeder Export und jede Ansicht eines Berichts** wird im Audit protokolliert: wer, wann, was. Das Öffnen des Betriebsrats-Berichts im Dashboard oder als HTML-Seite steht als „Ansicht“ (mit Berichtsart und Zeitraum, ohne Inhalte), der CSV-Download als „Export“. Das Protokoll enthält keine Daten der gezählten Personen.
- Der Betriebsrat sieht das Protokoll über seine eigene Rolle.

## 9. Berichte

**Betriebsrats-Bericht** je Kalendermonat, als HTML-Seite (druckbar als PDF) oder CSV. Er enthält nur Zähler, auf keiner Stufe Daten einzelner Personen und keine Anmeldenamen von Dashboard-Konten:

1. Zweck und Konfiguration: Auswertungsstufe, Klarnamen an/aus, Mindestgruppe, Aufbewahrungsfristen, aktive Quellen, Konfigurationsänderungen im Monat.
2. Erfasste und ausdrücklich nicht erfasste Datenkategorien.
3. Zugriffe: Konten je Rolle (Anzahl), Zahl der Personensichten, Exporte (Downloads) und Berichtsansichten, Protokolleinträge je Aktion.
4. Mengen: gezählte Personen, Rechner, Projekte, Anfragen, Tokens, ohne Personenbezug.
5. Datenschutznachweise: angenommene und verworfene Ereignisse (mit Inhaltsattributen, API-Nutzung, fremde Organisation, nur als Anzahl), durchgeführte Löschläufe.
6. Versionen von seatmeter und Agent, Hinweis auf die Betriebsvereinbarung.

Die **Projektabrechnung** (CSV) für Controlling und Projektleitung enthält nur Projekte und Sammelposten, keine Personen.

## 10. Auftragsverarbeitung und Betrieb

- **Betrieb durch weeberwrk:** Auftragsverarbeitungsvertrag (Art. 28 DSGVO) mit weeberwrk, Hosting in Deutschland, technische und organisatorische Maßnahmen (TOM) als Anlage zum AVV: Transportverschlüsselung (TLS), verschlüsselte Salts und Schlüssel, getrennte Verwahrung des Hauptschlüssels, verschlüsselte Backups, Mandantentrennung in der Datenbank (Row-Level-Security), Rollen und Protokollierung.
- Unterauftragsverarbeiter laut AVV-Anlage: `<Liste>`. Liegt vor dem Annahme-Host ein weiterer Dienst (z. B. CDN oder Tunnel), gehört er auf diese Liste, weil Quelle A die E-Mail-Adresse erst auf dem seatmeter-Server pseudonymisiert.
- **Betrieb durch `<Firma>` selbst:** Die Daten verlassen das Unternehmen nicht; ein AVV mit weeberwrk ist dann nur für Support-Zugriffe nötig.
- Claude Code selbst (Anthropic) ist eine eigene Verarbeitung und nicht Gegenstand dieser Vorlage.

## 11. Änderungen

- Änderungen an Auswertungsstufe, Klarnamen, Aufbewahrungsfristen, Datenquellen oder Rollen nur nach Information bzw. Zustimmung des Betriebsrats, wie in der Betriebsvereinbarung geregelt.
- Das System protokolliert jede Einstellungsänderung und zeigt sie im monatlichen Bericht.
- Updates, die neue Datenkategorien erfassen würden, vorab dem Betriebsrat vorlegen. Die eingesetzten Versionen stehen im Bericht.

## 12. Ansprechpartner, Laufzeit, Evaluierung

| Funktion                                 | Name / Kontakt |
| ---------------------------------------- | -------------- |
| Verantwortlicher Fachbereich             | `<…>`          |
| Datenschutzbeauftragte(r)                | `<…>`          |
| Ansprechpartner Betriebsrat              | `<…>`          |
| Technischer Betrieb (IT bzw. weeberwrk)  | `<…>`          |

- Laufzeit: `<Pilot von … bis …>` bzw. unbefristet mit Kündigungsregel.
- Evaluierung nach sechs Monaten gemeinsam mit dem Betriebsrat: Zweck erreicht? Stufe und Fristen angemessen? Zugriffsprotokoll unauffällig?

## 13. Vorschlag: Stichpunkte für eine Betriebsvereinbarung

1. **Gegenstand und Geltungsbereich.** Diese Vereinbarung regelt Einführung und Anwendung von seatmeter (Version `<x>`) einschließlich der Telemetrie-Einstellungen von Claude Code und des lokalen Agenten im Betrieb `<Betrieb/Standorte>`. Sie gilt für alle Beschäftigten, denen ein Claude-Code-Sitz der Organisation `<Organisation>` zugewiesen ist.
2. **Zweckbindung.** Die Daten werden ausschließlich zur Projektkalkulation, zur Verteilung der Sitzkosten auf Projekte, zur Budgetsteuerung je Projekt und zur Prüfung der Datenqualität verwendet. Jede andere Verwendung ist ausgeschlossen.
3. **Verbot der Leistungs- und Verhaltenskontrolle.** Die Daten werden nicht zur Leistungs- oder Verhaltenskontrolle, zur Arbeitszeitkontrolle oder zum Vergleich von Beschäftigten verwendet. Arbeitsrechtliche Maßnahmen (insbesondere Abmahnung, Kündigung, Versetzung, Beurteilung, Vergütung) werden nicht auf diese Daten gestützt. Die prozessuale Reichweite eines vereinbarten Verwertungsverbots ist begrenzt; Formulierung rechtlich prüfen.
4. **Auswertungsstufe und Mindestgruppe.** Es gilt Auswertungsstufe `<1>`. Personenbezogene Summen werden auf Stufe 1 nur angezeigt, wenn mindestens drei Personen betroffen sind. Stunden- oder Uhrzeitsichten je Person sind ausgeschlossen.
5. **Klarnamen.** Klarnamen bleiben ausgeschaltet. Eine Aktivierung bedarf der vorherigen schriftlichen Zustimmung des Betriebsrats unter Angabe von Zweck und Zeitraum.
6. **Rollen und Berechtigte.** Zugriff haben nur: Mandanten-Admin `<Funktion/Name>`, Controller `<Funktion>`, Projektleiter `<Funktion>` für ihre zugewiesenen Projekte und der Betriebsrat `<Mitglieder/Ausschuss>`. Die Liste der Berechtigten ist Anlage `<n>`; Änderungen werden dem Betriebsrat vorab mitgeteilt.
7. **Protokollierung und Einsichtsrecht.** Jede Personensicht und jeder Export werden protokolliert. Der Betriebsrat erhält eine eigene Rolle mit Zugriff auf den monatlichen Betriebsrats-Bericht und das Zugriffsprotokoll und kann jederzeit Einsicht nehmen. `<Ggf. Hinzuziehung eines Sachverständigen nach § 80 Abs. 3 BetrVG.>`
8. **Aufbewahrung und Löschung.** Es gelten die Fristen aus Anlage `<n>` (Abschnitt 7 dieser Vorlage). Die Löschung erfolgt automatisch und wird im Bericht nachgewiesen. Längere Fristen nur nach Ziffer 9.
9. **Änderungsverfahren.** Änderungen an Auswertungsstufe, Klarnamen, Fristen, Datenkategorien, Datenquellen oder Berechtigten sowie Updates mit neuen Datenkategorien werden dem Betriebsrat mindestens `<x Wochen>` vorher vorgelegt und bedürfen seiner Zustimmung. Das System protokolliert jede Änderung.
10. **Information der Beschäftigten.** Die Beschäftigten werden vor dem Start schriftlich über Zweck, Datenkategorien, Fristen, Rechte (Art. 13 ff. DSGVO) und Ansprechpartner informiert, einschließlich des einmaligen Freigabedialogs von Claude Code für den Telemetrie-Endpunkt. Merkblatt als Anlage `<n>`.
11. **Pfad-Filter, private Nutzung, Fremdpersonal.** Erfasst wird nur Nutzung über die Organisation `<Organisation>`; private Claude-Konten werden nicht erfasst. Der lokale Agent wird nur mit Pfad-Filter auf `<Firmenordner>` betrieben. Für Freiberufler und Fremdpersonal, für die diese Vereinbarung nicht gilt, wird die Erfassung auf Projektordner von `<Firma>` beschränkt und vertraglich gesondert geregelt.
12. **Evaluierung, Laufzeit, Kündigung.** Die Parteien bewerten den Einsatz nach sechs Monaten gemeinsam. Die Vereinbarung ist mit einer Frist von `<3 Monaten>` zum `<Monatsende>` kündbar; Nachwirkung `<ja/nein>` (§ 77 Abs. 6 BetrVG). Bei Beendigung werden personenbezogene Daten binnen `<x Tagen>` gelöscht oder auf Stufe 0 zurückgeführt.

## 14. Checkliste vor dem Start

- [ ] Betriebsvereinbarung bzw. Zustimmung liegt vor; Auswertungsstufe und Fristen sind festgelegt.
- [ ] Datenschutzbeauftragte(r) beteiligt, Prüfung der Datenschutz-Folgenabschätzung dokumentiert, Eintrag im Verarbeitungsverzeichnis.
- [ ] AVV mit TOM und Liste der Unterauftragsverarbeiter unterschrieben (bei Betrieb durch weeberwrk).
- [ ] Im Dashboard unter „Einstellungen“ Stufe und Fristen gesetzt, Klarnamen aus.
- [ ] Rollen laut Anlage vergeben, Konto mit Rolle Betriebsrat angelegt.
- [ ] Beschäftigte informiert, Freigabedialog von Claude Code angekündigt.
- [ ] Managed Settings mit `OTEL_LOG_*=0` ausgerollt ([Ausrollen.md](Ausrollen.md)).
- [ ] Nach dem ersten Monat Betriebsrats-Bericht gemeinsam angesehen (verworfene Inhaltsereignisse, Zugriffe, Löschläufe).
