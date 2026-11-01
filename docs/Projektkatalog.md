# Projektkatalog: Repos und Sitzungen Projekten zuordnen

Der Projektkatalog holt die Projekte aus Ihrem Projektmanagement-Werkzeug nach seatmeter. Jedes Repo wird einem Projekt zugeordnet, die Kosten erscheinen je Projekt. seatmeter liest die Projekte nur und **schreibt nichts zurück**. Teil des Kerns (Apache-2.0), ohne Lizenz nutzbar.

## Was Sie brauchen

- **Quelle A über verwaltete Einstellungen** (`docs/Ausrollen.md`) mit `OTEL_METRICS_INCLUDE_REPOSITORY=true`: Claude Code sendet das Repo dann bei jeder Anfrage. Der Agent ist nicht nötig (Abschnitt „Ohne Agent“).
- **Die Projekte aus Ihrem Werkzeug:** Am besten sendet das Quellsystem sie selbst (Abschnitt 1). Für den Erstbestand und Läufe von Hand gibt es die CSV (Abschnitt 2).

Liefert die Quelle das Repo erst ab einem bestimmten Tag, fehlt es für die Nutzung davor: Die Zuordnung wirkt rückwirkend, aber nur auf Nutzung, zu der ein Repo bekannt ist.

## 1. Projekte senden (Push)

Der Regelfall: Ihr Projektmanagement-Werkzeug oder ein kleiner Job sendet je Projekt eine Anfrage an seatmeter. Viele Quellsysteme können das, etwa über einen Web-Service-Aufruf je Projekt. Die Route ist dafür gebaut, dass ein Lauf aus tausenden Anfragen nicht abbricht: Viele Systeme werten alles außer HTTP 200 als Fehler und beenden dann den Lauf.

```sh
curl -sS -X PUT 'https://seatmeter.example.com/api/v1/projektkatalog/projekte/4711' \
  -H "Authorization: Bearer $SEATMETER_KATALOG_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name": "AP Login", "number": "P-100.1", "parentId": "4700", "customer": "Muster AG", "status": "offen"}'
```

```json
{ "externalId": "4711", "ergebnis": "neu", "active": true }
```

`ergebnis` ist `neu`, `aktualisiert` oder `unveraendert`. Die Anfrage ist idempotent, die Reihenfolge der Projekte ist egal.

**Voller Lauf jede Stunde ist ein normales Muster:** Das Quellsystem darf bei jedem Lauf alle Projekte senden, auch geschlossene, eines nach dem anderen. Unverändertes kostet nur Lesen: seatmeter vergleicht ohne Sperre und schreibt die Zeile nicht, höchstens einmal in 24 Stunden `zuletzt_gesehen`. Es entsteht keine Audit-Zeile je Anfrage. Letzte Synchronisation und Zähler laufen gebündelt weiter, darum bleibt der Status auch bei Läufen ohne jede Änderung frisch.

| Feld | Pflicht | Bedeutung |
|---|---|---|
| ID im Pfad | ja | Externe ID, der Schlüssel des Projekts, höchstens 200 Zeichen. URL-kodiert (`P%2F100` ergibt `P/100`), ein Schrägstrich am Ende ist egal. |
| `name` | ja | Bezeichnung |
| `number` | nein | Nummer zur Anzeige. Ohne Nummer zeigt seatmeter die externe ID. Darf sich wiederholen. |
| `parentId` | nein | Externe ID des Elternprojekts (Abschnitt 3), dieselbe Schreibweise wie im Pfad. Das Elternprojekt darf später ankommen. |
| `customer` | nein | Kunde |
| `status` | nein | Status als Text, wird unverändert gespeichert und auf der Seite gezeigt |
| `active` | nein | `true`/`false`, `1`/`0`, `ja`/`nein`, `on`/`off`, `t`/`f`, auch als Text; schlägt `status` |

**Feldregeln:**

- **Weggelassen** behält den gespeicherten Wert, **`null`** oder `""` leert ihn. Das gilt für `number`, `parentId`, `customer` und `status`.
- **Aktiv:** `active` gewinnt, wenn es gesendet wird. Sonst macht ein Status aus der Liste das Projekt inaktiv, Groß-/Kleinschreibung egal. Unbekannte Status und Anfragen ohne `status` und `active` bedeuten aktiv: Ein Projekt, das wegen Alters deaktiviert wurde, kommt so mit der nächsten Anfrage zurück. Der gespeicherte Status bleibt dabei stehen, wenn keiner gesendet wird.
- **Liste der inaktiven Status** unter Einrichtung → Projektkatalog → Synchronisation. Standard: `closed`, `archived`, `inactive`, `cancelled`, `abgeschlossen`, `archiviert`, `geschlossen`, `inaktiv`, `beendet`, `storniert`.
- **Großzügig gelesen:** Unbekannte Felder werden ignoriert, jeder Content-Type gilt als JSON, Zahlen werden Text, unbrauchbare Werte gelten als weggelassen, zu lange Texte werden gekürzt und Steuerzeichen zu Leerzeichen.
- **Zeichensatz:** Ein angegebener `charset` gilt. Ohne Angabe liest seatmeter streng UTF-8 und fällt sonst auf Windows-1252 zurück.
- **Große IDs:** Numerische IDs über 2^53 als Text senden (`"parentId": "12345678901234567890"`). Als JSON-Zahl runden sie die meisten Parser, und das Kind fände sein Elternprojekt nicht.
- **Inaktiv** heißt: nicht mehr wählbar. Zuordnungen und Kosten bleiben.

