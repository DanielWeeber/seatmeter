# Modul `scim`

Bis 2026-10-24 ein ee-Modul, seitdem Kern ohne Lizenzprüfung (Entscheidung vom 2026-10-23). Die Routen der Mandantenverwaltung liegen unter `/api/v1/mandant/…` und wirken auf den aktiven Mandanten der Sitzung oder mit `?mandant=<id>` auf einen anderen, den das Konto verwalten darf (Mandanten-Admin dort; mit ee auch Plattform-Admins, `AuthErweiterung.mandantVerwalten`). Kontenkontingent und Plattform-Admins kommen aus der Mandantenfähigkeit (ee) über `mandant/verwaltung.ts`; ohne Plugin gibt es beides nicht.

SCIM 2.0 (RFC 7643/7644) unter `/scim/v2`, Einrichtung für Kunden: `docs/SSO-und-SCIM.md` Teil 2. Tabellen (Migration 0024, bis 2026-10-24 ee-Migration 0005; RLS): `mandant_scim_token` (`token_sha256`, `praefix`, `bezeichnung`, `zuletzt_genutzt`, `widerrufen`), `scim_konto` (Verknüpfung Konto ↔ Mandant mit `external_id`, `aktiv`), `mandant_scim_gruppe` (`display_name` je Mandant eindeutig ohne Groß-/Kleinschreibung, `external_id`), `mandant_scim_mitglied`. Kern-Migration 0021 erlaubt `rolle.quelle = 'scim'`. Mandantenfrei liest die Eigentümer-Verbindung nur Token-Hash → Mandant.

| Route | Wer | Inhalt |
|---|---|---|
| `GET /api/v1/mandant/scim-tokens` | Mandanten-Admin, Plattform-Admin (ee) | `{ tokens (nur Präfix), basis_url, konten_synchronisiert, gruppen_synchronisiert, letzte_synchronisation }` |
| `POST …/scim-tokens`, `DELETE …/scim-tokens/:tokenId` | wie oben | neu `{ bezeichnung? }` (Klartext `sms_…` nur in dieser Antwort), widerrufen; Audit |
| `GET /scim/v2/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes` | Bearer-Token | feste Beschreibungen (patch, filter bis 200; kein bulk, sort, etag) |
| `GET /scim/v2/Users?filter=&startIndex=&count=`, `GET …/Users/:id` | Bearer-Token | sichtbar: Konten mit `scim_konto` oder Rolle im Mandanten; `id` = `benutzer.id` |
| `POST …/Users`, `PUT …/Users/:id`, `PATCH …/Users/:id` | Bearer-Token | gespeichert nur `userName` (= Anmeldename, klein), `externalId`, `active`; PATCH `add`/`replace`/`remove` (Schreibweise egal), Pfade mit Filter (`emails[type eq "work"].value`), Wertobjekte ohne Pfad, Booleans als `"True"`/`"False"` |
| `DELETE …/Users/:id` | Bearer-Token | deprovisionieren: Rollen, Mitgliedschaften und Verknüpfung im Mandanten weg, Konto gesperrt (nicht gelöscht) |
| `GET/POST /scim/v2/Groups`, `GET/PUT/PATCH/DELETE …/Groups/:id` | Bearer-Token | `displayName`, `externalId`, `members`; `excludedAttributes=members`; PATCH `add`/`remove`/`replace` members, `members[value eq "…"]`, Umbenennen; Antwort 204 |

- **Anmeldung:** `Authorization: Bearer <token>`, Hash-Vergleich gegen `mandant_scim_token` (nicht widerrufen); Fehlversuche je Adresse 30 in 15 Minuten; je Token 600/min, Stoß 300 (`TokenEimer` des Kerns); `zuletzt_genutzt` höchstens einmal je Minute geschrieben.
- **Format:** Anfragen mit `application/scim+json` oder `application/json`, Antworten `application/scim+json`, Fehler `urn:ietf:params:scim:api:messages:2.0:Error` mit `status`, `scimType`, `detail`. Filter-Parser im Modul (`filter.ts`, ohne Abhängigkeit), Auswertung im Speicher je Mandant.
- **Konto-Zuordnung beim Anlegen:** `externalId` vergeben → 409 `uniqueness`; vorhandenes Konto mit gleichem `userName` wird verknüpft, außer es ist schon verknüpft oder hat Rollen in anderen Mandanten bzw. ist Plattform-Admin (409 `uniqueness`); sonst neues Konto (`login = oidc`, ohne Passwort). Konten mit Rolle, aber ohne Verknüpfung, übernimmt SCIM beim ersten Schreiben.
- **active = false:** ohne weitere Mandanten `benutzer.deaktiviert` + alle Sitzungen beendet; mit weiteren Mandanten nur Rollen und Sitzungen dieses Mandanten weg. `userName` von Konten mit weiteren Mandanten ist nicht änderbar (400 `mutability`).
- **Rollen:** je Konto Vereinigung der Rollen seiner Gruppen über `mandant_oidc.gruppen_rollen` (Schlüssel `displayName` oder `externalId`), `quelle = 'scim'`, Abgleich bei jeder Änderung von Mitgliedschaft, Gruppe oder Kontostatus; eine geänderte Zuordnung (PUT/DELETE der OIDC-Konfiguration) gleicht alle SCIM-Rollen neu ab (volles Kontingent: Konto übersprungen).
- **Kontenkontingent (ee):** Anlegen (aktiv) und jede Änderung, die einem Konto die erste Rolle gäbe, prüfen das Kontingent; voll = 409, `scimType: tooMany`, `detail` beginnt mit `konten_kontingent:`; die ganze Anfrage wird zurückgerollt.
- Audit (im Mandanten, Akteur leer): Konto angelegt (SCIM), Konto deaktiviert/aktiviert, Rolle zugewiesen/entzogen (SCIM-Gruppe), SCIM-Gruppe, SCIM-Token erzeugt/widerrufen.
