// Registrierung eines Rechners (Architektur §2.2 `enroll <code>`, §6 Ingest-Token)
// und die Konfiguration, die der Agent danach vom Server bekommt (`/api/agent/v1/config`).
import { z } from 'zod';

/** Rechner-Token beginnen mit `smr_`, Mandanten-Token mit `smi_` (Architektur §6). */
export const RECHNER_TOKEN_PRAEFIX = 'smr_';
export const MANDANTEN_TOKEN_PRAEFIX = 'smi_';

export const enrollmentAnfrageSchema = z.strictObject({
  /** Einmalcode aus dem Dashboard, 24 h gültig. */
  code: z.string().min(6).max(100),
  os: z.enum(['macos', 'linux', 'windows']),
  agent_version: z.string().min(1).max(50),
});
export type EnrollmentAnfrage = z.infer<typeof enrollmentAnfrageSchema>;

export const agentKonfigurationSchema = z.strictObject({
  /** Basis-URL des Ingest-Hosts, z. B. `https://ingest.example.org`. */
  server_url: z.url(),
  /** `hooks` = Hooks plus Sweeper, `nur_sweeper` = ohne Hooks (Pilot, Architektur §10.4). */
  modus: z.enum(['hooks', 'nur_sweeper']).default('hooks'),
  sweeper_intervall_min: z.int().min(5).max(15).default(10),
  /** Nur Sitzungen unter diesen Pfaden verlassen den Rechner (leer = alle). */
  include_paths: z.array(z.string().min(1)).default([]),
  exclude_paths: z.array(z.string().min(1)).default([]),
  /** Rückfüllung höchstens so weit, wie Transkripte liegen (Claude Code `cleanupPeriodDays`). */
  rueckfuellung_tage: z.int().min(0).max(365).default(30),
});
export type AgentKonfiguration = z.infer<typeof agentKonfigurationSchema>;

export const enrollmentAntwortSchema = z.strictObject({
  rechner_id: z.uuid(),
  /** Wird nur einmal ausgeliefert; der Server speichert nur SHA-256. */
  token: z.string().startsWith(RECHNER_TOKEN_PRAEFIX),
  konfiguration: agentKonfigurationSchema,
});
export type EnrollmentAntwort = z.infer<typeof enrollmentAntwortSchema>;

/**
 * `POST /api/agent/v1/heartbeat` (Rechner-Token): Lebenszeichen des Agenten nach jedem Sweeper- bzw.
 * Push-Lauf, auch wenn nichts zu senden war. Enthält nur die Agent-Version; den Zeitpunkt setzt der
 * Server (`rechner.zuletzt_gesehen`). Antwort 204 ohne Körper.
 */
export const agentHeartbeatSchema = z.strictObject({
  agent_version: z.string().min(1).max(50),
});
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