**Statuscodes:**

| Code | Wann |
|---|---|
| **200** | Angelegt, geändert oder unverändert. Nie 201, 204 oder eine Weiterleitung. |
| 400 | `name` fehlt, kein JSON-Objekt oder die ID ist unbrauchbar (leer, zu lang, Steuerzeichen) |
| 401 | Token fehlt, ist unbekannt, widerrufen oder hat den falschen Zweck |
| 413 | Körper größer als 4 MB |
| 429 | Nur nach vielen Fehlversuchen mit ungültigem Token (30 je Client-IP in 15 Minuten). Gültige Tokens haben hier kein Ratenlimit und sind davon nicht betroffen. |
| 5xx | Serverfehler; das Quellsystem soll den Lauf später wiederholen |

**Token:** Unter **Einrichtung → Projektkatalog → API-Tokens** ein Token mit dem Zweck „Push aus dem Quellsystem“ (`katalog_api`) anlegen. Es wird nur einmal angezeigt, gilt für diesen Mandanten und nur für diese Route und den Sync-Status und lässt sich jederzeit widerrufen. Ein Token vom Zweck `csv_import` gilt hier nicht, eine Anmeldung per Cookie auch nicht. Falscher Zweck ergibt 401. Das Mandanten-Token aus den verwalteten Einstellungen gilt nie, weil alle Beschäftigten es lesen können.

**Vor einem Reverse Proxy** müssen die Routen ohne vorgeschaltete Anmeldung erreichbar sein, sonst bekommt das Quellsystem eine Weiterleitung und bricht ab. Welche genau und wie: `deploy/README.md`, Abschnitt Reverse-Proxy, auch für nginx (`proxy_intercept_errors off`, `proxy_pass` ohne URI-Teil).

**Ratenlimits:** Push und Status sind für gültige Tokens nicht begrenzt, Fehlversuche schon. `SEATMETER_RATE_*` gilt nur für die Ingest-Pfade und berührt keine dieser Routen. Der CSV-Upload hat eine feste, großzügige Grenze je Token (10 Dateien je Minute, Stoß 30), weil jede Datei den ganzen Katalog abgleicht; ein Upload je Lauf erreicht sie nie. Eine Begrenzung im Proxy (nginx `limit_req`, Caddy-Module, WAF) muss diese Routen ausnehmen: Das Quellsystem bricht bei 429 seinen ganzen Lauf ab.

### Wenn die Synchronisation ausbleibt

Die Seite zeigt die letzte Synchronisation und die Zähler der letzten sieben Tage, auch die abgelehnten Anfragen (gültiges Token, aber nicht 200). So fällt ein abgebrochener Lauf auf. Bleibt sie länger aus als eingestellt (Standard 48 Stunden, leer = aus), warnt seatmeter:

- **Auf der Seite** Projektkatalog.
- **Über die Alarmkanäle** aus „Budgets und Alarme“, einmal je Ausfall; eine Entwarnung gibt es nicht. Der stündliche Job `projektkatalog.sync` prüft das und steht in `job_lauf`.
- **Für Ihre Überwachung:** `GET /api/v1/projektkatalog/sync-status` antwortet **200**, solange alles frisch ist, und **503**, wenn die Synchronisation ausbleibt, ohne Token **401**. Am besten mit einem eigenen Token vom Zweck „Überwachung“ (`sync_status`), das nur diese Route lesen darf; `katalog_api` gilt dort auch, `csv_import` nicht. Der Körper nennt `status` (`ok`, `veraltet`, `aus`, `nicht_bewertet`), `zuletzt_sync`, `warnung_stunden`, `alter_stunden`, `abgelehnt_heute` und `abgelehnt_7_tage`. Abgelehnte Anfragen ändern den Statuscode nicht.

Bewertet wird erst, wenn ein Token existiert oder schon synchronisiert wurde; ab dem ältesten aktiven Token läuft die Frist. Als Synchronisation zählen Push, Upload mit Token und CLI, nicht aber ein Import von Hand im Dashboard.

**Nicht mehr gesendete Projekte deaktivieren** (Standard aus): Mit „nach Tagen deaktivieren“ werden Projekte inaktiv, die so viele Tage vor dem letzten Push zuletzt gesendet wurden. Gemessen wird gegen den letzten Push, nicht gegen die Uhr: Verstummt das Quellsystem, altert nichts.

