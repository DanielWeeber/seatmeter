// Die Fixtures der Module Budgets, Hinweise und Abgleich erfüllen den Vertrag aus @seatmeter/shared.
import {
  abgleichLaeufeSchema,
  abgleichLaufSchema,
  abgleichStatusSchema,
  alarmListeSchema,
  alarmSchema,
  budgetListeSchema,
  budgetSchema,
  csvVorschauSchema,
  hinweisListeSchema,
  hinweisRegelnSchema,
  hinweisSchema,
  kanalListeSchema,
  kanalSchema,
  kanalTestErgebnisSchema,
} from '@seatmeter/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as f from './fixtures-module';

const faelle: [string, z.ZodType, unknown][] = [
  ['BUDGET_GESAMT', budgetSchema, f.BUDGET_GESAMT],
  ['BUDGET_PROJEKT', budgetSchema, f.BUDGET_PROJEKT],
  ['BUDGET_TOKENS', budgetSchema, f.BUDGET_TOKENS],
  ['BUDGETS', budgetListeSchema, f.BUDGETS],
  ['BUDGETS_OHNE_GESAMT', budgetListeSchema, f.BUDGETS_OHNE_GESAMT],
  ['BUDGETS_LEER', budgetListeSchema, f.BUDGETS_LEER],
  ['ALARM_OFFEN', alarmSchema, f.ALARM_OFFEN],
  ['ALARM_QUITTIERT', alarmSchema, f.ALARM_QUITTIERT],
  ['ALARME_OFFEN', alarmListeSchema, f.ALARME_OFFEN],
  ['ALARME_ALLE', alarmListeSchema, f.ALARME_ALLE],
  ['ALARME_LEER', alarmListeSchema, f.ALARME_LEER],
  ['KANAL_WEBHOOK', kanalSchema, f.KANAL_WEBHOOK],
  ['KANAL_SMTP', kanalSchema, f.KANAL_SMTP],
  ['KANAELE', kanalListeSchema, f.KANAELE],
  ['KANAL_TEST_OK', kanalTestErgebnisSchema, f.KANAL_TEST_OK],
  ['REGELN', hinweisRegelnSchema, f.REGELN],
  ['HINWEIS_CACHE', hinweisSchema, f.HINWEIS_CACHE],
  ['HINWEIS_OPUS', hinweisSchema, f.HINWEIS_OPUS],
  ['HINWEIS_UNZUGEORDNET', hinweisSchema, f.HINWEIS_UNZUGEORDNET],
  ['HINWEISE', hinweisListeSchema, f.HINWEISE],
  ['LAUF_API', abgleichLaufSchema, f.LAUF_API],
  ['LAUF_CSV', abgleichLaufSchema, f.LAUF_CSV],
  ['LAUF_FEHLER', abgleichLaufSchema, f.LAUF_FEHLER],
  ['ABGLEICH_LAEUFE', abgleichLaeufeSchema, f.ABGLEICH_LAEUFE],
  ['ABGLEICH_STATUS', abgleichStatusSchema, f.ABGLEICH_STATUS],
  ['ABGLEICH_STATUS_TEAM', abgleichStatusSchema, f.ABGLEICH_STATUS_TEAM],
  ['CSV_VORSCHAU', csvVorschauSchema, f.CSV_VORSCHAU],
];

describe('Modul-Fixtures erfüllen den Vertrag', () => {
  it.each(faelle)('%s', (_name, schema, wert) => {
    const ergebnis = schema.safeParse(wert);
    expect(ergebnis.error?.issues ?? []).toEqual([]);
    // Kein Feld geht beim Parsen verloren (z.object entfernt Unbekanntes).
    expect(ergebnis.data).toEqual(wert);
  });
});
