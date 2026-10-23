// Transkript-Zähler (Architektur §2.2): liest aus den JSONL-Transkripten von Claude Code nur
// Assistant-Zeilen und daraus nur Zähler und Metadaten. `message.content` wird nie gelesen:
// Der JSON-Parser verwirft jedes Feld `content` schon beim Einlesen (Reviver), danach werden nur
// die erlaubten Felder in einen eigenen Datensatz kopiert. Das Format ist intern und kann sich
// ändern; unbekannte oder kaputte Zeilen werden still übersprungen.
// `gitBranch` wird ebenfalls im Reviver verworfen; vorher wird daraus nur der Issue-Schlüssel
// (z. B. `ABC-123`) gelesen. Der Branch-Name selbst landet nie im Datensatz.
import { issueSchluesselAus } from '@seatmeter/shared';

/** Ein Assistant-Eintrag mit Nutzung, ohne Inhalte. `cwd` dient nur dem lokalen Filter. */
export interface AssistentEintrag {
  requestId: string | null;
  messageId: string;
  sessionId: string;
  /** ISO-8601 in UTC. */
  ts: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cache5m: number | null;
  cache1h: number | null;
  webSearch: number;
  speed: string | null;
  serviceTier: string | null;
  inferenceGeo: string | null;
  isSidechain: boolean;
  version: string | null;
  /** Nur lokal (Pfad-Filter, Projekt-Erkennung); verlässt den Rechner nie. */
  cwd: string | null;
  /**
   * Issue-Schlüssel aus `gitBranch` der Zeile (groß, ohne Doppelte); `[]` = Branch ohne Schlüssel,
   * `null` = Zeile ohne Branch-Angabe.
   */
  issueSchluessel: string[] | null;
}

const ASSISTENT = /"type"\s*:\s*"assistant"/;

/** Felder, die beim Einlesen sofort verworfen werden (Inhalte und Zweige). */
const VERWORFEN = new Set(['content', 'gitBranch', 'toolUseResult', 'thinking', 'text', 'input']);

/** Parst eine Zeile; `gitBranch` liefert nur seine Issue-Schlüssel und wird dann verworfen. */
function parsen(zeile: string): { roh: unknown; issueSchluessel: string[] | null } {
  let issueSchluessel: string[] | null = null;
  const roh: unknown = JSON.parse(
    zeile,
    function (this: unknown, schluessel: string, wert: unknown) {
      if (schluessel === 'gitBranch') {
        if (typeof wert === 'string' && issueSchluessel === null)
          issueSchluessel = issueSchluesselAus(wert);
        return undefined;
      }
      // `input` nur in Inhaltsblöcken verwerfen, nicht `input_tokens` (anderer Schlüssel).
      return VERWORFEN.has(schluessel) ? undefined : wert;
    },
  );
  return { roh, issueSchluessel };
}

function obj(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function zahl(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
}

function zahlOderNull(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null;
}

function text(x: unknown, max: number): string | null {
  return typeof x === 'string' && x !== '' && x.length <= max ? x : null;
}

/** Liest eine Zeile; liefert `null` für alles außer Assistant-Zeilen mit Nutzung. */
export function leseZeile(zeile: string): AssistentEintrag | null {
  if (!ASSISTENT.test(zeile)) return null;
  let roh: unknown;
  let issueSchluessel: string[] | null;
  try {
    ({ roh, issueSchluessel } = parsen(zeile));
  } catch {
    return null;
  }
  const d = obj(roh);
  if (!d || d.type !== 'assistant') return null;
  const m = obj(d.message);
  const usage = obj(m?.usage);
  if (!m || !usage) return null;
  const messageId = text(m.id, 200);
  const model = text(m.model, 200);
  const sessionId = text(d.sessionId, 200);
  const zeit = typeof d.timestamp === 'string' ? new Date(d.timestamp) : null;
  if (!messageId || !model || !sessionId || !zeit || Number.isNaN(zeit.getTime())) return null;
  // Synthetische Meldungen von Claude Code (z. B. API-Fehler) sind keine Anfragen.
  if (model.startsWith('<') || d.isApiErrorMessage === true) return null;
  const cc = obj(usage.cache_creation);
  const stu = obj(usage.server_tool_use);
  const e: AssistentEintrag = {
    requestId: text(d.requestId, 200),
    messageId,
    sessionId,
    ts: zeit.toISOString(),
    model,
    input: zahl(usage.input_tokens),
    output: zahl(usage.output_tokens),
    cacheRead: zahl(usage.cache_read_input_tokens),
    cacheCreation: zahl(usage.cache_creation_input_tokens),
    cache5m: cc ? zahlOderNull(cc.ephemeral_5m_input_tokens) : null,
    cache1h: cc ? zahlOderNull(cc.ephemeral_1h_input_tokens) : null,
    webSearch: stu ? zahl(stu.web_search_requests) : 0,
    speed: text(usage.speed, 50),
    serviceTier: text(usage.service_tier, 50),
    inferenceGeo: text(usage.inference_geo, 50),
    isSidechain: d.isSidechain === true,
    version: text(d.version, 50),
    cwd: typeof d.cwd === 'string' && d.cwd !== '' ? d.cwd : null,
    issueSchluessel,
  };
  if (e.input + e.output + e.cacheRead + e.cacheCreation === 0) return null;
  return e;
}

/** Schlüssel der Anfrage (Architektur §3.1): `request_id`, sonst `msg:<message.id>`. */
export function anfrageKey(e: Pick<AssistentEintrag, 'requestId' | 'messageId'>): string {
  return e.requestId ?? `msg:${e.messageId}`;
}

/** Fingerabdruck eines Beitrags (gleich = nichts Neues zu senden). */
export function fingerabdruck(e: AssistentEintrag): string {
  return [
    e.requestId ?? '',
    e.input,
    e.output,
    e.cacheRead,
    e.cacheCreation,
    e.cache5m ?? '',
    e.cache1h ?? '',
    e.webSearch,
    e.speed ?? '',
  ].join('|');
}