- **Genauigkeit einen Tag:** `zuletzt_gesehen` ist bewusst bis zu 24 Stunden alt, weil unveränderte Anfragen die Zeile nicht schreiben. Die Grenze ist darum `letzter Push − Tage − 24 Stunden`. Ein nicht mehr gesendetes Projekt wird nach den eingestellten Tagen bis einem Tag mehr inaktiv (plus bis zu einer Stunde bis zum nächsten Job), nie früher. Ein Projekt, das jeder Lauf sendet, sieht nie veraltet aus, auch wenn der Job mitten im Lauf feuert.
- **Tage länger als der Abstand zweier Läufe wählen:** Mit Tagen = 1 und stündlichen Läufen flackert nichts; bei einem Lauf je Tag sollten es mindestens 2 Tage sein.

- **Nur gesendete Projekte** (`quelle = api`). Per CSV angelegte Zeilen altern nie, und ein CSV-Upload zählt hier nicht als Lebenszeichen der Quelle.
- **Quelle still:** Liegt der letzte Push länger zurück als die Warnfrist, wird zusätzlich nichts deaktiviert.
- **Nach einem Ausfall:** Eine Lücke von über 25 Stunden zwischen zwei Pushes gilt als Ausfall. Danach wird erst wieder deaktiviert, wenn das Quellsystem so viele Tage ohne solche Lücke gesendet hat, wie eingestellt sind. So zählt ein Ausfall nicht als Alter, auch wenn der erste Lauf danach abbricht. Eine Quelle mit einem Lauf je Tag bleibt mit Lücken um 24 Stunden durchgehend. Läuft sie seltener als alle 25 Stunden, beginnt die Zählung bei jedem Lauf neu, und es wird nie wegen Alters deaktiviert.
- **Bremse:** Über einen Zeitraum (die eingestellten Tage plus einen) darf höchstens der eingestellte Anteil der gesendeten Projekte wegen Alters inaktiv werden (Standard 25 %). Gezählt wird alles in diesem Zeitraum Deaktivierte plus der aktuelle Durchgang, gegen den Stand zu Beginn des Zeitraums: So kommt auch ein Schwund in kleinen Scheiben nicht durch. Wäre es mehr, hält der Durchgang an, deaktiviert nichts und alarmiert einmal. CSV-Zeilen zählen nicht mit, sie altern nicht; ein zurückgekehrtes Projekt zählt nicht mehr. Erlaubt ist immer mindestens ein Projekt, damit ein kleiner Katalog nicht hängen bleibt; leer wird er dadurch nicht, weil ein gerade gesendetes Projekt nie veraltet ist. Die Seite zeigt den Halt. War der Lauf im Quellsystem abgebrochen, kommen die Projekte mit dem nächsten vollständigen Lauf zurück, und der Halt löst sich. Sind sie wirklich entfallen, bleibt er stehen, auch nach vollständigen Läufen. Ausweg: die Grenze einmal erhöhen, den nächsten stündlichen Durchgang abwarten und sie zurückstellen. Eine geänderte Grenze beginnt den Zeitraum neu.
- Zuordnungen bleiben, das Audit nennt je Lauf die Anzahl in einer Zeile, wenn etwas deaktiviert oder angehalten wurde.

**Protokoll:** Keine Audit-Zeile je Anfrage. Je Tag und Token schreibt der Job eine Zeile mit den Zählern, ohne das Token. Zähler, letzte Nutzung und letzte Synchronisation schreibt seatmeter gebündelt alle paar Sekunden; bei einem Absturz fehlen höchstens diese Sekunden in den Zählern, nicht die Projekte. Das gilt auch für Läufe, die nichts ändern.

## 2. CSV: Erstbestand und Läufe von Hand

Für den ersten Bestand, einen Lauf von Hand oder Werkzeuge ohne Push: **Einrichtung → Projektkatalog → CSV importieren**, die Upload-Route und die CLI (Abschnitt „Geplanter Import“). Viele Projektmanagement-Werkzeuge können Projektlisten als CSV exportieren.

**Achtung:**

- Eine vollständige Liste macht alle Projekte inaktiv, die in der Datei fehlen, auch per Push gesendete. Sendet Ihr Quellsystem schon, importieren Sie mit `--teilliste` (`vollstaendig=0`, im Dashboard Haken entfernen).
- **Die ID in der CSV muss dieselbe Kennung sein wie beim Push.** Mischen Sie etwa Projektnummern in der CSV mit internen IDs beim Push, entsteht jedes Projekt doppelt, und seatmeter kann das nicht zusammenführen. Prüfen Sie den ersten Import mit einem Trockenlauf: `neu` sollte dann klein sein, wenn das Quellsystem schon sendet.

### CSV-Format

```text
Nummer;Name;Kunde;Aktiv
P-100;Webshop;Muster AG;ja
P-200;Portal;Beispiel GmbH;ja
P-300;Altes Projekt;;nein
```

