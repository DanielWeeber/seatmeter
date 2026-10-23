// Anzeigetexte der Budgets und Alarme.
import type { Alarm, Budget } from '@seatmeter/shared';

export const AUSLOESER_TEXT: Record<Budget['ausloeser'], string> = {
  verbrauch: 'Verbrauch',
  prognose: 'Prognose',
};

/** Einheit der Budget-Beträge: Währung bei Basis Projektpreis, sonst Tokens. */
export const budgetEinheit = (b: Budget): string => (b.basis === 'tokens' ? 'Tokens' : b.waehrung);

export const ZUSTELLUNG_TEXT: Record<Alarm['zustellung'], string> = {
  offen: 'Ausstehend',
  zugestellt: 'Zugestellt',
  fehler: 'Zustellung fehlgeschlagen',
  ohne_kanal: 'Kein Alarmkanal',
};
