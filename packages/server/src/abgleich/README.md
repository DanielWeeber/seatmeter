# Modul `abgleich`

Quelle C: Enterprise Analytics API und Team-Spend-CSV → `ueberschreitung`, `abgleich_lauf`. Bis 2026-10-24 ein ee-Modul (Lizenzmodul `abgleich`), seitdem Kern ohne Lizenzprüfung (Entscheidung vom 2026-10-23); Routen ohne `/ee/`. Job `abgleich.analytics` (täglich 05:00 UTC, letzte 8 UTC-Tage bis gestern, nur Mandanten mit Key). Dateien: `analytics.ts` (API-Client), `csv.ts` (Team-CSV), `abgleich.ts` (Personenzuordnung, `ueberschreitung`, `abgleich_lauf`), `routen.ts`.

| Route | Wer | Inhalt |
|---|---|---|
| `GET /api/v1/abgleich` | Admin, Controller | Plan, Key gesetzt (nie der Key), letzter Lauf |
| `PUT /api/v1/abgleich/analytics-key` `{ key }`, `DELETE …` | Admin | Analytics-Key (Scope `read:analytics`) verschlüsselt in `mandant_geheimnis.analytics_key` |
| `POST /api/v1/abgleich/lauf?von=&bis=` | Admin | Lauf über die Analytics API (UTC-Tage, inklusiv, höchstens 92 Tage; Standard die letzten 8 Tage) |
| `GET /api/v1/abgleich/laeufe` | Admin, Controller | letzte 50 Läufe mit Zusammenfassung |
| `POST /api/v1/abgleich/csv/vorschau`, `POST …/csv` | Admin | Team-Spend-CSV als JSON `{ csv, zuordnung?, betrag_einheit? }` oder als `text/csv` |

- **Analytics API** (geprüft gegen die Doku am 2026-10-22, Fixtures in `packages/server/test/fixtures/analytics/`, kein Live-Enterprise): `GET https://api.anthropic.com/v1/organizations/analytics/user_usage_report` und `/user_cost_report` mit `starting_at`/`ending_at` (RFC 3339, exklusiv, je Abruf höchstens 31 Tage), `bucket_width=1d`, `products[]=claude_code`, `group_by[]=model`, `limit=1000`; Header `x-api-key` (eigener Analytics-Key, nur Primary Owner, nur Claude Enterprise) und `anthropic-version: 2023-06-01`. Paging über `has_more`/`next_page`, 410 = Cursor abgelaufen (Abschnitt neu), 429 mit `retry-after` (bis 3 Wiederholungen), 401/403 = Key abgelehnt. `amount`/`list_amount` sind Cent-Strings (`"1500.000000"` = 15 $). Basis-URL für Tests: `SEATMETER_ANALYTICS_URL`.
- **Personen:** `actor.user_id` sofort als HMAC → `person.key_konto_id` (HMAC(`user.account_id`), füllt der Kern-Ingest aus Quelle A) bzw. `key_konto`; `email_address` als HMAC → `key_email`; `name` wird verworfen. Nicht zugeordnete Personentage werden gezählt, nicht gespeichert.
- **`ueberschreitung`** je Person/Tag/Modell mit `amount`, `list_amount` und den Tokens der Nutzungszeile (auf sitzbasierten Enterprise-Plänen bilden beide Reports laut Doku nur Usage Credits ab); ein Lauf ersetzt die Zeilen seiner Quelle im Zeitraum. CSV überschreibt keine API-Zeile.
- **`abgleich_lauf`:** Status `ok`/`abweichung`/`fehler`, Zusammenfassung ohne Personendaten: Personentage, zugeordnet/ohne Zuordnung, innerhalb/außerhalb ±3 % gegen `tag_aggregat` (Tokens input+output+cache), „nur seatmeter“, Abdeckung in %, Überschreitung, Tagessummen. Tagesgrenzen der Quelle sind UTC, das Tagesaggregat nutzt die Mandanten-Zeitzone (Näherung).
- **Team-CSV** (Spaltenformat nicht verifiziert): Trennzeichen `,` `;` Tab, Spalten deutsch/englisch tolerant erkannt (E-Mail, Datum, Modell, Betrag, Listenpreis, Tokenarten), Zahlen `1.234,56`/`1,234.56`/`$12.30`, Datum ISO, `TT.MM.JJJJ`, `MM/TT/JJJJ`; Beträge in USD (Standard) oder Cent. Die Vorschau zeigt die Zuordnung, maskierte Beispielzeilen und Zähler; Pflichtfelder E-Mail, Datum, Betrag.
- **Abzug:** Die Kern-Kalkulation zieht die Überschreitung ab, sobald für den Monat Zeilen in `ueberschreitung` stehen (Architektur §4); ohne Abgleich bleibt „Überschreitung nicht abgezogen“.
