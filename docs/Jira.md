# Jira anbinden (ee)

seatmeter zeigt Kosten je Jira-Projekt und je Jira-Issue. Die Zuordnung läuft über den **Issue-Schlüssel**
im Branch-Namen (z. B. `feature/ABC-123-login` → `ABC-123`). seatmeter liest aus Jira nur Projekte, Titel
und Status und **schreibt nichts zurück**. Funktion der ee-Lizenz (Lizenzmodul `abgleich`).

## Was erfasst wird

- **Nur der Schlüssel, nie der Branch-Name.** Der Agent (ab 0.1.3) liest den Branch je Transkriptzeile auf
  dem Rechner, erkennt Schlüssel nach dem Muster `[A-Z][A-Z0-9]+-[0-9]+` (Groß-/Kleinschreibung egal,
  gespeichert groß, höchstens 20 je Anfrage) und sendet nur diese. `ABC-123/ABC-124` ergibt beide
  Schlüssel; die Anfrage zählt dann je zur Hälfte. `release-…`, `hotfix-…`, `bugfix-…`, `feature-…`,
  `fix-…` und `chore-…` zählen nicht als Projekt.
- **Start-Wrapper (Quelle A):** `seatmeter-agent otel-ressource` gibt den Schlüssel des Branches beim
  Sitzungsstart an Claude Code weiter (`OTEL_RESOURCE_ATTRIBUTES`, Attribut `seatmeter.issue_schluessel`).
  Claude Code selbst sendet keinen Branch (geprüft mit Version 2.1.309). Bei verwalteten Einstellungen ohne
  Wrapper kommen die Schlüssel nur vom Agenten.
- **Positivliste:** Mit „Nur Schlüssel zugeordneter Jira-Projekte speichern“ speichert seatmeter nur
  Schlüssel, deren Präfix einem zugeordneten Jira-Projekt entspricht; andere werden schon beim Empfang
  verworfen. Ohne Zuordnung gelten alle erkannten Schlüssel.
- **Rückwirkend:** Anfragen, die vor Agent 0.1.3 gesendet wurden, haben keinen Schlüssel.

## Zugang anlegen (nur lesend)

Empfehlung: ein eigenes Dienstkonto in Jira mit **nur Leserechten** („Browse projects“) auf die Projekte, die
seatmeter auswerten soll. seatmeter braucht keine Schreib- oder Admin-Rechte.

### Jira Cloud: API-Token

1. Mit dem Dienstkonto bei `https://id.atlassian.com/manage-profile/security/api-tokens` anmelden.
2. „API-Token erstellen“, Bezeichnung z. B. „seatmeter“, Ablaufdatum setzen (Atlassian verlangt eines;
   vor Ablauf ein neues Token in seatmeter hinterlegen).
3. In seatmeter unter **Einrichtung → Jira**: Basis-URL `https://<firma>.atlassian.net`, Art „Jira Cloud“,
   E-Mail-Adresse des Dienstkontos und das Token eintragen.

seatmeter meldet sich mit `E-Mail:API-Token` (Basic) an der REST-API v3 an.

### Jira Data Center: Personal Access Token

1. Mit dem Dienstkonto in Jira: Profil → **Personal Access Tokens** → „Token erstellen“ (Jira 8.14 oder
   neuer), Ablaufdatum setzen.
2. In seatmeter: Basis-URL inklusive Kontextpfad (z. B. `https://jira.firma.example/jira`), Art „Jira Data
   Center“, Token eintragen (keine E-Mail nötig).

seatmeter nutzt die REST-API v2 mit `Authorization: Bearer <PAT>`.

### Prüfen

„Verbindung prüfen“ ruft `/rest/api/{3|2}/myself` auf und zeigt den Anzeigenamen des Kontos. Das Token
wird verschlüsselt gespeichert (AES-256-GCM unter dem Master-Schlüssel) und nie angezeigt, auch nicht
in Protokollen.

## Projekte zuordnen

Unter **Einrichtung → Jira → Zuordnung** wählt der Mandanten-Admin je seatmeter-Projekt (Git-Repo) ein
Jira-Projekt aus der Liste, die seatmeter aus Jira lädt. Ein seatmeter-Projekt hat höchstens ein
Jira-Projekt; mehrere Repos dürfen dasselbe Jira-Projekt haben.

## Kosten ansehen

**Auswertung → Jira-Kosten** zeigt je Monat und Jira-Projekt den Schattenpreis und die Tokens, aufklappbar
je Issue mit Titel, Status, Sitzungen und Tokens; CSV-Export für Excel.

- Ein Issue zählt zum Jira-Projekt seines Schlüssels (`ABC-123` → `ABC`), gleich aus welchem Repo.
- Nutzung ohne Schlüssel in einem zugeordneten Repo steht beim zugeordneten Jira-Projekt als „Ohne
  Issue-Schlüssel“.
- Titel und Status lädt seatmeter beim Aufruf nach (höchstens 50 je Aufruf, 24 Stunden zwischengespeichert,
  nach 30 Tagen gelöscht). Fehler beim Nachladen blockieren die Ansicht nicht; offene Titel kommen beim
  nächsten Aufruf.
- Sehen dürfen: Mandanten-Admin, Controller und Projektleiter (nur eigene Projekte). Verbindung und
  Zuordnung nur der Mandanten-Admin. Der Kern zeigt dieselben Issue-Kosten ohne Jira auf der Projektseite
  (Abschnitt „Issues“).

## Grenzen

- Branch-Wechsel mitten in der Sitzung: genau über den Agenten (je Transkriptzeile), über den
  Start-Wrapper nur der Branch beim Start.
- Schlüssel, die es in Jira nicht gibt, erscheinen mit „in Jira nicht gefunden“ (z. B. `V2-1` aus einem
  Branch ohne Issue). Die Positivliste vermeidet solche Einträge.
- Sitzungen eines Issues über mehrere Repos werden je Repo gezählt und addiert.
- Ziele im internen Netz (private Adressen, `localhost`) und `http://` sind gesperrt; bei Selbstbetrieb mit
  einem Jira im Firmennetz schaltet `SEATMETER_JIRA_INTERN_ERLAUBT=1` das frei. Weiterleitungen folgt
  seatmeter nicht; Zeitlimit 10 Sekunden je Aufruf.
