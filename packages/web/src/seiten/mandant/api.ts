// Verwaltung des eigenen Mandanten (Routen unter /api/v1/mandant/…): Mandanten-Tokens, Org-Positivliste,
// Rollen sowie die Pfade für „SSO und Konten“. Jede Route nimmt `?mandant=<id>`; das Dashboard nennt den
// Mandanten immer ausdrücklich (aktiver Mandant oder, im Plattform-Bereich, der gewählte). Antworten werden
// nachsichtig geprüft: unbekannte Felder stören nicht.
import { z } from 'zod';

/** Pfad einer Verwaltungsroute des Mandanten, z. B. `mandantPfad(id, '/tokens')`. */
export function mandantPfad(mandantId: string, rest: string): string {
  return `/api/v1/mandant${rest}?mandant=${encodeURIComponent(mandantId)}`;
}

export const tokenSchema = z.object({
  id: z.string(),
  praefix: z.string(),
  erstellt: z.string(),
  zuletzt_genutzt: z.string().nullable(),
  widerrufen: z.string().nullable(),
});
export type TokenZeile = z.infer<typeof tokenSchema>;

export const tokenListeSchema = z.object({ tokens: z.array(tokenSchema) });

export const neuesTokenSchema = z.object({
  id: z.string(),
  praefix: z.string(),
  token: z.string(),
});

export const orgSchema = z.object({
  org_uuid: z.string(),
  bezeichnung: z.string().nullable(),
  plan: z.string().nullable(),
  gueltig_ab: z.string(),
});
export type OrgZeile = z.infer<typeof orgSchema>;

export const orgListeSchema = z.object({ orgs: z.array(orgSchema) });

export const rolleSchema = z.object({
  id: z.string(),
  benutzer_id: z.string(),
  benutzername: z.string(),
  rolle: z.string(),
  projekt_ids: z.array(z.string()).nullable(),
  quelle: z.string(),
});
export type RolleZeile = z.infer<typeof rolleSchema>;

export const rollenListeSchema = z.object({ rollen: z.array(rolleSchema) });

/** Rollen für Auswahlfelder und Tabellen (Wert, deutscher Text). */
export const ROLLEN_OPTIONEN = [
  ['mandanten_admin', 'Mandanten-Admin'],
  ['projektleiter', 'Projektleiter'],
  ['controller', 'Controller/Leser'],
  ['betriebsrat', 'Betriebsrat'],
  ['entwickler', 'Entwicklung (nur Projektwahl)'],
] as const;

/** Herkunft einer Rolle als deutscher Text. */
export function quelleText(quelle: string): string {
  if (quelle === 'oidc') return 'SSO-Gruppe';
  if (quelle === 'scim') return 'SCIM-Gruppe';
  return 'manuell';
}
