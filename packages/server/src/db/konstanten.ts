// Datenbank-Konstanten, die Migrationen und Laufzeit teilen.

/** Anwendungsrolle ohne BYPASSRLS; jede Mandanten-Transaktion wechselt per SET LOCAL ROLE dorthin. */
export const APP_ROLLE = 'seatmeter_app';

/** GUC mit der Mandanten-ID der laufenden Transaktion (Row-Level-Security). */
export const MANDANT_GUC = 'app.mandant_id';
