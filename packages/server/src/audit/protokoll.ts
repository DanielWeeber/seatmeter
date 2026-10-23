// Zugriffsprotokoll (Architektur §3.1 `audit`, §7): wer hat wann was geöffnet, geändert oder exportiert.
// Ohne Personendaten der Gezählten: `objekt` nennt nur Art und ID des Objekts (Projekt, Preis, Monat).
import { sql, type Transaction } from 'kysely';
import type { Datenbank } from '../db/schema.js';

/** Feste Aktionsnamen, damit Bericht und Filter stabil bleiben. */
export const AUDIT_AKTION = {
  einrichtung: 'Einrichtung',
  anmeldung: 'Anmeldung',
  mandantGewechselt: 'Mandant gewechselt',
  benutzerAngelegt: 'Benutzer angelegt',
  preisAngelegt: 'Preis angelegt',
  preisGeaendert: 'Preis geändert',
  sitzkostenGeaendert: 'Sitzkosten geändert',
  sitzGeaendert: 'Sitz geändert',
  personensicht: 'Personensicht geöffnet',
  aggregationAngestossen: 'Aggregation angestoßen',
  einmalcodeErzeugt: 'Einmalcode erzeugt',
  rechnerWiderrufen: 'Rechner widerrufen',
  /** Modul ausrollen: neues Mandanten-Token für den Schnipsel mit festem Header. */
  ingestTokenErzeugt: 'Ingest-Token erzeugt',
  /** Für das Modul berichte (Betriebsrats-Bericht, Projektabrechnung): Download bzw. Datei. */
  export: 'Export',
  exportProjektabrechnung: 'Export Projektabrechnung',
  exportBetriebsrat: 'Export Betriebsrat',
  /** Modul issues: CSV der Kosten je Issue-Schlüssel. */
  exportIssues: 'Export Issues',
  /**
   * Ereignistyp „Ansicht“: Bericht im Dashboard bzw. Browser geöffnet (kein Download). Objekt nennt nur
   * Berichtsart, Zeitraum und Format, nie Inhalte (Entscheidung Daniel 2026-10-22).
   */
  ansicht: 'Ansicht',
  ansichtBetriebsrat: 'Ansicht Betriebsrat',
  einstellungGeaendert: 'Einstellung geändert',
  kursGesetzt: 'Kurs gesetzt',
  kursGeloescht: 'Kurs gelöscht',
  monatsabschlussErstellt: 'Monatsabschluss erstellt',
  monatsabschlussUeberschrieben: 'Monatsabschluss überschrieben',
} as const;

export interface AuditAngabe {
  benutzerId: string | null;
  aktion: string;
  objekt?: string | null;
}

/**
 * Schreibt einen Audit-Eintrag im Mandanten der laufenden Transaktion. `trx` muss aus `withMandant`
 * stammen (die Spalte `mandant_id` kommt aus `app_mandant_id()`, ohne Mandant schlägt das fehl).
 */
export async function protokolliere(
  trx: Transaction<Datenbank>,
  angabe: AuditAngabe,
): Promise<void> {
  await trx
    .insertInto('audit')
    .values({
      mandant_id: sql<string>`app_mandant_id()`,
      benutzer_id: angabe.benutzerId,
      aktion: angabe.aktion.slice(0, 200),
      objekt: angabe.objekt?.slice(0, 500) ?? null,
    })
    .execute();
}