- **Kopfzeile** ist Pflicht, **UTF-8** mit oder ohne BOM. Andere Kodierungen wie Windows-1252 werden abgelehnt, damit keine Umlaute kaputtgehen.
- **Trennzeichen** ist standardmäßig das Semikolon, einstellbar sind Komma, Tabulator und senkrechter Strich. Es wird nie erraten: Passt es nicht zur Datei, wird sie abgelehnt.
- **Spaltenzuordnung (optional):** Sie nennen die Spalten für die **externe ID** und den **Namen**, optional Nummer, Kunde, Aktiv und Parent. Alle anderen Spalten zählen dann nicht.
- **Ohne Zuordnung** gelten die üblichen Spaltennamen: externe ID (`ID`, `Externe ID`, `Kennung`), Nummer (auch `Projektnummer`, `Nr`), Name (auch `Projektname`, `Titel`), Kunde, Aktiv (auch `Status`), Parent (auch `Parent ID`, `Elternprojekt`). Gibt es nur eine Nummer, ist sie auch die externe ID. Andere Spalten zählen auch hier nicht.
- **Aktiv:** `ja`, `aktiv`, `offen` oder leer bzw. `nein`, `inaktiv`, `abgeschlossen`. Liefert Ihr Werkzeug andere Statuswerte, die Status-Spalte nicht zuordnen, sonst wird jede Zeile abgelehnt. Mit einer Spaltenzuordnung ohne Aktiv-Spalte gilt jedes Projekt in der Datei als aktiv.

### Was ein Import ändert

- **Wiederholter Import ist ein Upsert** über die externe ID: Neue IDs werden angelegt, bekannte aktualisiert.
- **Vollständige Liste (Standard):** Projekte, die in der Datei fehlen, werden **inaktiv, nie gelöscht**. Sie stehen nicht mehr zur Wahl, bestehende Zuordnungen und ihre Kosten bleiben. Taucht die Nummer wieder auf, ist das Projekt wieder aktiv. Mit einer **Teilliste** wird nichts deaktiviert.
- **Spalte fehlt:** Der gespeicherte Wert bleibt, zum Beispiel bei Kunde, Nummer oder Parent. Ist die Spalte da und das Feld leer, wird der Wert geleert. Dieselbe Regel wie beim Push.
- Einen Eintrag „Kein Projekt“ legt seatmeter nie selbst an. Der Katalog enthält genau die Projekte Ihrer Liste.

### Abgelehnte Zeilen

Probleme der **ganzen Datei** (Kodierung, Kopfzeile, auch ein Zeilenumbruch darin, Trennzeichen, Spaltenzuordnung, offenes Anführungszeichen, keine Projekte, mehr als 20 000 Zeilen oder 16 MB) lehnen sie ab: Antwort 400, nichts wird geändert.

Eine **einzelne schlechte Zeile** lehnt nur diese Zeile ab, gültige Zeilen werden übernommen. Eine abgelehnte Zeile deaktiviert nie ein Projekt:

- **ID lesbar:** Dieses Projekt bleibt in diesem Lauf unverändert.
- **ID nicht lesbar oder Zeilen womöglich verschluckt** (ID fehlt, ist zu lang, abweichende Spaltenzahl, Steuerzeichen in ID, Nummer, Name, Kunde oder Parent, Zeilenumbruch in einer Spalte, die zählt, also ID, Nummer, Name, Kunde, Aktiv oder Parent): In diesem Lauf wird gar nichts deaktiviert, die Antwort meldet `deaktivierung_uebersprungen: true`. Dasselbe gilt, wenn keine einzige Zeile gültig ist.
- **Doppelte ID:** Die erste Zeile zählt, weitere werden abgelehnt.

**Anführungszeichen:** Nur am Feldanfang beginnt ein Anführungszeichen einen Abschnitt, mitten im Feld ist es ein normales Zeichen (`5" Monitor`). Folgt auf das schließende Zeichen weiterer Text oder bleibt am Dateiende eines offen, wird die ganze Datei abgelehnt, weil dann unklar ist, wo die Zeilen enden.

**Mehrzeiliger Text in einer Spalte, die nicht zählt**, ist erlaubt, etwa eine Beschreibung. Sieht eine Zeile dieses Texts wie eine CSV-Zeile aus, hat sie also mindestens so viele Trennzeichen wie die Datei Spalten minus eins, kann ein verirrtes Anführungszeichen ganze Zeilen verschluckt haben: Die Zeile wird übernommen, aber es wird nichts deaktiviert. Die Antwort meldet `deaktivierung_uebersprungen: true` und in `hinweise` die Zeilennummer. Das trifft auch eine echte Beschreibung mit so vielen Trennzeichen; seatmeter kann sie nicht von einer verschluckten Zeile unterscheiden und deaktiviert darum lieber nichts. Abhilfe: das Trennzeichen wechseln oder die Spalte nicht mitliefern. Weniger Trennzeichen fallen nicht auf: Zwei verirrte Anführungszeichen können so eine einzelne Zeile verschlucken, ohne dass es erkannt wird. Prüfen Sie im Zweifel mit dem Trockenlauf, ob die Zähler stimmen.

### Zähler und Trockenlauf

Jeder Import meldet:

