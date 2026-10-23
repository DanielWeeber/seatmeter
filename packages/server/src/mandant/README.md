# Modul `mandant`

Einstellungen des aktiven Mandanten (Architektur §3.1 `mandant`, §5, §7) und die Selbstverwaltung des Mandanten (`verwaltung.ts`, `verwaltung-routen.ts`; bis 2026-10-24 ee). Mandant aus der Sitzung, RLS über `withMandant`.

| Route | Rollen | Inhalt |
|---|---|---|
| `GET /api/v1/mandant/einstellungen` | alle | `MandantEinstellungen` aus `@seatmeter/shared`: `zeitzone`, `waehrung` (EUR, USD), `sitzkosten_verteilung` (person, gleich, pool), `code_anteil_sitz` (0–1), `schatten_faktor` (0–10), `cache_write_annahme` (5m, 1h), `auswertungsstufe` (0–3), `klarnamen_aktiv`, `ratenlimit_otlp` und `ratenlimit_agent` (Anfragen pro Minute je Token bzw. Rechner, 10–1.000.000, `null` = Standard des Servers; Migration 0018; wirkt im Ingest nach spätestens 60 s) |
| `PUT /api/v1/mandant/einstellungen` | mandanten_admin | nur geänderte Felder (`mandantEinstellungenEingabeSchema`, mindestens eines); 400 mit `details` (zod-Meldungen auf Deutsch); CSRF; je geändertem Feld ein Audit-Eintrag „Einstellung geändert“ (`mandant.<feld>: alt → neu`) |

`code_anteil_sitz` und `schatten_faktor` werden auf 4 Nachkommastellen gerundet (Spalten `numeric(6,4)`).
Die Lese-Route `GET /api/v1/auth/mandant` (Modul `auth`) bleibt für Name, Plan und Aufbewahrungsfristen.
Änderungen an Auswertungsstufe und Klarnamen sind mitbestimmungspflichtig (Architektur §10.5); der Betriebsrats-Bericht listet sie im Abschnitt Konfiguration.

## Selbstverwaltung (`/api/v1/mandant/…`)

Zugriff über `verwalteterMandant(request, reply)` (nach `requireAnmeldung`): Ziel ist `?mandant=<id>` oder der aktive Mandant der Sitzung; erlaubt für Mandanten-Admins dieses Mandanten (echte Rolle) und über `AuthErweiterung.mandantVerwalten` (ee: Plattform-Admin mit Lizenzmodul `mandanten`, `zugriff = 'plattform'`). Sonst 403 (`kein_mandant`, `rolle_fehlt`), unbekannter Mandant 404. Dieselbe Prüfung nutzen die Module `oidc`, `konten` und `scim`.

| Route | Inhalt |
|---|---|
| `GET/POST /api/v1/mandant/tokens`, `DELETE …/tokens/:tokenId` | Mandanten-Tokens (Quelle A): Liste (nur Präfix), neu (Klartext nur in der Antwort, 201), widerrufen; Audit |
| `GET/POST /api/v1/mandant/anthropic-orgs`, `DELETE …/anthropic-orgs/:org` | Positivliste der Anthropic-Orgs `{ org_uuid, bezeichnung?, plan? }`; Audit |
| `GET/POST /api/v1/mandant/rollen`, `DELETE …/rollen/:rolleId` | `{ benutzer_id \| benutzername, rolle, projekt_ids? }` für vorhandene Konten; erste Rolle eines Kontos prüft das Kontenkontingent (409 `konten_kontingent`, nur mit ee); Audit |
| `GET /api/v1/mandant/benutzer` | Konten mit Rolle im Mandanten `{ benutzer: [{ id, benutzername, login, erstellt, deaktiviert, plattform_admin }] }` |

`verwaltung(zustand)` fasst die Haken der Plugins zusammen: `kontingentPruefen`/`kontingentStand` (ohne Plugin unbegrenzt), `plattformAdmins`, `istPlattformAdmin`, `mandantVerwalten`, `plattformAdminAbgleichen`. `VERWALTUNG_AUDIT` sind die Aktionsnamen der Selbstverwaltung, `kontingentFehler` die Antwort 409/403 `konten_kontingent`.
