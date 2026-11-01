// Signierter Link zur Projektwahl: Mandant plus Repo (normalisierte URL) oder Sitzung, befristet. Kein Geheimnis
// im engeren Sinn (die Seite verlangt zusätzlich eine Anmeldung), trotzdem nur mit gekürztem Pfad im Log.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Gültigkeit des Links in Millisekunden (eine Stunde). */
export const LINK_GUELTIG_MS = 60 * 60_000;
const SIGNATUR_ZEICHEN = 43;

const inhaltSchema = z.strictObject({
  v: z.literal(1),
  /** Mandant */
  m: z.uuid(),
  /** Repo: normalisierte URL. Das seatmeter-Projekt entsteht erst bei der Wahl; die Prüf-Route schreibt nichts. */
  u: z.string().min(1).max(1000).optional(),
  /** Ordner ohne Repo: Sitzungs-ID */
  s: z.string().min(1).max(100).optional(),
  /** Ablauf (Sekunden seit 1970) */
  e: z.number().int().positive(),
});
export type LinkInhalt = z.infer<typeof inhaltSchema>;

function schluessel(masterKey: Buffer): Buffer {
  return createHmac('sha256', masterKey).update('seatmeter-projektwahl-link-v1').digest();
}

/**
 * HMAC-SHA256 als Base64url, immer `SIGNATUR_ZEICHEN` Zeichen. Das Token hängt sie ohne Trennzeichen an: Ein Punkt
 * sähe im Pfad wie eine Dateiendung aus, die Auslieferung des Dashboards antwortete dann mit 404.
 */
function signatur(masterKey: Buffer, nutzlast: string): string {
  return createHmac('sha256', schluessel(masterKey)).update(nutzlast).digest('base64url');
}

export function linkTokenErzeugen(
  masterKey: Buffer,
  ziel: { mandantId: string; repoUrl?: string; sessionId?: string },
  jetzt = new Date(),
): string {
  const inhalt: LinkInhalt = {
    v: 1,
    m: ziel.mandantId,
    ...(ziel.repoUrl ? { u: ziel.repoUrl } : {}),
    ...(ziel.sessionId ? { s: ziel.sessionId } : {}),
    e: Math.floor((jetzt.getTime() + LINK_GUELTIG_MS) / 1000),
  };
  const nutzlast = Buffer.from(JSON.stringify(inhalt), 'utf8').toString('base64url');
  return `${nutzlast}${signatur(masterKey, nutzlast)}`;
}

export type LinkPruefung =
  { art: 'ok'; inhalt: LinkInhalt } | { art: 'ungueltig' } | { art: 'abgelaufen' };

export function linkTokenPruefen(
  masterKey: Buffer,
  token: string,
  jetzt = new Date(),
): LinkPruefung {
  if (token.length <= SIGNATUR_ZEICHEN) return { art: 'ungueltig' };
  const nutzlast = token.slice(0, -SIGNATUR_ZEICHEN);
  const erwartet = Buffer.from(signatur(masterKey, nutzlast));
  const gegeben = Buffer.from(token.slice(-SIGNATUR_ZEICHEN));
  if (gegeben.length !== erwartet.length || !timingSafeEqual(gegeben, erwartet)) {
    return { art: 'ungueltig' };
  }
  let roh: unknown;
  try {
    roh = JSON.parse(Buffer.from(nutzlast, 'base64url').toString('utf8'));
  } catch {
    return { art: 'ungueltig' };
  }
  const inhalt = inhaltSchema.safeParse(roh);
  // Genau ein Ziel: Repo oder Sitzung.
  if (!inhalt.success || !!inhalt.data.u === !!inhalt.data.s) return { art: 'ungueltig' };
  if (inhalt.data.e * 1000 <= jetzt.getTime()) return { art: 'abgelaufen' };
  return { art: 'ok', inhalt: inhalt.data };
}
