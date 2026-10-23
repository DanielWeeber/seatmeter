# Modul `konten`

Bis 2026-10-24 ein ee-Modul, seitdem Kern ohne Lizenzprüfung (Entscheidung vom 2026-10-23). Die Routen der Mandantenverwaltung liegen unter `/api/v1/mandant/…` und wirken auf den aktiven Mandanten der Sitzung oder mit `?mandant=<id>` auf einen anderen, den das Konto verwalten darf (Mandanten-Admin dort; mit ee auch Plattform-Admins, `AuthErweiterung.mandantVerwalten`). Kontenkontingent und Plattform-Admins kommen aus der Mandantenfähigkeit (ee) über `mandant/verwaltung.ts`; ohne Plugin gibt es beides nicht.

Tabellen (Migration 0023, bis 2026-10-24 ee-Migration 0004; RLS): `mandant_domain` (`domain` Primärschlüssel = serverweit eindeutig, klein/IDNA, `verifiziert`, `verifizierungs_token`, `verifiziert_am`, `quelle` dns/plattform_admin) und `konto_einladung` (`mandant_id`, `benutzer_id`, `token_sha256`, `laeuft_ab`). Kern-Migration 0019: `mandant.konten_max`, `benutzer.zuletzt_angemeldet`. Mandantenfrei (Eigentümer-Verbindung, nur Zuordnung) gelesen werden nur verifizierte Domain → Mandant, Einladungs-Token → Konto und die IDs der Mandanten mit eigenem Anmeldedienst.

| Route | Wer | Inhalt |
|---|---|---|
| `GET/POST /api/v1/mandant/domains`, `DELETE …/:domain` | Mandanten-Admin, Plattform-Admin (ee) | Liste mit `txt_name`/`txt_wert`; neu `{ domain }`: 409 `domain_vergeben`, 400 `domain_oeffentlich`/`domain_ungueltig` |
| `POST …/domains/:domain/pruefen` | wie oben | DNS-TXT `_seatmeter.<domain>` = `seatmeter-verifizierung=<token>` (`node:dns`, 3 s je Versuch, insgesamt höchstens 8 s): `{ verifiziert, fehler, domain }` |
| `PUT …/domains/:domain` | nur Plattform-Admin (ee) | `{ verifiziert }` direkt setzen (`quelle = plattform_admin`) |
| `GET /api/v1/mandant/konten` | Mandanten-Admin, Plattform-Admin (ee) | `{ konten: [{ id, benutzername, login, rollen[{rolle, projekt_ids, quelle}], deaktiviert, zuletzt_angemeldet, einladung_offen, einladung_bis, plattform_admin }], kontingent: { belegt, max } }` |
| `POST …/konten` | wie oben | `{ benutzername (E-Mail), rollen[], projekt_ids? }`: neues Konto ohne Passwort + `einladung: { url: /einladung/<token>, gueltig_bis }` (nur in dieser Antwort, 7 Tage); vorhandenes Konto bekommt nur die Rollen (`einladung: null`); 409 `konten_kontingent`, `konto_gesperrt` |
| `POST …/konten/:benutzerId/einladung` | wie oben | neuer Link für eine noch nicht angenommene Einladung dieses Mandanten |
| `PUT …/konten/:benutzerId` | wie oben | `{ rollen?, projekt_ids?, deaktiviert? }`; Deaktivieren sperrt das Konto und beendet alle Sitzungen; 409 `letzter_admin` (letzter aktiver Mandanten-Admin, eigenes Konto), `konto_mehrere_mandanten` (Mandanten-Admin deaktiviert Konto mit weiteren Mandanten), `konten_kontingent` (Reaktivierung); Plattform-Admins nur durch Plattform-Admins |
| `DELETE …/konten/:benutzerId/rollen` | wie oben | alle Rollen (und offene Einladung) im Mandanten entziehen; 409 `letzter_admin` |
| `POST /api/v1/auth/einladung/pruefen` | öffentlich | `{ token }` → `{ benutzername, gueltig_bis }`, 404 `einladung_ungueltig` |
| `POST /api/v1/auth/einladung` | öffentlich | `{ token, passwort (≥ 12) }`: setzt einmalig das Passwort, löscht die Einladung, Sitzung im einladenden Mandanten, Antwort wie `/auth/me` |

- **Kontenkontingent** (ee, `mandant.konten_max`, Haken `AuthErweiterung.kontingentPruefen`/`kontingentStand`): aktive Konten mit mindestens einer Rolle im Mandanten, ohne Plattform-Admins; geprüft unter einer Sperre je Mandant, bevor ein Konto seine erste Rolle bekommt: Einladung, Rollenvergabe (`/rollen`, `/konten`), Reaktivierung, SSO-Erstanmeldung, SCIM, Header-Modus. Ohne ee meldet `kontingent` `{ belegt, max: null }` und lässt alles zu.
- Einladungslinks stehen nie im Server-Log (der Kern kürzt `/einladung/<token>` im Request-Log); Fehlversuche beim Annehmen je Adresse 20 in 15 Minuten.
- Audit (im Mandanten): OIDC-Konfiguration geändert/entfernt/geprüft, Domain hinzugefügt/entfernt/verifiziert, Konto angelegt/eingeladen/deaktiviert/aktiviert, Einladung angenommen, Rolle zugewiesen/entzogen.
