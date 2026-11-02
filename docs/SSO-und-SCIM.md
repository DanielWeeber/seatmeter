# SSO und SCIM je Mandant

Stand 2026-10-24. SSO, Domains, Konten und SCIM gehören zum Kern (Apache-2.0) und brauchen keine Lizenz. Nur das Kontenkontingent und der Plattform-Admin gehören zur Mandantenfähigkeit (ee).

Jeder Mandant (Organisation mit Vertrag) richtet seinen eigenen Anmeldedienst ein. Es gibt **einen Host** für alle Mandanten: Die Anmeldeseite fragt zuerst die E-Mail-Adresse; gehört deren Domain verifiziert zu einem Mandanten, führt „Weiter zu <Bezeichnung>“ zum Anmeldedienst dieses Mandanten. Alternativ meldet man sich über das **Mandanten-Kürzel** (Slug) an. Subdomains je Mandant gibt es nicht. Der globale Anbieter des Betreibers (`SEATMETER_OIDC_*`, siehe `packages/server/src/oidc/README.md`) bleibt daneben bestehen.

Eingerichtet wird alles im Dashboard unter **Einrichtung → SSO und Konten** (nur Mandanten-Admins; mit der Mandantenfähigkeit (ee) sieht der Plattform-Admin dieselbe Seite für jeden Mandanten). Die API dazu liegt unter `/api/v1/mandant/…` (z. B. `/api/v1/mandant/oidc`, `/api/v1/mandant/domains`, `/api/v1/mandant/konten`, `/api/v1/mandant/scim-tokens`).

## Anmeldung über die Serverkonfiguration

Ist OIDC über `SEATMETER_OIDC_*` eingerichtet, zeigt **Einrichtung → SSO und Konten** das lesend an: Bezeichnung, Issuer, Client-ID, Scopes, Redirect-URI und die Gruppen, die laut `SEATMETER_OIDC_GRUPPEN` auf diesen Mandanten zeigen. Das Client-Secret steht nirgends, Zuordnungen anderer Mandanten und `plattform_admin` auch nicht. Ändern lässt sich das nur in den Einstellungen des Servers.

- **Keine Gruppe für diesen Mandanten:** Die Seite sagt es. Über diese Anmeldung bekommt dann niemand eine Rolle; Rollen vergeben Sie unter „Konten“.
- **Das reicht meist:** Eine eigene Anbindung ist nicht nötig, wenn dieser Anbieter passt. Das Formular dafür ist darum zugeklappt.

Was eine **eigene Anbindung daneben** ändert:

- **Anmeldeseite:** Der Knopf „Mit <Bezeichnung> anmelden“ der Serverkonfiguration bleibt. Wer eine verifizierte E-Mail-Domain dieses Mandanten oder sein Kürzel eingibt, kommt zur eigenen Anbindung. Eine inaktive Anbindung ändert nichts.
- **Konten:** Mit einem anderen Issuer entsteht über die eigene Anbindung ein eigenes Konto, auch bei gleicher E-Mail-Adresse (Anmeldename `oidc:<slug>:<sub>`), ohne die bisherigen Rollen. Das alte Konto bleibt mit seinen Rollen bestehen. Mit demselben Issuer bleibt es ein Konto, und sind bei der eigenen Anbindung Gruppen eingetragen, gleichen sie seine OIDC-Rollen ab, auch solche aus der Serverkonfiguration.
- **Rollen aus der Serverkonfiguration:** Solange die eigene Anbindung aktiv ist, entzieht eine Anmeldung über die Serverkonfiguration in diesem Mandanten keine Rolle mehr, wenn keine Gruppe des Kontos mehr auf ihn zeigt. Das müssen Sie dann unter „Konten“ tun. Zeigt noch eine Gruppe auf den Mandanten, wird wie sonst abgeglichen.
- **Abmelden:** Es folgt dem Anmeldedienst des Kontos: Ein Konto der Serverkonfiguration meldet sich dort ab, auch wenn der Mandant eine eigene Anbindung hat.

## Teil 1: OIDC je Mandant

### Ablauf

