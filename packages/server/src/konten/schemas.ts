// Eingaben für Domains, Konten und Einladungen (zod, deutsche Meldungen).
import { ROLLEN } from '@seatmeter/shared';
import { z } from 'zod';

export const domainNeuSchema = z.strictObject({
  domain: z.string().trim().min(3, 'Domain fehlt').max(253),
});

export const domainAenderungSchema = z.strictObject({ verifiziert: z.boolean() });

/** E-Mail-Adresse als Anmeldename (klein). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-Mail-Adresse erwartet');

const rollenListe = z
  .array(z.enum(ROLLEN))
  .max(ROLLEN.length)
  .transform((r) => [...new Set(r)]);

export const kontoNeuSchema = z.strictObject({
  benutzername: emailSchema,
  rollen: rollenListe.refine((r) => r.length > 0, 'Mindestens eine Rolle angeben'),
  projekt_ids: z.array(z.uuid()).optional(),
});

export const kontoAenderungSchema = z
  .strictObject({
    rollen: rollenListe,
    projekt_ids: z.array(z.uuid()).nullable(),
    deaktiviert: z.boolean(),
  })
  .partial()
  .refine((e) => Object.keys(e).length > 0, 'Mindestens ein Feld angeben');

export const benutzerParam = z.object({ benutzerId: z.uuid() });

export const einladungTokenSchema = z.strictObject({ token: z.string().min(20).max(200) });

export const einladungAnnehmenSchema = z.strictObject({
  token: z.string().min(20).max(200),
  passwort: z.string().min(12, 'Mindestens 12 Zeichen').max(200),
});
