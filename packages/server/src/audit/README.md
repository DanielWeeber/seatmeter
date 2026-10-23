# Modul `audit`

Zugriffsprotokoll (Architektur §3.1, §7), ohne Personendaten der Gezählten.

- `protokolliere(trx, { benutzerId, aktion, objekt })`: `trx` aus `withMandant` (Mandant kommt aus `app_mandant_id()`). Aktionsnamen fest in `AUDIT_AKTION` (Einrichtung, Anmeldung, Mandant gewechselt, Benutzer angelegt, Preis angelegt/geändert, Sitzkosten geändert, Sitz geändert, Personensicht geöffnet, Aggregation angestoßen, Einmalcode erzeugt, Rechner widerrufen, Einstellung geändert, Kurs gesetzt/gelöscht, Monatsabschluss erstellt/überschrieben, Export Projektabrechnung, Export Betriebsrat, Ansicht Betriebsrat). Ereignistypen als Präfix: „Export …“ = Download/Datei, „Ansicht …“ = Bericht im Dashboard oder Browser geöffnet (Betriebsrats-Bericht `exporte` bzw. `ansichten`).
- `GET /api/v1/audit?von=&bis=&limit=&vor_id=` (mandanten_admin, betriebsrat): neueste zuerst, höchstens 500, Blättern über `vor_id`; Antwort `{ eintraege: AuditEintrag[] }` mit Benutzername.
- Löschung nach `aufbewahrung_audit_monate` (Modul aufbewahrung).