| Feld | Bedeutung |
|---|---|
| `neu` | neue Projekte |
| `aktualisiert` | Name, Kunde oder Aktiv hat sich wirklich geändert, auch Reaktivierung und `Aktiv = nein` in der Datei |
| `unveraendert` | Zeile bekannt, nichts geändert |
| `deaktiviert` | Projekte, die in der vollständigen Liste fehlen |
| `abgelehnt` | abgelehnte Zeilen; `abgelehnte_zeilen` nennt höchstens 20 mit Zeilennummer, nie mit Zellinhalten |
| `hinweise` | gültige Zeilen, deretwegen nichts deaktiviert wird, ebenfalls mit Zeilennummer |
| `aktiv_gesamt` | aktive Projekte danach |

Der **Trockenlauf** („Nur prüfen“, `trockenlauf=1`, `--trockenlauf`) rechnet dieselben Zahlen wie ein echter Lauf, schreibt aber weder in den Katalog noch ins Protokoll. Prüfen Sie damit besonders den ersten Import und eine neue Exportvorlage: Eine abgeschnittene Datei wäre sonst eine vollständige Liste, und die fehlenden Projekte würden inaktiv.

### Geplanter Import

**Upload-Route** für einen Rechner, der seatmeter über HTTPS erreicht. Das Token legen Sie unter **Einrichtung → Projektkatalog → API-Tokens** mit dem Zweck „CSV-Upload“ an. Es wird nur einmal angezeigt, gilt nur für diese Route und diesen Mandanten und lässt sich dort jederzeit widerrufen; die Seite zeigt auch die letzte Nutzung. Legen Sie es in Ihrem Secret-Store ab. Das Mandanten-Token aus den verwalteten Einstellungen gilt hier bewusst nicht, weil alle Beschäftigten es lesen können.

```sh
curl --fail-with-body -sS -X POST \
  'https://seatmeter.example.com/api/v1/projektkatalog/import/datei?spalte_id=Projektnummer&spalte_name=Projektname&spalte_kunde=Kunde' \
  -H "Authorization: Bearer $SEATMETER_KATALOG_TOKEN" \
  -H 'Content-Type: text/csv' \
  --data-binary @projekte.csv
```

Parameter, alle optional: `trennzeichen` (`semikolon`, `komma`, `tab`, `pipe`), `spalte_id`, `spalte_name`, `spalte_nummer`, `spalte_kunde`, `spalte_aktiv`, `spalte_parent`, `trockenlauf=1`, `vollstaendig=0` für eine Teilliste. Unbekannte Parameter ergeben 400, damit ein Tippfehler bei `trockenlauf` nie zu einem echten Import wird. Ein Lauf mit abgelehnten Zeilen oder übersprungenem Deaktivieren antwortet 200: Prüfen Sie im Job beide Felder, zum Beispiel mit `jq -e '.abgelehnt == 0 and .deaktivierung_uebersprungen == false'`. Das Deaktivieren kann auch ohne abgelehnte Zeile entfallen (`hinweise`).

**CLI** auf dem Server, ohne Token:

```sh
docker compose -f deploy/compose.yml exec -T server \
  node /app/server/dist/projektkatalog/cli-katalog-importieren.js \
  --mandant <slug> --datei - \
  --spalte-id Projektnummer --spalte-name Projektname --spalte-kunde Kunde \
  < projekte.csv
```

Weitere Schalter: `--trennzeichen`, `--spalte-nummer`, `--spalte-aktiv`, `--spalte-parent`, `--trockenlauf`, `--teilliste`. Die Ausgabe sind die Zähler als JSON. **Exit-Code:** 0 = Erfolg, 2 = Erfolg, aber abgelehnte Zeilen oder übersprungenes Deaktivieren, 1 = Fehler, nichts geändert (Meldung als JSON auf stderr).

**Melden Sie den Job an Ihre Überwachung** (Heartbeat oder Alarm bei Exit-Code ungleich 0), sonst fällt nicht auf, wenn der Katalog veraltet. `Letzter Import` auf der Seite Projektkatalog zeigt den Stand.

Für Skripte, die schon JSON erzeugen, gibt es außerdem `POST /api/v1/projektkatalog/import` mit `{ "projekte": [{ "externe_id": "4711", "nummer": "P-100", "name": "Webshop", "kunde": "Muster AG", "parent": "4700" }], "vollstaendig": true }` (Anmeldung als Mandanten-Admin).

## 3. Verschachtelte Projekte

Projekte dürfen verschachtelt sein, zum Beispiel Arbeitspakete unter einem Projekt. Die Hierarchie kommt aus `parentId` (Push) bzw. der Spalte `parent` (CSV) oder dem Feld `parent` (JSON-Import) und verweist auf die externe ID.

