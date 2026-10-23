// Ausroll-Paket (Architektur §10): Werte für den Schnipsel-Generator im Dashboard (Seite „Ausrollen“).
// Die Antwort enthält nie ein Token; ein Mandanten-Token erscheint nur einmal in der Antwort auf
// `POST /api/v1/ausrollen/mandanten-token` (für den Schnipsel mit festem Header).
import { z } from 'zod';

/** Standard-Installationsort des Agenten (`deploy/agent-install.sh`, `SEATMETER_HOME`). */
export const AGENT_STANDARD_PFAD = '$HOME/.seatmeter/bin/seatmeter-agent';

export const ausrollenOrgSchema = z.strictObject({
  org_uuid: z.uuid(),
  bezeichnung: z.string().nullable(),
  plan: z.string().nullable(),
});
export type AusrollenOrg = z.infer<typeof ausrollenOrgSchema>;

export const ausrollenKonfigurationSchema = z.strictObject({
  mandant: z.strictObject({
    slug: z.string(),
    name: z.string(),
    plan: z.enum(['team', 'enterprise', 'max_pilot']),
  }),
  /** Basis-URL des Ingest-Hosts ohne abschließenden Schrägstrich. */
  ingest_url: z.url(),
  /**
   * Herkunft der Ingest-URL: `konfiguration` = `SEATMETER_INGEST_URL`, `oeffentlich` =
   * `SEATMETER_PUBLIC_URL`, `anfrage` = aus der Dashboard-Anfrage abgeleitet (dann Hinweis anzeigen,
   * weil das Dashboard oft intern läuft und die Rechner einen öffentlichen Host brauchen).
   */
  ingest_url_quelle: z.enum(['konfiguration', 'oeffentlich', 'anfrage']),
  /** `<ingest_url>/otlp`; Claude Code hängt `/v1/logs` bzw. `/v1/metrics` an. */
  otlp_endpoint: z.url(),
  /** Positivliste des Mandanten (Abo-Filter, optional `forceLoginOrgUUID`). */
  orgs: z.array(ausrollenOrgSchema),
  agent: z.strictObject({
    /**
     * Download-Basis des Agent-Releases (`SEATMETER_AGENT_RELEASE_URL`, z. B.
     * `https://<forgejo>/<org>/seatmeter/releases/download/v0.1.0`); `null` = nicht konfiguriert.
     */
    release_url: z.url().nullable(),
    /** Version des Servers; der Agent sollte dazu passen. */
    server_version: z.string(),
  }),
});
export type AusrollenKonfiguration = z.infer<typeof ausrollenKonfigurationSchema>;

export const mandantenTokenAntwortSchema = z.strictObject({
  /** Klartext `smi_…`, nur in dieser einen Antwort. */
  token: z.string().startsWith('smi_'),
  praefix: z.string(),
  erstellt: z.iso.datetime({ offset: true }),
});
export type MandantenTokenAntwort = z.infer<typeof mandantenTokenAntwortSchema>;
