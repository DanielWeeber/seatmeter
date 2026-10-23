# Modul `auth`

Dashboard-Anmeldung der Free-Edition (Architektur §6). OIDC (global und je Mandant) steht seit 2026-10-24 im Kern-Modul `oidc` (`AuthProvider` mit Anmeldeknopf und Anmeldeziel).

## Routen

| Route | Inhalt |
|---|---|
| `POST /api/v1/auth/setup` | nur solange kein `benutzer` existiert: `{ setup_token, benutzername, passwort (≥ 12), mandant?: { name, slug } }`; legt Admin (argon2id), Rolle `mandanten_admin` und – falls noch keiner existiert – den Mandanten mit verschlüsselten Salts an; 409 danach |
| `GET /api/v1/auth/setup` | `{ noetig }`: Einrichtung noch offen? |
| `POST /api/v1/auth/login` | `{ benutzername, passwort }`; 5 Fehlversuche je Benutzername bzw. 30 je Adresse in 15 min → 429 (`Retry-After`) |
| `POST /api/v1/auth/logout` | Sitzung löschen (CSRF) |
| `GET /api/v1/auth/me` | `AuthMe`: Benutzer, aktiver Mandant, Rollen, Mandantenliste, `provider`, `csrf`; mit ee zusätzlich `ee` (Lizenzstatus) und `plattform_admin` |
| `GET /api/v1/auth/anbieter` | `AuthAnbieter`: Formular `lokal` plus Knöpfe der Plugin-Provider mit `anmeldeLink` (ee: OIDC) |
| `GET /api/v1/auth/mandant` | Einstellungen des aktiven Mandanten (lesend) |
| `POST /api/v1/auth/mandant` | `{ mandant_id }`, nur Mandanten mit eigener Rolle (CSRF, Audit) |

Eingabe-Aliasse für den Web-Client: `login` = `benutzername`, `token` = `setup_token`.

Einrichtungs-Token: Ist `benutzer` beim Start leer, erzeugt der Server ein Token und schreibt es einmal ins Log (`einrichtungs_token`); alternativ `SEATMETER_SETUP_TOKEN` vorgeben.

## Sitzung und CSRF

Cookie `seatmeter_sitzung` (Zufallstoken, HttpOnly, SameSite=Lax, `Secure` bei https-`SEATMETER_PUBLIC_URL`, Lebensdauer `SEATMETER_SITZUNG_STUNDEN`, Standard 12); in `benutzer_sitzung` liegt nur der SHA-256 samt aktivem Mandanten. Zustandsändernde Anfragen brauchen den Header `X-Seatmeter-CSRF` mit dem Wert aus dem Cookie `seatmeter_csrf` (nicht HttpOnly) bzw. `csrf` aus `/me`.

## Fehlerformat

Abweisungen kommen als `{ fehler, code }` (Codes in `@seatmeter/shared`, `fehler.ts`; der Text kann sich ändern, der Code nicht): 401 `nicht_angemeldet`, 403 `csrf` (CSRF-Header fehlt oder passt nicht; der Web-Client holt `csrf` aus `/me` und versucht es einmal neu), 403 `kein_mandant`, 403 `rolle_fehlt` (`requireRolle`). Linie für fehlende Rechte: Ist die ganze Ressource gesperrt, antwortet die Route mit 403 `rolle_fehlt` (z. B. `/api/v1/personen` ohne Personensicht); gesperrte Felder innerhalb einer erlaubten Ressource kommen als `null` mit Hinweisfeld (z. B. `personen: null` + `personen_hinweis` in `/api/v1/projekte/:id`).

## Für andere Module

`requireAnmeldung` (angemeldet), `requireBenutzer` (mit aktivem Mandanten), `requireRolle('mandanten_admin' | 'projektleiter' | 'controller' | 'betriebsrat', …)` als preHandler; danach `benutzerVon(request)` → `{ benutzerId, mandantId, rollen, projektIds }` (`projektIds` nur bei reinen Projektleitern, sonst `null` = alle). Provider `lokalerAuthProvider` erfüllt die Schnittstelle `AuthProvider`; Plugin-Provider (ee) werden nach Cookie und Header-Modus gefragt.

Erweiterungspunkte für Plugins (`plugin.ts`): `AuthProvider.anmeldeLink` (Knopf auf der Anmeldeseite; OIDC legt nach dem Rückruf mit `erstelleSitzung(…, 'oidc')` eine normale Sitzung an), `SeatmeterPlugin.auth` (`AuthErweiterung`: `zusatzRollen` für Mandantenwahl, Sitzung und `/me` – ee: Plattform-Admin sieht jeden Mandanten als `controller`; `me` für Zusatzfelder in `/me`; seit 2026-10-24 außerdem `kontingentPruefen`/`kontingentStand` für das Kontenkontingent, `plattformAdmins`, `mandantVerwalten` und `plattformAdminAbgleichen` für die Mandantenverwaltung, siehe `mandant/README.md`) und `SeatmeterPlugin.migrationen` (eigene Protokolltabelle `kysely_migration_<name>`, ausgeführt von `migrierePlugins` in `main.ts`). `alleRollen(zustand, benutzerId)` = `rolle` plus Plugin-Rollen. `rolle.quelle` (`manuell`, `oidc`) und `benutzer_sitzung.quelle = 'oidc'` kommen aus Migration 0013.

## Header-Modus hinter Authelia (Pilot)

`SEATMETER_TRUST_REMOTE_USER_HEADER=Remote-Email` meldet den Benutzer an, dessen Benutzername dem Header entspricht, und legt ihn beim ersten Mal an (ohne Passwort, Rolle `SEATMETER_AUTO_ROLLE`, Standard `mandanten_admin`, im Mandanten mit slug `SEATMETER_AUTO_MANDANT`, ohne Angabe im einzigen Mandanten). Kommt eine Anfrage ohne gültiges Sitzungs-Cookie (curl, Monitoring), nutzt der Server die jüngste noch gültige Sitzung desselben Benutzers mit Anmeldeart `remote_user` weiter, sofern deren Mandant noch zu seinen Rollen gehört; nur wenn keine passt, entsteht eine neue Sitzung mit Sitzungs-Cookie und Audit-Eintrag „Anmeldung“ (Advisory-Lock je Benutzer gegen Doppelungen bei gleichzeitigen Anfragen). Bei der Weiterverwendung setzt der Server nur das CSRF-Cookie, weil vom Sitzungs-Token nur der SHA-256 vorliegt. **Nur hinter einem vertrauenswürdigen Proxy einschalten, der den Header von Clients entfernt** (Caddy `forward_auth` mit `copy_headers Remote-Email`; die Ingest-Pfade ohne `forward_auth` müssen `Remote-*` löschen). Sonst kann jeder Client sich als beliebiger Benutzer ausgeben.