- **Jede Ebene ist wählbar**, auch ein Elternprojekt. Die Liste zeigt den Baum eingerückt, Eltern vor Kindern, Geschwister sortiert. Die gewählte Zuordnung zeigt den ganzen Pfad, zum Beispiel `Webshop › AP Login`.
- **Suche:** Sie findet Nummer, Name und Kunde auch mitten im Wort, Groß-/Kleinschreibung egal; bei mehreren Wörtern müssen alle vorkommen, in beliebiger Reihenfolge. Die Vorfahren eines Treffers stehen als Kontext dabei, ein aktiver Vorfahre bleibt wählbar. Aktive Nachfahren eines Treffers erscheinen mit: Wer ein geschlossenes Projekt sucht, sieht seine offenen Arbeitspakete. Unter dem Kundenfilter bleiben Nachfahren ohne eigenen Kunden dabei, solche mit einem anderen Kunden nicht. Mehr als 100 Zeilen zeigt die Liste nicht, sie bittet dann um eine engere Suche.
- **Inaktiv:** Ein aktives Kind unter einem inaktiven Elternprojekt bleibt wählbar; das Elternprojekt steht ausgegraut und nicht wählbar darüber, in der Standardansicht und in der Suche. Ein inaktiver Eintrag ohne Aktives darunter steht nirgends in der Auswahl, auch nicht in der Suche. Ein Elternprojekt zu deaktivieren ändert weder seine Kinder noch Zuordnungen.
- **Reihenfolge:** Wurzeln nach Name, damit auch tausende Wurzeln bedienbar bleiben; Geschwister nach Nummer. Ein Elternprojekt, das nie gesendet wurde, macht sein Kind zur Wurzel.
- **Schlechte Daten** brechen nichts: Ein unbekanntes Elternprojekt, ein Selbstbezug oder ein Zyklus ergibt die oberste Ebene, und ab 20 Ebenen beginnt eine neue Wurzel. Das Elternprojekt darf später ankommen.
- **Kosten** bleiben flach je gewähltem Projekt, mit dem Pfad als Bezeichnung auf der Seite und in der CSV. Summen über ein Elternprojekt gibt es nicht; so zählt nichts doppelt.

## 4. Repos zuordnen

Zwei Wege, die sich ergänzen:

- **Im Dashboard:** Einrichtung → Projektkatalog bzw. Auswertung → Projektkosten, Abschnitt „Zuordnung“. Mandanten-Admins ordnen alle Repos zu, die Projektleitung ihre eigenen; Projektleitung mit einer weiteren Rolle sieht hier nichts. Die Liste zeigt nur Repos mit Nutzung oder Wahl. Die Projektliste ist durchsuchbar (Nummer, Name, Kunde) und nach Kunde filterbar.
- **Erzwungen beim Arbeiten:** siehe Abschnitt 5.

Mehrere Repos dürfen zum selben Projekt gehören, ein Repo gehört zu genau einem Projekt.

**Die Zuordnung ändert keine Nutzungsdaten.** Sie liegt getrennt, wirkt rückwirkend und lässt sich korrigieren. **Abgeschlossene Monate bleiben unverändert:** Der Monatsabschluss hält die Zuordnung und die Kosten dieses Monats fest. Das gilt auch für Name und Kunde, wenn sich diese im Katalog später ändern. Ein Monat, der abgeschlossen wurde, bevor es irgendeine Zuordnung gab, rechnet weiter mit der aktuellen Zuordnung.

## 5. Projektwahl erzwingen (optional)

Ein verwalteter Hook prüft vor dem Prompt, ob das Repo ein Projekt hat. Was dann passiert, bestimmt die Stufe unter **Einrichtung → Projektkatalog**:

| Stufe | Wirkung |
|---|---|
| **Aus** (Standard) | Nichts passiert. |
| **Warnen** | Der Prompt läuft weiter, Claude Code zeigt einmal je Stunde und Repo den Link zur Projektliste. |
| **Blockieren** | Der Prompt wartet, bis ein Projekt gewählt ist. Einen Ausweg am Rechner gibt es bewusst nicht. |

```text
seatmeter: Bitte zuerst das Projekt wählen: https://seatmeter.example.com/projektwahl/…
Danach den Prompt erneut senden.
```

- **Einmal je Repo:** Die erste Wahl gilt für alle Sitzungen in diesem Repo. Ändern dürfen danach nur Mandanten-Admin und Projektleitung.
- **Ordner ohne Repo:** Die Wahl gilt nur für diese Sitzung, jede neue Sitzung (auch nach `/clear`) fragt wieder. Die Nutzung wird über die Sitzungs-ID zugerechnet. Das gilt auch für Remotes, die keine URL sind (lokale Pfade): Sie verlassen den Rechner nicht.
- **Nur Projekte aus dem Katalog:** Einen Eintrag „Kein Projekt“ gibt es nicht. Legen Sie für interne Arbeit ein Projekt in Ihrem Werkzeug an.
- **Anmeldung:** Die Auswahlseite verlangt eine Anmeldung. Damit Beschäftigte ohne Dashboard-Zugang wählen können, gibt es die Rolle **`entwickler`**: Sie darf nur diese Seite und sieht keine Auswertung. Am einfachsten vergeben Sie sie über SSO (Gruppen → Rollen, `docs/SSO-und-SCIM.md`). Die Seite warnt, solange es weder solche Konten noch eine Gruppenzuordnung gibt.
- **Kein Zugang:** Wer ein Konto außerhalb der Organisation hat, sieht auf der Auswahlseite den **Kontakt**, den Sie unter Einrichtung → Projektkatalog hinterlegen.

