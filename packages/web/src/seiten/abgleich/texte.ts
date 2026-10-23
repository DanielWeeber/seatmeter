// Anzeigetexte des Abgleichs.
import type { AbgleichLauf, CsvFeld } from '@seatmeter/shared';
import { datum } from '../../format';

export const STATUS_TEXT: Record<AbgleichLauf['status'], string> = {
  laeuft: 'Läuft',
  ok: 'In Ordnung',
  abweichung: 'Abweichungen',
  fehler: 'Fehler',
};

export const PLAN_TEXT: Record<string, string> = {
  team: 'Team',
  enterprise: 'Enterprise',
  max_pilot: 'Max (Pilot)',
};

export const QUELLE_TEXT: Record<AbgleichLauf['quelle'], string> = {
  api: 'Analytics-API',
  csv: 'CSV',
};

export const CSV_FELD_TEXT: Record<CsvFeld, string> = {
  email: 'E-Mail',
  tag: 'Tag',
  modell: 'Modell',
  amount: 'Betrag',
  list_amount: 'Listenbetrag',
  input: 'Input-Tokens',
  output: 'Output-Tokens',
  cache_read: 'Cache lesen',
  cache_write: 'Cache schreiben',
};

export const zeitraumText = (von: string, bis: string): string => `${datum(von)} – ${datum(bis)}`;

export function trennzeichenText(zeichen: string): string {
  switch (zeichen) {
    case ',':
      return 'Komma (,)';
    case ';':
      return 'Semikolon (;)';
    case '\t':
      return 'Tabulator';
    case '|':
      return 'senkrechter Strich (|)';
    default:
      return zeichen;
  }
}
