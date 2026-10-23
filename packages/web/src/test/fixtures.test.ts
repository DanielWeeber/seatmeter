// Fixtures gegen die Antwort-Schemas des Clients: Typ (satisfies in fixtures.ts) und Laufzeitprüfung
// müssen zusammenpassen, sonst testen die Seiten-Tests an der echten API vorbei.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ausrollenKonfigurationSchema,
  authMeSchema,
  betriebsratBerichtSchema,
  datenqualitaetSchema,
  kalkulationAntwortSchema,
  kurseAntwortSchema,
  mandantEinstellungenSchema,
  monatsabschlussSchema,
  personenSchema,
  preiseSchema,
  projektDetailSchema,
  projektIssuesSchema,
  projekteSchema,
  rechnerListeSchema,
  sitzkostenSchema,
  uebersichtSchema,
} from '../api/typen';
import * as f from './fixtures';

const faelle: [string, z.ZodType, unknown][] = [
  ['ME_ADMIN', authMeSchema, f.ME_ADMIN],
  ['ME_LESER', authMeSchema, f.ME_LESER],
  ['UEBERSICHT', uebersichtSchema, f.UEBERSICHT],
  ['UEBERSICHT_LEER', uebersichtSchema, f.UEBERSICHT_LEER],
  ['PROJEKTE', projekteSchema, f.PROJEKTE],
  ['PROJEKT_DETAIL', projektDetailSchema, f.PROJEKT_DETAIL],
  ['PROJEKT_DETAIL_OHNE_PERSONEN', projektDetailSchema, f.PROJEKT_DETAIL_OHNE_PERSONEN],
  ['PROJEKT_DETAIL_UNZUGEORDNET', projektDetailSchema, f.PROJEKT_DETAIL_UNZUGEORDNET],
  ['PERSONEN', personenSchema, f.PERSONEN],
  ['PERSONEN_ZU_WENIGE', personenSchema, f.PERSONEN_ZU_WENIGE],
  ['DATENQUALITAET', datenqualitaetSchema, f.DATENQUALITAET],
  ['PREISE', preiseSchema, f.PREISE],
  ['SITZKOSTEN', sitzkostenSchema, f.SITZKOSTEN],
  ['SITZKOSTEN_MAX', sitzkostenSchema, f.SITZKOSTEN_MAX],
  ['ME_BETRIEBSRAT', authMeSchema, f.ME_BETRIEBSRAT],
  ['KALKULATION', kalkulationAntwortSchema, f.KALKULATION],
  [
    'KALKULATION_OHNE_UEBERSCHREITUNG',
    kalkulationAntwortSchema,
    f.KALKULATION_OHNE_UEBERSCHREITUNG,
  ],
  ['KALKULATION_OHNE_KURS', kalkulationAntwortSchema, f.KALKULATION_OHNE_KURS],
  ['MONATSABSCHLUSS', monatsabschlussSchema, f.MONATSABSCHLUSS],
  ['MONATSABSCHLUSS_OFFEN', monatsabschlussSchema, f.MONATSABSCHLUSS_OFFEN],
  ['KURSE', kurseAntwortSchema, f.KURSE],
  ['MANDANT_EINSTELLUNGEN', mandantEinstellungenSchema, f.MANDANT_EINSTELLUNGEN],
  ['BETRIEBSRAT', betriebsratBerichtSchema, f.BETRIEBSRAT],
  ['AUSROLLEN', ausrollenKonfigurationSchema, f.AUSROLLEN],
  ['PROJEKT_ISSUES', projektIssuesSchema, f.PROJEKT_ISSUES],
];

describe('Fixtures erfüllen den Vertrag', () => {
  it.each(faelle)('%s', (_name, schema, wert) => {
    const ergebnis = schema.safeParse(wert);
    expect(ergebnis.error?.issues ?? []).toEqual([]);
    // Kein Feld geht beim Parsen verloren (z.object entfernt Unbekanntes).
    expect(ergebnis.data).toEqual(wert);
  });

  it('RECHNER passt zur Rechnerliste', () => {
    const ergebnis = rechnerListeSchema.safeParse(f.RECHNER);
    expect(ergebnis.success).toBe(true);
    // `widerrufen` ist laut Vertrag ein Zeitpunkt oder `null` (= aktiv).
    expect(ergebnis.data).toEqual(f.RECHNER);
  });
});
