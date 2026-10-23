// API-Vertrag der ee-Module Budgets, Alarme und Alarmkanäle (Architektur §5 „Budget (ee)“).
// Die Schemas liegen im Kern-Paket shared, damit ee/server und ee/web denselben Vertrag nutzen;
// die Umsetzung bleibt in ee/ (weeberwrk-Lizenz).
import { z } from 'zod';
import { monatSchema } from './dashboard.js';

export const BUDGET_BASEN = ['projektpreis', 'tokens'] as const;
export const BUDGET_AUSLOESER = ['verbrauch', 'prognose'] as const;
export const BUDGET_WAEHRUNGEN = ['EUR', 'USD'] as const;
export const STANDARD_SCHWELLEN = [50, 80, 100] as const;

const schwellenSchema = z
  .array(z.int().min(1).max(1000))
  .min(1)
  .max(10)
  .transform((s) => [...new Set(s)].sort((a, b) => a - b));

/** Eingabe für POST/PUT `/api/v1/ee/budgets`; `projekt_id: null` = mandantenweit. */
export const budgetEingabeSchema = z.strictObject({
  projekt_id: z.uuid().nullable(),
  bezeichnung: z.string().trim().max(200).nullable().optional(),
  /** Betrag in `waehrung` (Basis projektpreis) bzw. Anzahl Tokens (Basis tokens). */
  betrag: z.number().positive().max(1e12),
  waehrung: z.enum(BUDGET_WAEHRUNGEN).default('EUR'),
  basis: z.enum(BUDGET_BASEN).default('projektpreis'),
  schwellen: schwellenSchema.default([...STANDARD_SCHWELLEN]),
  /** Woran die Schwellen gemessen werden: Verbrauch bis heute oder Prognose zum Monatsende. */
  ausloeser: z.enum(BUDGET_AUSLOESER).default('verbrauch'),
  aktiv: z.boolean().default(true),
});
export type BudgetEingabe = z.input<typeof budgetEingabeSchema>;

/** Stand eines Budgets im Monat (Verbrauch bis heute, lineare Prognose über Arbeitstage). */
export const budgetStandSchema = z.object({
  monat: monatSchema,
  /** Verbrauch in Budget-Einheit (Währung bzw. Tokens); `null` = nicht berechenbar (z. B. kein Kurs). */
  verbrauch: z.number().nullable(),
  prognose: z.number().nullable(),
  prozent: z.number().nullable(),
  prognose_prozent: z.number().nullable(),
  /** Arbeitstage (Mo–Fr) bis heute bzw. im Monat, Grundlage der Prognose. */
  arbeitstage_bisher: z.int(),
  arbeitstage_monat: z.int(),
  hinweis: z.string().nullable(),
});
export type BudgetStand = z.infer<typeof budgetStandSchema>;

export const budgetSchema = z.object({
  id: z.uuid(),
  projekt_id: z.uuid().nullable(),
  projekt_name: z.string().nullable(),
  bezeichnung: z.string().nullable(),
  betrag: z.number(),
  waehrung: z.enum(BUDGET_WAEHRUNGEN),
  basis: z.enum(BUDGET_BASEN),
  schwellen: z.array(z.int()),
  ausloeser: z.enum(BUDGET_AUSLOESER),
  aktiv: z.boolean(),
  erstellt: z.string(),
  stand: budgetStandSchema,
});
export type Budget = z.infer<typeof budgetSchema>;

export const budgetListeSchema = z.object({ monat: monatSchema, budgets: z.array(budgetSchema) });
export type BudgetListe = z.infer<typeof budgetListeSchema>;

export const ZUSTELLUNGEN = ['offen', 'zugestellt', 'fehler', 'ohne_kanal'] as const;

export const alarmSchema = z.object({
  id: z.uuid(),
  budget_id: z.uuid(),
  budget_name: z.string(),
  projekt_id: z.uuid().nullable(),
  /** Periode als Monat `JJJJ-MM`. */
  monat: monatSchema,
  schwelle: z.int(),
  prozent: z.number().nullable(),
  wert: z.number(),
  betrag: z.number().nullable(),
  einheit: z.string(),
  ausgeloest: z.string(),
  quittiert: z.string().nullable(),
  zustellung: z.enum(ZUSTELLUNGEN),
  zustellfehler: z.string().nullable(),
});
export type Alarm = z.infer<typeof alarmSchema>;

export const alarmListeSchema = z.object({ alarme: z.array(alarmSchema) });
export type AlarmListe = z.infer<typeof alarmListeSchema>;

export const alarmAbfrageSchema = z.object({
  monat: monatSchema.optional(),
  offen: z.enum(['0', '1']).optional(),
});

// ---------------------------------------------------------------------------------------------
// Alarmkanäle

export const KANAL_TYPEN = ['webhook', 'smtp', 'weeberwrk-relay'] as const;
export type KanalTyp = (typeof KANAL_TYPEN)[number];

const httpUrl = z.url({ protocol: /^https?$/ });

export const webhookKonfigSchema = z.strictObject({ url: httpUrl });
export const smtpKonfigSchema = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.int().min(1).max(65535).default(587),
  /** true = TLS ab Verbindungsbeginn (465), sonst STARTTLS, wenn der Server es anbietet. */
  secure: z.boolean().default(false),
  benutzer: z.string().trim().max(320).nullable().optional(),
  von: z.email(),
  an: z.array(z.email()).min(1).max(20),
});
/** Alarm-Relay von weeberwrk: `/dm` (Direktnachricht) oder `/alert` (Vorfall mit Schlüssel). */
export const relayKonfigSchema = z.strictObject({
  url: httpUrl,
  pfad: z.enum(['/dm', '/alert']).default('/dm'),
  prio: z.enum(['normal', 'critical']).default('normal'),
  bot: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .nullable()
    .optional(),
});

/** `geheimnis`: weglassen = unverändert, `null` = löschen, Text = setzen (wird verschlüsselt). */
const geheimnisFeld = z.string().min(1).max(2000).nullable().optional();
const kanalBasis = {
  bezeichnung: z.string().trim().min(1).max(200),
  aktiv: z.boolean().default(true),
  geheimnis: geheimnisFeld,
};
export const kanalEingabeSchema = z.discriminatedUnion('typ', [
  z.strictObject({ typ: z.literal('webhook'), konfig: webhookKonfigSchema, ...kanalBasis }),
  z.strictObject({ typ: z.literal('smtp'), konfig: smtpKonfigSchema, ...kanalBasis }),
  z.strictObject({ typ: z.literal('weeberwrk-relay'), konfig: relayKonfigSchema, ...kanalBasis }),
]);
export type KanalEingabe = z.input<typeof kanalEingabeSchema>;

export const kanalSchema = z.object({
  id: z.uuid(),
  typ: z.enum(KANAL_TYPEN),
  bezeichnung: z.string(),
  aktiv: z.boolean(),
  konfig: z.record(z.string(), z.unknown()),
  geheimnis_gesetzt: z.boolean(),
  erstellt: z.string(),
  geaendert: z.string(),
});
export type Kanal = z.infer<typeof kanalSchema>;
export const kanalListeSchema = z.object({ kanaele: z.array(kanalSchema) });
export type KanalListe = z.infer<typeof kanalListeSchema>;

export const kanalTestErgebnisSchema = z.object({ ok: z.boolean(), meldung: z.string() });
export type KanalTestErgebnis = z.infer<typeof kanalTestErgebnisSchema>;