**Reihenfolge beim Einführen:**

1. Katalog füllen (Abschnitte 1 und 2) und die Rolle `entwickler` vergeben.
2. Seite **Ausrollen**: Option „Hook für die erzwungene Projektwahl aufnehmen“ wählen und die erzeugten verwalteten Einstellungen verteilen (Tab MDM oder Server). Bei einem festen Mandanten-Token steht es zusätzlich in `SEATMETER_PROJEKTWAHL_TOKEN`, weil Claude Code `OTEL_*` nicht an Hooks weiterreicht.
3. Beschäftigte informieren: Claude Code fragt einmal nach der Freigabe des Hooks. Wer ablehnt, beendet Claude Code.
4. Stufe **Warnen** einstellen. Der Schalter wirkt ohne neue Verteilung, auf jedem Rechner nach spätestens einer Stunde. Beobachten Sie, ob Repos zugeordnet werden und ob jemand keinen Zugang bekommt.
5. Erst dann **Blockieren**. Wird eine Zuordnung entfernt, fragt der Hook auf Rechnern, die das Repo schon als zugeordnet kennen, spätestens nach einem Tag wieder.

**Wenn der Schalter sich weigert:** Zwei Konfigurationen verhindern Warnen und Blockieren. Die Seite zeigt den Grund, und falls die Stufe schon aktiv ist, lässt die Prüf-Route alle durch und schreibt eine Warnung ins Server-Log.

- **Header-Modus mit `SEATMETER_AUTO_ROLLE` anders als `entwickler`:** Der Link legt für unbekannte Personen ein Konto mit dieser Rolle an, standardmäßig `mandanten_admin`. Setzen Sie `SEATMETER_AUTO_ROLLE=entwickler`.
- **`SEATMETER_INGEST_URL` ohne `SEATMETER_PUBLIC_URL`:** Der Link zeigte auf den Ingest-Host und liefe ins Leere. Setzen Sie `SEATMETER_PUBLIC_URL`.

**Notfall:** Fällt Ihr Identitätsanbieter aus, kommt niemand mehr auf die Auswahlseite und auch kein Admin ins Dashboard. Dann schaltet die CLI den Block auf dem Server ab (wirkt auf den Rechnern, sobald die Marke abläuft; ein Rechner ohne Marke fragt sofort):

```sh
docker compose -f deploy/compose.yml exec -T server \
  node /app/server/dist/projektkatalog/cli-projektwahl-stufe.js --mandant <slug> --stufe aus
```

**Grenze bei ungewöhnlichen Remotes:** Enthält die Remote-URL ein Passwort mit rohem `@` oder der Pfad einer SSH-Remote `..`, ein Anführungszeichen oder einen Backslash, sendet Claude Code kein Repo (geprüft mit Version 2.1.316). Die Wahl gelingt, die Nutzung bleibt aber offen. Kodieren Sie das Passwort (`%40`) oder nutzen Sie SSH bzw. einen üblichen Pfad.

**Grenze mit dem Agenten:** Ordnet der Agent einen Ordner über `--projekt-pfad` (`pfad_projekte`) einem seatmeter-Projekt zu, hat diese Nutzung bereits ein Projekt. Eine Wahl je Sitzung wirkt dort nicht. Ordnen Sie stattdessen das Pfad-Projekt unter „Zuordnung“ einem Katalog-Projekt zu.

### Was der Hook tut

