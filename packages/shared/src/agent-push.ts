// Push-Datensatz des lokalen Agenten (Architektur §2.2, `POST /api/ingest/v1/anfragen`).
// Alle Objekte sind strikt: unbekannte Felder (z. B. `cwd`, Pfade, Hostnamen, `content`) werden abgelehnt.
// Gesendet werden nie Inhalte, `cwd`, Dateipfade, Hostnamen, Branch-Namen oder die E-Mail; aus dem
// Branch-Namen nur der erkannte Issue-Schlüssel (`issue_schluessel`, z. B. `ABC-123`).
import { z } from 'zod';
import { normalisiereSpeed } from './anfrage.js';
import { ISSUE_SCHLUESSEL_MAX, issueSchluesselSchema } from './issue-schluessel.js';

/** Höchstzahl Einträge je Push (Architektur §2.2). */
export const PUSH_MAX_EINTRAEGE = 1000;

const tokenAnzahl = z.int().nonnegative();

export const projektAngabeSchema = z.strictObject({
  /** Normalisierte Repo-URL laut `normalisiereRepoUrl` (keine Zugangsdaten, kein `.git`). */
  url_norm: z.string().min(1).max(500),
  provider: z.enum(['github', 'gitlab', 'gitea', 'unknown']),
  owner: z.string().max(200).nullable(),
  repo_name: z.string().max(200).nullable(),
});
export type ProjektAngabe = z.infer<typeof projektAngabeSchema>;

/** Bezeichnung eines Pfad-Projekts: beginnt mit Buchstabe/Ziffer, danach auch Leerzeichen, `._/-`. */
export const PFAD_PROJEKT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u;

/**
 * Synthetisches Projekt für Sitzungen ohne Git-Remote unter einem konfigurierten Pfad
 * (Agent-Option `pfad_projekte`). Gesendet wird nur die Bezeichnung, nie der Pfad.
 */
export const pfadProjektSchema = z.strictObject({
  typ: z.literal('pfad'),
  name: z.string().min(1).max(100).regex(PFAD_PROJEKT_NAME),
});
export type PfadProjekt = z.infer<typeof pfadProjektSchema>;

/** Projekt einer Anfrage: Repo (normalisierte URL) oder Pfad-Projekt. */
export const projektMeldungSchema = z.union([projektAngabeSchema, pfadProjektSchema]);
export type ProjektMeldung = z.infer<typeof projektMeldungSchema>;

export function istPfadProjekt(p: ProjektMeldung | null | undefined): p is PfadProjekt {
  return !!p && 'typ' in p && p.typ === 'pfad';
}

export const authHinweisSchema = z.strictObject({
  /** Heuristik des Agenten (Architektur §2.2): `api` bei API-Key/Provider-Variablen, sonst `oauth`. */
  klasse: z.enum(['oauth', 'api']),
  org_uuid: z.uuid().nullable(),
  account_uuid: z.uuid().nullable(),
});
export type AuthHinweis = z.infer<typeof authHinweisSchema>;

export const agentAnfrageSchema = z.strictObject({
  /** `requestId` der Assistant-Zeile (`req_…`), falls vorhanden. */
  request_id: z.string().min(1).max(200).nullable(),
  /** `message.id`; Ersatzschlüssel `msg:<message.id>`, wenn `request_id` fehlt. */
  message_id: z.string().min(1).max(200),
  session_id: z.string().min(1).max(200),
  ts: z.iso.datetime({ offset: true }),
  model: z.string().min(1).max(200),
  input_tokens: tokenAnzahl,
  output_tokens: tokenAnzahl,
  cache_read_input_tokens: tokenAnzahl,
  cache_creation_input_tokens: tokenAnzahl,
  cache_write_5m: tokenAnzahl.nullable(),
  cache_write_1h: tokenAnzahl.nullable(),
  web_search_requests: tokenAnzahl,
  /** Transkript-Wert; `standard` wird beim Prüfen zu `normal` (normalisiereSpeed). */
  speed: z.string().max(50).nullable().transform(normalisiereSpeed),
  service_tier: z.string().max(50).nullable(),
  inference_geo: z.string().max(50).nullable(),
  ist_subagent: z.boolean(),
  cc_version: z.string().max(50).nullable(),
  projekt: projektMeldungSchema.nullable(),
  auth_hinweis: authHinweisSchema,
  /**
   * Issue-Schlüssel aus dem Branch-Namen der Transkriptzeile (ab Agent 0.1.3, optional für ältere
   * Agenten). Leere Liste = Branch ohne Schlüssel; fehlt das Feld, ist der Branch unbekannt.
   * Der Branch-Name selbst wird nie gesendet.
   */
  issue_schluessel: z.array(issueSchluesselSchema).max(ISSUE_SCHLUESSEL_MAX).optional(),
});
export type AgentAnfrage = z.infer<typeof agentAnfrageSchema>;

export const agentPushSchema = z.strictObject({
  agent_version: z.string().min(1).max(50),
  anfragen: z.array(agentAnfrageSchema).min(1).max(PUSH_MAX_EINTRAEGE),
});
export type AgentPush = z.infer<typeof agentPushSchema>;

/** Sitzungsmeldung des Agenten (`POST /api/ingest/v1/sitzungen`), z. B. aus dem Hook `SessionStart`. */
export const agentSitzungSchema = z.strictObject({
  session_id: z.string().min(1).max(200),
  start: z.iso.datetime({ offset: true }),
  ende: z.iso.datetime({ offset: true }).nullable(),
  cc_version: z.string().max(50).nullable(),
  projekt: projektMeldungSchema.nullable(),
  auth_hinweis: authHinweisSchema,
});
export type AgentSitzung = z.infer<typeof agentSitzungSchema>;

export const agentSitzungenPushSchema = z.strictObject({
  agent_version: z.string().min(1).max(50),
  sitzungen: z.array(agentSitzungSchema).min(1).max(PUSH_MAX_EINTRAEGE),
});
export type AgentSitzungenPush = z.infer<typeof agentSitzungenPushSchema>;

/** Antwort auf einen Push (Anfragen oder Sitzungen); nur Zähler. */
export const agentPushAntwortSchema = z.strictObject({
  angenommen: z.int().nonnegative(),
  wiederholt: z.int().nonnegative(),
  verworfen_api: z.int().nonnegative(),
  verworfen_fremd_org: z.int().nonnegative(),
  abgelehnt: z.int().nonnegative(),
});
export type AgentPushAntwort = z.infer<typeof agentPushAntwortSchema>;