1. Beim Anmeldedienst (IdP) eine Web-Anwendung (Confidential Client, Authorization Code mit PKCE) anlegen.
2. **Redirect-URI** eintragen. Sie steht auf der Seite „SSO und Konten“ zum Kopieren und ist für alle Mandanten gleich: `https://<seatmeter-host>/api/v1/auth/oidc/callback`.
3. In seatmeter Issuer-URL, Client-ID, Client-Secret, Bezeichnung (Knopftext „Weiter zu <Bezeichnung>“) und Scopes (Standard `openid profile email groups`) speichern. Das Secret wird verschlüsselt gespeichert und nie wieder angezeigt; leer lassen = behalten.
4. „Verbindung prüfen“ ruft die Discovery (`<issuer>/.well-known/openid-configuration`) ab und zeigt die Endpunkte.
5. „Testanmeldung“ startet eine echte Anmeldung über den Anmeldedienst und kehrt auf die Seite zurück.
6. Optional **Gruppen → Rollen**: `{ "<gruppe>": "<rolle>" | ["<rolle>", …] }` mit den Rollen `mandanten_admin`, `projektleiter`, `controller`, `betriebsrat`, `entwickler` (nur Projektwahl, keine Auswertung; `docs/Projektkatalog.md`). Rollen aus Gruppen tragen die Herkunft `oidc` und werden beim nächsten Login ohne die Gruppe wieder entzogen; manuell vergebene Rollen bleiben. Ohne Zuordnung vergibt der Login keine Rollen (Rollen dann über „Konten“).
7. E-Mail-Domain hinzufügen und verifizieren (siehe unten), damit die Anmeldeseite die Domain erkennt.

### Konten bei der Anmeldung

- Zuerst über das Paar (Issuer, Subjekt `sub`): Dasselbe `sub` bei zwei Anmeldediensten sind zwei Konten.
- Sonst über die E-Mail-Adresse (Anmeldename), wenn `email_verified` nicht `false` ist und entweder `true` ist oder die Domain im Mandanten verifiziert ist. Übernommen wird ein vorhandenes Konto nur, wenn es noch mit keinem Anmeldedienst verknüpft ist und keine Rollen in anderen Mandanten hat (so wird z. B. ein eingeladenes Konto verknüpft, nie ein fremdes).
- Sonst entsteht ein neues Konto (Anmeldename = E-Mail, falls frei, sonst `oidc:<slug>:<sub>`).
- Nach dem Login ist der aktive Mandant der Mandant des Anmeldedienstes.
- Ist das **Kontenkontingent** ausgeschöpft und bekäme das Konto seine erste Rolle im Mandanten, zeigt seatmeter eine Seite „Anmeldung nicht möglich“ (403 `konten_kontingent`).

### Entra ID (Microsoft)

- Microsoft Entra Admin Center → Anwendungen → App-Registrierungen → Neue Registrierung, Kontotyp „Nur Konten in diesem Organisationsverzeichnis“, Umleitungs-URI Typ „Web“ = Redirect-URI von oben.
- Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel; der **Wert** ist das Client-Secret (Ablaufdatum notieren).
- Issuer: `https://login.microsoftonline.com/<Mandanten-ID>/v2.0`; Client-ID = Anwendungs-ID (Client).
- Token-Konfiguration → Gruppenanspruch hinzufügen („Sicherheitsgruppen“, ID-Token). Entra liefert **Objekt-IDs** der Gruppen (GUIDs); diese als Schlüssel in „Gruppen → Rollen“ eintragen. Optionalen Anspruch `email` hinzufügen, falls die Benutzer keine E-Mail im Token haben. Entra sendet meist kein `email_verified`; die E-Mail-Verknüpfung braucht dann eine verifizierte Domain.
- Bei mehr als 200 Gruppen schickt Entra statt der Liste einen Verweis (Gruppenüberschreitung); dann „Gruppen, die der Anwendung zugewiesen sind“ wählen.

### Okta

- Admin Console → Applications → Create App Integration → OIDC, Web Application; Sign-in redirect URI = Redirect-URI von oben; Grant Type Authorization Code.
- Issuer: `https://<org>.okta.com/oauth2/default` (Custom Authorization Server) oder `https://<org>.okta.com` (Org-Server).
- Gruppen: Sign On → OpenID Connect ID Token → Groups claim type „Filter“, Name `groups`, z. B. „Starts with: seatmeter-“. Beim Custom Authorization Server zusätzlich einen Claim `groups` im ID-Token anlegen.

### Keycloak

- Realm → Clients → Create client, OpenID Connect, Client authentication an, Standard flow; Valid redirect URIs = Redirect-URI von oben.
- Issuer: `https://<keycloak>/realms/<realm>`; Secret unter Credentials.
- Gruppen: Client scopes → `<client>-dedicated` → Add mapper „Group Membership“, Token Claim Name `groups`, „Full group path“ aus (sonst heißen die Gruppen `/name`).

### Authelia

