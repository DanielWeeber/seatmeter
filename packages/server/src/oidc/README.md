# Modul `oidc`

Bis 2026-10-24 ein ee-Modul, seitdem Kern ohne Lizenzprüfung (Entscheidung vom 2026-10-23). Die Routen der Mandantenverwaltung liegen unter `/api/v1/mandant/…` und wirken auf den aktiven Mandanten der Sitzung oder mit `?mandant=<id>` auf einen anderen, den das Konto verwalten darf (Mandanten-Admin dort; mit ee auch Plattform-Admins, `AuthErweiterung.mandantVerwalten`). Kontenkontingent und Plattform-Admins kommen aus der Mandantenfähigkeit (ee) über `mandant/verwaltung.ts`; ohne Plugin gibt es beides nicht. Variablen `SEATMETER_OIDC_*` stehen in der Kern-Konfiguration (`config.ts`).

Authorization Code mit PKCE (S256), `openid-client` 6, Client-Authentifizierung `client_secret_basic`.

| Variable | Inhalt |
|---|---|
| `SEATMETER_OIDC_ISSUER` | Issuer für die Discovery, z. B. `https://auth.example.org` |
| `SEATMETER_OIDC_CLIENT_ID`, `SEATMETER_OIDC_CLIENT_SECRET` | Client-Zugang (Secret nur in `.env`) |
| `SEATMETER_OIDC_REDIRECT_URI` | optional; Standard `SEATMETER_PUBLIC_URL` + `/api/v1/auth/oidc/callback` |
| `SEATMETER_OIDC_SCOPES` | Standard `openid profile email groups` |
| `SEATMETER_OIDC_BEZEICHNUNG` | Knopf „Mit <Bezeichnung> anmelden“, Standard `SSO` |
| `SEATMETER_OIDC_GRUPPEN` | JSON `{ "<gruppe>": { "mandant": "<slug>", "rolle": "<rolle>" } \| { "plattform_admin": true } \| [ … ] }` |
| `SEATMETER_OIDC_PRIVATE_ZIELE` | `1` erlaubt bei OIDC je Mandant auch interne Ziele (Tests, On-Prem); sonst sind private, Loopback-, Link-Local- und Metadaten-Adressen gesperrt (`ziel-schutz.ts`) |

- `GET /api/v1/auth/oidc/start[?ziel=/pfad]`: state, nonce und PKCE-Verifier im verschlüsselten Cookie `seatmeter_oidc` (AES-GCM unter dem Master-Schlüssel, 10 Minuten, Pfad `/api/v1/auth/oidc`), 302 zum Provider.
- `GET /api/v1/auth/oidc/callback`: Token-Tausch mit Prüfung von state, nonce und PKCE; fehlen E-Mail oder Gruppen im ID-Token, kommen sie aus Userinfo. Konto: zuerst über `benutzer.oidc_sub`, sonst über den Anmeldenamen = E-Mail (nur ohne `email_verified = false`; so wird das Konto aus dem Header-Modus übernommen), sonst neu (`login = oidc`). Danach normale Sitzung (`benutzer_sitzung.quelle = 'oidc'`) und 302 ins Dashboard. Fehler: 400 `oidc_zustand`, 401 `oidc_abgelehnt`, 403 `konto_gesperrt`, 502 `oidc_provider`.
- Gruppen → Rollen nur mit `SEATMETER_OIDC_GRUPPEN`: Rollen aus Gruppen tragen `rolle.quelle = 'oidc'` (Kern-Migration 0013) bzw. (mit ee) Plattform-Admin mit `quelle = 'oidc'` über `AuthErweiterung.plattformAdminAbgleichen`; ohne ee bleibt das Ziel `plattform_admin` wirkungslos und werden beim nächsten Login ohne die Gruppe entzogen; manuell vergebene Rollen bleiben. Unbekannte Mandanten-Slugs werden protokolliert und übersprungen.
- `POST /api/v1/auth/oidc/logout`: Sitzung löschen; `{ weiter }` ist die end_session-URL, wenn der Provider eine anbietet (Authelia 4.39: nein).
- Anmeldeseite: `GET /api/v1/auth/anbieter` nennt den Knopf, sobald die Konfiguration vollständig ist. Der Header-Modus des Kerns (Authelia `forward_auth`) bleibt unverändert nutzbar.
- Konten des globalen Anbieters tragen seit Kern-Migration 0019 `benutzer.oidc_issuer` (= `SEATMETER_OIDC_ISSUER`; ältere Konten mit `NULL` bekommen ihn beim nächsten Login). Rollen in Mandanten mit eigenem aktivem Anmeldedienst entzieht der globale Abgleich nicht, solange `SEATMETER_OIDC_GRUPPEN` den Mandanten nicht selbst nennt.

