// Antworten von „SSO und Konten“ (Routen unter /api/v1/mandant/{oidc,domains,konten,scim-tokens}, Pfade über
// `mandantPfad`), nachsichtig geprüft: unbekannte Felder stören nicht, fehlende optionale Felder werden zu null.
import { z } from 'zod';

const textOderNull = z
  .string()
  .nullish()
  .transform((w) => w ?? null);

/** Scopes kommen als Leerzeichen-Text (Server) oder Liste; im UI immer ein Text. */
const scopesSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((w) => (Array.isArray(w) ? w.join(' ') : w));

export const oidcKonfigurationSchema = z.object({
  issuer: z.string(),
  client_id: z.string(),
  client_secret_gesetzt: z.boolean().optional(),
  scopes: scopesSchema,
  bezeichnung: z.string(),
  gruppen_rollen: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  aktiv: z.boolean(),
  erstellt: textOderNull,
  geaendert: textOderNull,
  zuletzt_geprueft: textOderNull,
});
export type OidcKonfiguration = z.infer<typeof oidcKonfigurationSchema>;

export const oidcAntwortSchema = z.object({
  konfiguration: oidcKonfigurationSchema.nullable(),
  redirect_uri: textOderNull,
  start_url: z.string(),
});
export type OidcAntwort = z.infer<typeof oidcAntwortSchema>;

export const oidcPruefungSchema = z.object({
  ok: z.boolean(),
  fehler: textOderNull,
  issuer: textOderNull,
  endpunkte: z
    .object({
      authorization: textOderNull,
      token: textOderNull,
      userinfo: textOderNull,
      end_session: textOderNull,
    })
    .nullish()
    .transform((w) => w ?? null),
  geprueft: textOderNull,
});
export type OidcPruefung = z.infer<typeof oidcPruefungSchema>;

export const domainSchema = z.object({
  domain: z.string(),
  verifiziert: z.boolean(),
  verifizierungs_token: textOderNull,
  verifiziert_am: textOderNull,
  quelle: textOderNull,
  erstellt: textOderNull,
  txt_name: textOderNull,
  txt_wert: textOderNull,
});
export type DomainZeile = z.infer<typeof domainSchema>;

export const domainsSchema = z.object({ domains: z.array(domainSchema) });

export const domainPruefungSchema = z.object({
  verifiziert: z.boolean(),
  fehler: textOderNull,
  domain: domainSchema,
});

export const kontingentSchema = z.object({
  belegt: z.number(),
  max: z
    .number()
    .nullish()
    .transform((w) => w ?? null),
});
export type Kontingent = z.infer<typeof kontingentSchema>;

export const kontoSchema = z.object({
  id: z.string(),
  benutzername: z.string(),
  login: z.string(),
  rollen: z.array(
    z.object({
      rolle: z.string(),
      projekt_ids: z.array(z.string()).nullish(),
      quelle: z.string(),
    }),
  ),
  deaktiviert: textOderNull,
  zuletzt_angemeldet: textOderNull,
  einladung_offen: z.boolean().default(false),
  einladung_bis: textOderNull,
  plattform_admin: z.boolean().default(false),
});
export type KontoZeile = z.infer<typeof kontoSchema>;

export const kontenSchema = z.object({
  konten: z.array(kontoSchema),
  kontingent: kontingentSchema,
});

export const einladungSchema = z.object({ url: z.string(), gueltig_bis: textOderNull });
export type EinladungLink = z.infer<typeof einladungSchema>;

export const kontoAnlegenSchema = z.object({
  konto: kontoSchema,
  einladung: einladungSchema.nullish().transform((w) => w ?? null),
});

export const neueEinladungSchema = z.object({ einladung: einladungSchema });

export const scimTokenSchema = z.object({
  id: z.string(),
  praefix: z.string(),
  bezeichnung: textOderNull,
  erstellt: textOderNull,
  zuletzt_genutzt: textOderNull,
  widerrufen: textOderNull,
});
export type ScimToken = z.infer<typeof scimTokenSchema>;

export const scimTokensSchema = z.object({
  tokens: z.array(scimTokenSchema),
  basis_url: textOderNull,
  konten_synchronisiert: z.number().default(0),
  gruppen_synchronisiert: z.number().default(0),
  letzte_synchronisation: textOderNull,
});

export const scimTokenNeuSchema = scimTokenSchema.extend({ token: z.string() });