- In `identity_providers.oidc.clients` einen Client mit `client_id`, gehashtem `client_secret`, `redirect_uris: [<Redirect-URI>]`, `scopes: [openid, profile, email, groups]`, `authorization_policy`, `pkce_challenge_method: S256` und `token_endpoint_auth_method: client_secret_basic` anlegen.
- Issuer = öffentliche URL von Authelia (z. B. `https://auth.example.org`). Gruppen kommen im Claim `groups` (bei Authelia 4.39 über Userinfo, seatmeter holt sie dort nach).

## Domain-Verifizierung

- Domain hinzufügen (klein, Umlautdomains werden in Punycode gespeichert). Jede Domain gehört serverweit zu genau einem Mandanten (409 `domain_vergeben`); öffentliche E-Mail-Anbieter (gmail.com, outlook.com, gmx.de, web.de, yahoo.com, icloud.com, hotmail.com, t-online.de u. ä.) sind ausgeschlossen.
- Beim DNS-Anbieter einen **TXT-Eintrag** anlegen: Name `_seatmeter.<domain>`, Wert `seatmeter-verifizierung=<token>` (beides steht auf der Seite zum Kopieren). Danach „Jetzt prüfen“; seatmeter fragt das DNS mit kurzem Timeout ab.
- Alternativ verifiziert der Plattform-Admin (ee) eine Domain direkt (Mandant-Detail im Plattform-Bereich), z. B. wenn der Vertrag die Domain nennt. Beides steht im Audit.
- Erst eine verifizierte Domain führt auf der Anmeldeseite zum Anmeldedienst. Die Anmeldeseite verrät nur Domain → Mandant, nie, ob ein Konto existiert; Abfragen sind je Adresse begrenzt.

## Konten und Kontingent

- **Kontenkontingent (ee):** Der Plattform-Admin setzt je Mandant eine Höchstzahl Dashboard-Konten (Mandant-Detail, leer = unbegrenzt). Ohne ee gibt es kein Kontingent. Gezählt werden aktive Konten mit mindestens einer Rolle im Mandanten; Plattform-Admins zählen nicht. Geprüft wird bei Einladung, Rollenvergabe an ein Konto ohne Rolle im Mandanten, Reaktivierung, SSO-Erstanmeldung und SCIM. Die Seite zeigt „Konten: n von m“.
- **Einladen:** E-Mail-Adresse und Rolle(n) eingeben. Für ein neues Konto erscheint einmalig ein Einladungslink (`/einladung/<token>`, 7 Tage gültig); damit setzt die Person ihr Passwort und ist angemeldet. Bis dahin ist das Konto nicht anmeldbar. Mit verifizierter Domain und eigenem Anmeldedienst kann die Person sich stattdessen gleich per SSO anmelden; das Konto wird dann verknüpft. Ein schon vorhandenes Konto bekommt nur die Rolle (kein Link).
- **Ändern:** Rollen setzen, Konto deaktivieren (beendet alle Sitzungen) oder wieder aktivieren, alle Rollen im Mandanten entziehen. Der letzte aktive Mandanten-Admin bleibt (409 `letzter_admin`), niemand deaktiviert sich selbst, und Konten mit Rollen in weiteren Mandanten deaktiviert nur der Plattform-Admin (Mandanten-Admins entziehen stattdessen die Rollen).

## Teil 2: SCIM 2.0 (Benutzer-Synchronisation)

seatmeter bietet je Mandant einen SCIM-2.0-Endpunkt (RFC 7643/7644) für Users und Groups. Der Anmeldedienst legt darüber Konten an, sperrt sie und pflegt Gruppenmitgliedschaften; Rollen kommen aus derselben Zuordnung **Gruppen → Rollen** wie beim OIDC-Login (Schlüssel = Gruppenname `displayName` oder `externalId`, z. B. die Objekt-ID der Entra-Gruppe). Rollen aus SCIM tragen die Herkunft `scim`; manuell vergebene Rollen bleiben.

### Einrichtung in seatmeter

1. Einrichtung → SSO und Konten → Abschnitt SCIM: **Basis-URL** kopieren (`https://<seatmeter-host>/scim/v2`).
2. „Token erzeugen“ (Bezeichnung z. B. „Entra ID“): Das Token (`sms_…`) erscheint genau einmal; direkt im Anmeldedienst eintragen. Widerrufen beendet den Zugang sofort.
3. Gruppen → Rollen im OIDC-Abschnitt pflegen. Eine Änderung der Zuordnung gleicht die SCIM-Rollen sofort neu ab.
4. Die Seite zeigt die letzte Synchronisation (letzte Nutzung eines Tokens) und die Zahl der synchronisierten Konten und Gruppen.

