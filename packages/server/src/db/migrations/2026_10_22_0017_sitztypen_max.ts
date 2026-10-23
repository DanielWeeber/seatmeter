// Sitztypen für Claude Max (Entscheidung Daniel 2026-10-22): `max5` (Max 5x,
// 100 USD/Monat) und `max20` (Max 20x, 200 USD/Monat) ersetzen den Platzhalter `max` (200 USD).
// - `max` wird in Sitzen je Person und Sitzkosten zu `max20` (Preis und `gueltig_ab` bleiben).
// - Jeder Mandant bekommt die Standardpreise beider Typen (`SITZ_STANDARDKOSTEN` in shared), soweit
//   für den Typ noch keine Zeile existiert; neue Mandanten über den Trigger `mandant_sitzkosten_standard`
//   (gilt für Einrichtung, CLI `mandant:anlegen` und ee-Mandantenverwaltung gleichermaßen).
// Die Werte stehen hier fest (eine Migration ändert sich nicht mehr); ein Test vergleicht sie mit shared.
// Namen der CHECK-Bedingungen stammen von Postgres (`<tabelle>_<spalte>_check`). Nur vorwärts.
import { sql, type Kysely } from 'kysely';

const TYPEN = `('standard', 'premium', 'enterprise', 'max5', 'max20')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const tabelle of ['person_sitz', 'sitzkosten']) {
    await sql
      .raw(`ALTER TABLE ${tabelle} DROP CONSTRAINT IF EXISTS ${tabelle}_sitz_typ_check`)
      .execute(db);
    await sql.raw(`UPDATE ${tabelle} SET sitz_typ = 'max20' WHERE sitz_typ = 'max'`).execute(db);
    await sql
      .raw(
        `ALTER TABLE ${tabelle} ADD CONSTRAINT ${tabelle}_sitz_typ_check CHECK (sitz_typ IN ${TYPEN})`,
      )
      .execute(db);
  }
  await sql`
    CREATE OR REPLACE FUNCTION sitzkosten_standard_anlegen(mid uuid) RETURNS void
    LANGUAGE sql AS $$
      INSERT INTO sitzkosten (mandant_id, sitz_typ, gueltig_ab, preis_monat, waehrung, abrechnung)
      SELECT mid, s.sitz_typ, DATE '2025-01-01', s.preis, 'USD', 'monatlich'
      FROM (VALUES ('max5', 100.00), ('max20', 200.00)) AS s (sitz_typ, preis)
      WHERE NOT EXISTS (
        SELECT 1 FROM sitzkosten k WHERE k.mandant_id = mid AND k.sitz_typ = s.sitz_typ)
    $$`.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION mandant_sitzkosten_standard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM sitzkosten_standard_anlegen(NEW.id);
      RETURN NEW;
    END
    $$`.execute(db);
  await sql`DROP TRIGGER IF EXISTS mandant_sitzkosten_standard ON mandant`.execute(db);
  await sql`
    CREATE TRIGGER mandant_sitzkosten_standard AFTER INSERT ON mandant
    FOR EACH ROW EXECUTE FUNCTION mandant_sitzkosten_standard()`.execute(db);
  await sql`SELECT sitzkosten_standard_anlegen(id) FROM mandant`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