### OIDC je Mandant (SSO je Mandant, Phase 5a)

Einrichtung für Kunden: `docs/SSO-und-SCIM.md`. Tabelle `mandant_oidc` (Migration 0023, bis 2026-10-24 ee-Migration 0004; RLS): `issuer`, `client_id`, `client_secret` (AES-256-GCM unter dem Master-Schlüssel, AAD `mandant_oidc.client_secret`), `scopes`, `bezeichnung`, `gruppen_rollen` (`{ "<gruppe>": ["<rolle>", …] }`), `aktiv`, `zuletzt_geprueft`.

| Route | Wer | Inhalt |
|---|---|---|
| `GET /api/v1/mandant/oidc` | Mandanten-Admin, Plattform-Admin (ee) | `{ konfiguration \| null (mit client_secret_gesetzt, nie das Secret), redirect_uri, start_url }` |
| `PUT …/oidc` | wie GET | `{ issuer (https, http nur Loopback für Tests), client_id, client_secret? (beim ersten Mal Pflicht: 400 client_secret_fehlt), scopes?, bezeichnung, gruppen_rollen?, aktiv? }`; Audit nennt nur geänderte Felder |
| `DELETE …/oidc` | wie GET | entfernt die Konfiguration |
| `POST …/oidc/pruefen` | wie GET | Discovery mit 8 s Timeout: `{ ok, fehler, issuer, endpunkte, geprueft }`, setzt `zuletzt_geprueft` |

- `GET /api/v1/auth/oidc/start?mandant=<slug>`: lädt die aktive Konfiguration, Discovery-Client je Mandant 5 Minuten im Speicher (Änderungen gelten sofort), Mandanten-ID im Zustands-Cookie; Rückruf-URL wie beim globalen Anbieter. Ohne aktive Konfiguration 404 `oidc_aus`.
- Rückruf mit Mandant: Konto über (`oidc_issuer`, `oidc_sub`), sonst über die E-Mail (nicht `email_verified = false`, und `true` oder Domain im Mandanten verifiziert; nur unverknüpfte Konten ohne Rollen in anderen Mandanten), sonst neu (`login = oidc`, Name = E-Mail falls frei, sonst `oidc:<slug>:<sub>`). Gruppen → Rollen nur mit Zuordnung und nur in diesem Mandanten (`quelle = 'oidc'`, Entzug ohne Gruppe). Bekäme das Konto seine erste Rolle und ist das Kontenkontingent (ee) voll: 403 `konten_kontingent`. Aktiver Mandant der Sitzung = dieser Mandant.
- Fehler im Anmeldeablauf antworten Browsern (`Accept: text/html`) mit einer Seite „Anmeldung nicht möglich“ (Code in `data-code`), sonst JSON `{ code, fehler }`.
- Anmeldeseite (Kern-Haken `AuthProvider.anmeldeZiel`): `GET /api/v1/auth/anbieter?email=<adresse>` liefert für eine verifizierte Domain mit aktiver Konfiguration `oidc: { bezeichnung, start_url }`, `?mandant=<slug>` dasselbe über das Kürzel, sonst `oidc: null`. Je Adresse 20 Abfragen auf einmal, danach 30 je Minute (429).
- Abmelden: `end_session` des Anmeldedienstes, über den das Konto angemeldet ist (Issuer des Kontos = Issuer des aktiven Mandanten), sonst des globalen Anbieters.