### Verhalten

- **Konten:** `userName` wird zum Anmeldenamen (klein); gespeichert werden nur `userName`, `externalId` und `active`. Namen, Telefonnummern, Abteilung, Passwörter u. ä. nimmt seatmeter an und verwirft sie (Datensparsamkeit). Zuordnung vorhandener Konten über `externalId`, sonst `userName`; Konten, die schon Rollen in anderen Mandanten haben, kann SCIM nicht übernehmen (409 `uniqueness`).
- **Anmeldung:** SCIM-Konten haben kein Passwort; sie melden sich über den Anmeldedienst des Mandanten an (OIDC, Teil 1). Die erste Anmeldung verknüpft das Konto über die E-Mail-Adresse.
- **Deaktivieren** (`active: false`, auch als Zeichenkette `"False"`): Das Konto wird gesperrt und alle Sitzungen enden. Hat das Konto Rollen in weiteren Mandanten, verliert es stattdessen nur seine Rollen und Sitzungen in diesem Mandanten. `active: true` hebt die Sperre auf und stellt die SCIM-Rollen wieder her.
- **Löschen** (`DELETE /Users/<id>`): entfernt Rollen und Gruppenmitgliedschaften im Mandanten und sperrt das Konto; gelöscht wird es nicht (Audit, Berichte).
- **Kontenkontingent:** Ist es ausgeschöpft, antworten Anlegen und Gruppenänderungen, die einem Konto die erste Rolle gäben, mit 409, `scimType: "tooMany"` und `detail` „konten_kontingent: …“. Der Anmeldedienst meldet den Fehler im Provisioning-Protokoll.
- **Grenzen:** je Token 600 Anfragen pro Minute (Stoß 300), danach 429 mit `Retry-After`; Listen höchstens 200 Einträge je Seite (`startIndex`, `count`); Filter mit `eq`, `ne`, `co`, `sw`, `ew`, `pr`, `and`, `or`, `not` und Wertpfaden; kein Bulk, kein Sortieren, keine ETags.

### Entra ID (Microsoft)

- Unternehmensanwendungen → die seatmeter-Anwendung (oder „Eigene Anwendung erstellen“ → „Nicht-Katalog-Anwendung“) → Bereitstellung → Modus „Automatisch“.
- **Mandanten-URL** = Basis-URL von oben, **Geheimes Token** = SCIM-Token. „Verbindung testen“.
- Zuordnungen → „Microsoft Entra ID-Benutzer bereitstellen“: `userPrincipalName` (oder `mail`) → `userName`, `Switch([IsSoftDeleted], , "False", "True", "True", "False")` → `active`, `objectId` → `externalId`. Übrige Zuordnungen (Namen, Telefon, Abteilung, Manager) entfernen: seatmeter speichert sie nicht, Entra würde sie sonst in jedem Zyklus erneut senden.
- „Microsoft Entra ID-Gruppen bereitstellen“: `displayName` → `displayName`, `objectId` → `externalId`, `members` → `members`.
- Benutzer und Gruppen zuweisen (Bereich „Nur zugewiesene Benutzer und Gruppen“), Bereitstellungsstatus „Ein“. Entra synchronisiert etwa alle 40 Minuten; „Bei Bedarf bereitstellen“ für einen Test.
- Entra sucht vor dem Anlegen mit `filter=userName eq "…"`, setzt `active` per PATCH mit `"False"`/`"True"` und pflegt Mitglieder per PATCH `Add`/`Remove members` – alles unterstützt.

### Okta

- Applications → seatmeter-App → General → Provisioning: „SCIM“ aktivieren.
- Provisioning → Integration: **SCIM connector base URL** = Basis-URL, **Unique identifier field for users** = `userName`, Supported provisioning actions: Push New Users, Push Profile Updates, Push Groups, **Authentication Mode** = HTTP Header, Bearer = SCIM-Token. „Test Connector Configuration“.
- Provisioning → To App: Create Users, Update User Attributes, Deactivate Users aktivieren. Attributzuordnung: `userName` aus `user.email` (oder Okta-Benutzername); weitere Attribute sind optional (werden verworfen).
- Push Groups: Gruppen wählen, deren Namen in der Zuordnung Gruppen → Rollen stehen (z. B. `seatmeter-admins`). Okta nutzt PUT für Profiländerungen und PATCH `replace` (`{"active": false}`) zum Deaktivieren – beides unterstützt.