- **Er sendet nie den Prompt.** Übertragen werden nur die Sitzungs-ID und die Repo-URL ohne Zugangsdaten (in der scp-Form `nutzer@host:pfad` steht statt des Nutzers immer `git`, weil dort auch ein Token stehen kann), an `POST /api/ingest/v1/projektwahl` auf dem Ingest-Host, mit dem Token aus den verwalteten Einstellungen.
- **Claude Code blockiert nie wegen seatmeter:** Ist der Server nicht erreichbar, antwortet er mit einem Fehler oder fehlt das Token, läuft der Prompt durch. Das Zeitlimit liegt bei zwei Sekunden.
- **Kein Netzaufruf je Prompt:** Eine Marke in `~/.cache/seatmeter` (bzw. `$XDG_CACHE_HOME`) hält „zugeordnet“ einen Tag und „nicht erzwungen“ sowie „gewarnt“ eine Stunde. Sie gilt je Token, zwei Organisationen im selben Repo stören sich nicht. Ist der Cache-Ordner nicht beschreibbar, dient `$TMPDIR/seatmeter-<uid>`. Geht auch das nicht, zeigt die Stufe `warnen` nichts an, statt bei jedem Prompt zu warnen; `blockieren` wirkt unverändert.
- **Die Prüf-Route schreibt nichts:** Wer das Mandanten-Token hat, kann darüber keine Zeilen anlegen. Die normalisierte URL steht signiert im Link, das Repo entsteht in seatmeter erst bei der Wahl oder der ersten Nutzung.
- **Nutzung außerhalb des Abos** (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, abweichende `ANTHROPIC_BASE_URL`) zählt seatmeter nicht; der Hook lässt sie sofort durch, ohne etwas zu senden.
- **Nicht interaktive Läufe** (`claude -p`, Agent SDK) werden nicht blockiert; ihre Nutzung im Repo ist nach der Zuordnung trotzdem richtig gebucht. Das erkennt der Hook an `CLAUDE_CODE_ENTRYPOINT` (`sdk-…`). Diese Variable ist in der Dokumentation von Claude Code nicht beschrieben, geprüft mit Version 2.1.316. Fehlt sie, gilt der Lauf als interaktiv: `claude -p` endet dann mit der Meldung, statt zu hängen.
- Verwaltete Hooks lassen sich in den eigenen Einstellungen nicht abschalten. Ein veränderter Client oder eine gesetzte Marke umgeht den Hook trotzdem: Er sorgt für saubere Daten, er ist keine Sicherheitsgrenze.
- **Rechner:** Der Hook ist ein bash-Skript ohne weitere Abhängigkeiten außer `curl` und `git`. Geprüft auf macOS (bash 3.2, echtes Claude Code) und Linux (bash 5). WSL und Windows mit Git Bash sollten genauso laufen, sind aber noch nicht geprüft; ohne Git Bash wählt Claude Code auf Windows PowerShell, dafür ist der Hook nicht gebaut. Testen Sie Windows vor dem Einschalten auf einem Rechner.

## 6. Kosten ansehen

**Auswertung → Projektkosten** zeigt je Projekt Tokens und Schattenpreis, aufklappbar je Repo, dazu die Sitzungen ohne Repo. Darunter steht, was noch keinem Projekt zugeordnet ist. CSV-Export über den Knopf am Seitenende; das Offene steht dort ohne Projektnummer und die Beträge haben sechs Nachkommastellen, damit die Datei genau die Summe der Seite ergibt. Mandanten-Admin, Controller und Projektleitung (nur eigene Repos, ohne Sitzungen ohne Repo).

Die Seite **Projekte** zeigt für zugeordnete Repos Nummer, Name und Kunde aus dem Katalog; die Repo-URL bleibt sichtbar. Budgets und Projektpreise rechnen weiter je Repo. Nutzung aus Ordnern ohne Repo steht dort unter „unzugeordnet“, auch wenn sie über die Sitzung einem Projekt zugerechnet ist.

## Ohne Agent

Quelle A allein reicht für die Zuordnung je Repo. Das kostet:

| Ohne Agent | Folge |
|---|---|
| Gemeinsames Mandanten-Token in den verwalteten Einstellungen | Alle Beschäftigten können es lesen und damit Nutzung melden. Bei Verdacht unter „Tokens und Orgs“ widerrufen und neu verteilen. |
| Keine Aufteilung der Cache-Schreibvorgänge in 5 min/1 h | Es gilt die Annahme aus `cache_write_annahme`, die Schattenpreise sind dort weniger genau. |
| Verlorene OTel-Exporte werden nicht nachgeholt | Fällt der Export aus, fehlt diese Nutzung. |
| Kein Issue-Schlüssel aus dem Branch | Die Jira-Kosten je Issue fehlen; die Zuordnung Repo → Jira-Projekt funktioniert. |

## Datenschutz

Der Katalog enthält IDs, Projektnummern, Namen, Status und Kunden, keine Personen. Die Zuordnung hängt am Repo. Bei der Wahl über den Link speichert seatmeter nicht, welches Konto gewählt hat; das Audit nennt nur Repo und Projekt. Damit sich das nicht über die Uhrzeit erschließen lässt, schreibt seatmeter für Konten, die nur die Rolle `entwickler` haben, keinen Anmelde-Eintrag ins Audit und keine letzte Anmeldung in die Kontenliste; auch Anlegen und Rollenvergabe bei der ersten SSO-Anmeldung stehen ohne Konto im Audit. Das Anmeldeprotokoll dafür führt Ihr Identitätsanbieter. **Grenze:** Handlungen eines Admins bleiben mit Konto im Audit, weil er sie offen vornimmt, also das Anlegen einer Einladung und eine von Hand vergebene Rolle. In einem kleinen Mandanten kann der zeitliche Abstand zwischen einer solchen Einladung und einer späteren Wahl darum einen Rückschluss auf die wählende Person erlauben. Über SSO angelegte Konten betrifft das nicht. Prüfen Sie, ob Kundennamen im Dashboard für alle Rollen sichtbar sein dürfen, die die Seite „Projekte“ sehen. Die Sitzungs-ID der Wahl ohne Repo wird gelöscht, sobald auch die letzte Anfrage dieser Sitzung die Frist für Einzelanfragen überschritten hat.
