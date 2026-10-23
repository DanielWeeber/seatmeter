// Allowlist und Normalisierung der Claude-Code-Telemetrie (Architektur §2.1, §3.2, §4).
// Gelesen werden nur die Werte erlaubter Attribute; von allen anderen Attributen wird nur der Name
// angesehen (Erkennung von Inhaltsattributen für den Zähler `verworfen_inhalt`). E-Mail und Konto-IDs
// werden hier sofort gehasht; die Rohwerte verlassen diese Datei nicht.
import { issueSchluesselAus, OTEL_ATTRIBUT_ISSUE, type AuthKlasse } from '@seatmeter/shared';
import { personSchluessel, type PersonSchluessel } from '../ingest-gemeinsam/speichern.js';

type Wert = string | number | boolean | null;
type Roh = Record<string, unknown>;

/** Attribute, die übernommen werden (Ereignis `api_request`, `auth` und Metriken). */
const ERLAUBT_STANDARD = [
  'event.name',
  'event.timestamp',
  'session.id',
  'organization.id',
  'user.account_uuid',
  'user.account_id',
  'user.email',
  'user.id',
  'identity.source',
  'app.version',
  'vcs.repository.url.full',
  'vcs.owner.name',
  'vcs.repository.name',
  'vcs.provider.name',
] as const;

/**
 * Issue-Schlüssel: `seatmeter.issue_schluessel` setzt der Start-Wrapper über
 * `OTEL_RESOURCE_ATTRIBUTES` (Claude Code kopiert Ressourcen-Attribute auch in die Ereignisse).
 * `vcs.ref.head.name` (Branch) sendet Claude Code 2.1.309 nicht; käme es, wird daraus sofort nur der
 * Schlüssel gelesen und der Wert verworfen (nie gespeichert, nie geloggt).
 */
const ATTRIBUT_BRANCH = 'vcs.ref.head.name';

const ERLAUBT_API_REQUEST = new Set<string>([
  ...ERLAUBT_STANDARD,
  OTEL_ATTRIBUT_ISSUE,
  ATTRIBUT_BRANCH,
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'request_id',
  'client_request_id',
  'speed',
  'query_source',
  'cost_usd_micros',
  'cost_usd',
]);

const ERLAUBT_AUTH = new Set<string>([...ERLAUBT_STANDARD, 'action', 'success', 'auth_method']);

const ERLAUBT_METRIK = new Set<string>([...ERLAUBT_STANDARD, 'type', 'model', 'query_source']);

const ERLAUBT_RESSOURCE = new Set<string>([
  'service.name',
  'service.version',
  'os.type',
  OTEL_ATTRIBUT_ISSUE,
]);

/** Attributnamen, die Inhalte tragen können (nur der Name wird geprüft, nie der Wert). */
const INHALTS_ATTRIBUTE = new Set<string>([
  'prompt',
  'prompt_text',
  'tool_parameters',
  'tool_input',
  'tool_output',
  'tool_result',
  'api_request_body',
  'api_response_body',
  'request_body',
  'response_body',
  'response',
  'assistant_response',
  'content',
  'messages',
]);

/** Ereignisse, die per Definition Inhalte transportieren. */
const INHALTS_EREIGNISSE = new Set<string>([
  'user_prompt',
  'tool_result',
  'api_request_body',
  'api_response_body',
  'assistant_response',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function istObjekt(w: unknown): w is Roh {
  return typeof w === 'object' && w !== null && !Array.isArray(w);
}

function liste(w: unknown): unknown[] {
  return Array.isArray(w) ? w : [];
}

/** Einfacher Wert aus `AnyValue`; Listen, Maps und Bytes werden nicht gelesen. */
function anyWert(v: unknown): Wert {
  if (!istObjekt(v)) return null;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : null;
  }
  if (v.doubleValue !== undefined) {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  return null;
}

interface Attribute {
  werte: Map<string, Wert>;
  /** Mindestens ein Attribut mit Inhaltsnamen war vorhanden. */
  inhalt: boolean;
}

/** Liest nur erlaubte Attribute; bei allen anderen wird nur der Name geprüft. */
function attributeLesen(roh: unknown, erlaubt: ReadonlySet<string>, ziel?: Attribute): Attribute {
  const a = ziel ?? { werte: new Map<string, Wert>(), inhalt: false };
  for (const kv of liste(roh)) {
    if (!istObjekt(kv) || typeof kv.key !== 'string') continue;
    if (erlaubt.has(kv.key)) a.werte.set(kv.key, anyWert(kv.value));
    else if (INHALTS_ATTRIBUTE.has(kv.key)) a.inhalt = true;
  }
  return a;
}

function text(a: Map<string, Wert>, k: string, max = 200): string | null {
  const w = a.get(k);
  if (w === null || w === undefined) return null;
  const s = String(w).trim();
  return s === '' ? null : s.slice(0, max);
}

function zahl(a: Map<string, Wert>, k: string): number | null {
  const w = a.get(k);
  if (w === null || w === undefined || w === '') return null;
  const n = typeof w === 'number' ? w : Number(w);
  return Number.isFinite(n) ? n : null;
}

function tokens(a: Map<string, Wert>, k: string): number | null {
  const n = zahl(a, k) ?? 0;
  return Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

/** Zeit aus `event.timestamp` (ISO), sonst `timeUnixNano`, sonst `observedTimeUnixNano`. */
function zeitpunkt(eventTs: string | null, ...nanos: unknown[]): Date | null {
  if (eventTs) {
    const d = new Date(eventTs);
    if (Number.isFinite(d.getTime())) return d;
  }
  for (const n of nanos) {
    if (n === undefined || n === null || n === '' || n === '0' || n === 0) continue;
    try {
      const ms = Number(BigInt(String(n)) / 1_000_000n);
      if (ms > 0) return new Date(ms);
    } catch {
      // ungültiger Wert: nächste Quelle versuchen
    }
  }
  return null;
}

function ereignisName(rec: Roh, a: Map<string, Wert>): string | null {
  const kandidaten = [rec.eventName, a.get('event.name')];
  const body = istObjekt(rec.body) ? rec.body.stringValue : undefined;
  // Der Körper wird nur mit dem Namensmuster verglichen, nie gespeichert.
  if (typeof body === 'string' && /^claude_code\.[a-z_.]+$/.test(body)) kandidaten.push(body);
  for (const k of kandidaten) {
    if (typeof k === 'string' && k.trim() !== '') return k.trim().replace(/^claude_code\./, '');
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

/** Gemeinsame Identitätsangaben (Standardattribute), bereits gehasht. */
export interface Identitaet {
  sessionId: string | null;
  orgUuid: string | null;
  person: PersonSchluessel;
  hatKonto: boolean;
  hatUserId: boolean;
  identitySource: string | null;
}

export interface ProjektAngabeA {
  url: string;
  owner: string | null;
  repoName: string | null;
  provider: string | null;
}

export interface ApiAnfrageA extends Identitaet {
  anfrageKey: string;
  ts: Date;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  speed: string | null;
  querySource: string | null;
  kostenMicros: number | null;
  ccVersion: string | null;
  projekt: ProjektAngabeA | null;
  /** Issue-Schlüssel (nie der Branch-Name); `null` = keine Angabe in der Telemetrie. */
  issueSchluessel: string[] | null;
}

export interface AuthEreignisA extends Identitaet {
  ts: Date;
  ccVersion: string | null;
  erfolgreich: boolean;
  methode: string | null;
}

export interface LogAuswertung {
  anfragen: ApiAnfrageA[];
  auths: AuthEreignisA[];
  verworfenInhalt: number;
  /** Ereignisse außerhalb der Allowlist ohne Inhaltsbezug (nur gezählt für die Antwort, nicht gespeichert). */
  ignoriert: number;
  abgelehnt: number;
  meldungen: Set<string>;
}

function identitaet(a: Map<string, Wert>, personSalt: Uint8Array): Identitaet {
  const accountUuid = text(a, 'user.account_uuid');
  const accountId = text(a, 'user.account_id');
  const email = text(a, 'user.email', 320);
  const org = text(a, 'organization.id');
  return {
    sessionId: text(a, 'session.id'),
    orgUuid: org && UUID.test(org) ? org.toLowerCase() : null,
    // Primärkennung: account_uuid (auch Quelle B kennt sie), sonst account_id (Architektur §3.2).
    person: personSchluessel(personSalt, {
      konto: accountUuid ?? accountId,
      kontoId: accountId,
      email,
    }),
    hatKonto: Boolean(accountUuid || accountId || email),
    hatUserId: Boolean(text(a, 'user.id')),
    identitySource: text(a, 'identity.source', 50),
  };
}

/**
 * Issue-Schlüssel aus dem Ereignis, sonst aus der Ressource. Ein Branch-Name (`vcs.ref.head.name`)
 * wird nur nach Schlüsseln durchsucht und danach aus der Attributliste gelöscht.
 */
function issueSchluesselAusAttributen(
  a: Map<string, Wert>,
  ressource: Map<string, Wert>,
): string[] | null {
  const branch = a.get(ATTRIBUT_BRANCH);
  a.delete(ATTRIBUT_BRANCH);
  const wert = a.get(OTEL_ATTRIBUT_ISSUE) ?? ressource.get(OTEL_ATTRIBUT_ISSUE);
  if (typeof wert === 'string') return issueSchluesselAus(wert);
  if (typeof branch === 'string') return issueSchluesselAus(branch);
  return null;
}

function projektAusVcs(a: Map<string, Wert>): ProjektAngabeA | null {
  const url = text(a, 'vcs.repository.url.full', 500);
  if (!url) return null;
  return {
    url,
    owner: text(a, 'vcs.owner.name'),
    repoName: text(a, 'vcs.repository.name'),
    provider: text(a, 'vcs.provider.name', 50),
  };
}

/** Abo-Regel (Architektur §4) für Quelle A. */
export function klassifizieren(i: Identitaet, orgs: ReadonlySet<string>): AuthKlasse {
  if (i.identitySource === 'gateway-oidc') return 'provider';
  if (!i.hatKonto) return i.hatUserId ? 'api' : 'unbekannt';
  if (!i.orgUuid) return 'unbekannt';
  return orgs.has(i.orgUuid) ? 'abo' : 'fremd_org';
}

/** Wertet `ExportLogsServiceRequest` (JSON-Form) aus. */
export function logsAuswerten(anfrage: Roh, personSalt: Uint8Array): LogAuswertung {
  const aus: LogAuswertung = {
    anfragen: [],
    auths: [],
    verworfenInhalt: 0,
    ignoriert: 0,
    abgelehnt: 0,
    meldungen: new Set(),
  };
  for (const rl of liste(anfrage.resourceLogs)) {
    if (!istObjekt(rl)) continue;
    const ressource = attributeLesen(
      istObjekt(rl.resource) ? rl.resource.attributes : [],
      ERLAUBT_RESSOURCE,
    ).werte;
    const ccVersionRessource = text(ressource, 'service.version', 50);
    for (const sl of liste(rl.scopeLogs)) {
      if (!istObjekt(sl)) continue;
      for (const rec of liste(sl.logRecords)) {
        if (!istObjekt(rec)) continue;
        // Zuerst nur die Namen prüfen; Werte nur für erlaubte Attribute lesen.
        const vorab = attributeLesen(rec.attributes, new Set(['event.name']));
        const name = ereignisName(rec, vorab.werte);
        if (name !== 'api_request' && name !== 'auth') {
          if ((name && INHALTS_EREIGNISSE.has(name)) || vorab.inhalt) aus.verworfenInhalt++;
          else aus.ignoriert++;
          continue;
        }
        const erlaubt = name === 'api_request' ? ERLAUBT_API_REQUEST : ERLAUBT_AUTH;
        const a = attributeLesen(rec.attributes, erlaubt).werte;
        const ts = zeitpunkt(
          text(a, 'event.timestamp'),
          rec.timeUnixNano,
          rec.observedTimeUnixNano,
        );
        const ccVersion = text(a, 'app.version', 50) ?? ccVersionRessource;
        if (!ts) {
          aus.abgelehnt++;
          aus.meldungen.add('Zeitstempel fehlt');
          continue;
        }
        const ident = identitaet(a, personSalt);
        if (name === 'auth') {
          aus.auths.push({
            ...ident,
            ts,
            ccVersion,
            erfolgreich: String(a.get('success') ?? '').toLowerCase() === 'true',
            methode: text(a, 'auth_method', 50),
          });
          continue;
        }
        const requestId = text(a, 'request_id');
        const clientRequestId = text(a, 'client_request_id');
        const model = text(a, 'model');
        const input = tokens(a, 'input_tokens');
        const output = tokens(a, 'output_tokens');
        const cacheRead = tokens(a, 'cache_read_tokens');
        const cacheCreation = tokens(a, 'cache_creation_tokens');
        if (!requestId && !clientRequestId) {
          aus.abgelehnt++;
          aus.meldungen.add('api_request ohne request_id und client_request_id');
          continue;
        }
        if (
          !model ||
          input === null ||
          output === null ||
          cacheRead === null ||
          cacheCreation === null
        ) {
          aus.abgelehnt++;
          aus.meldungen.add('api_request mit ungültigem Modell oder Tokenzahlen');
          continue;
        }
        const micros = zahl(a, 'cost_usd_micros');
        const usd = zahl(a, 'cost_usd');
        const kosten =
          micros !== null ? Math.round(micros) : usd !== null ? Math.round(usd * 1_000_000) : null;
        aus.anfragen.push({
          ...ident,
          // Fallback ohne request_id (ältere Versionen): `msg:<client_request_id>` (Abschnitt 14).
          anfrageKey: requestId ?? `msg:${clientRequestId}`,
          ts,
          model,
          input,
          output,
          cacheRead,
          cacheCreation,
          speed: text(a, 'speed', 50),
          querySource: text(a, 'query_source', 100),
          kostenMicros: kosten !== null && kosten >= 0 ? kosten : null,
          ccVersion,
          projekt: projektAusVcs(a),
          issueSchluessel: issueSchluesselAusAttributen(a, ressource),
        });
      }
    }
  }
  return aus;
}

// ---------------------------------------------------------------------------------------------
// Metriken

/**
 * Kontrollsummen (`otel_kontrollsumme.typ`) gibt es nur aus `claude_code.token.usage`, und nur für die
 * vier Tokentypen: Die Datenqualität vergleicht die Summe aller `wert` je Sitzung mit den gezählten
 * Tokens. `claude_code.cost.usage` und `claude_code.session.count` werden wie alle übrigen Metriken
 * ignoriert (Kosten stehen je Anfrage in `anfrage.cc_kosten_usd_micros`).
 */
const KONTROLL_METRIK = 'claude_code.token.usage';
export const KONTROLL_TYPEN = new Set(['input', 'output', 'cacheRead', 'cacheCreation']);

export interface KontrollPunkt extends Identitaet {
  typ: string;
  model: string;
  querySource: string;
  ts: Date;
  wert: number;
  kumulativ: boolean;
}

export interface MetrikAuswertung {
  punkte: KontrollPunkt[];
  ignoriert: number;
  abgelehnt: number;
  meldungen: Set<string>;
}

const TEMPORALITAET_KUMULATIV = 2;

/** Wertet `ExportMetricsServiceRequest` (JSON-Form) aus; nur Tokentypen aus `claude_code.token.usage`. */
export function metrikenAuswerten(anfrage: Roh, personSalt: Uint8Array): MetrikAuswertung {
  const aus: MetrikAuswertung = { punkte: [], ignoriert: 0, abgelehnt: 0, meldungen: new Set() };
  for (const rm of liste(anfrage.resourceMetrics)) {
    if (!istObjekt(rm)) continue;
    for (const sm of liste(rm.scopeMetrics)) {
      if (!istObjekt(sm)) continue;
      for (const m of liste(sm.metrics)) {
        if (!istObjekt(m) || m.name !== KONTROLL_METRIK) {
          aus.ignoriert++;
          continue;
        }
        if (!istObjekt(m.sum)) {
          aus.ignoriert++;
          continue;
        }
        const kumulativ = Number(m.sum.aggregationTemporality) === TEMPORALITAET_KUMULATIV;
        for (const dp of liste(m.sum.dataPoints)) {
          if (!istObjekt(dp)) continue;
          const a = attributeLesen(dp.attributes, ERLAUBT_METRIK).werte;
          const roh = dp.asDouble !== undefined ? Number(dp.asDouble) : Number(dp.asInt ?? NaN);
          const ts = zeitpunkt(null, dp.timeUnixNano, dp.startTimeUnixNano);
          if (!Number.isFinite(roh) || roh < 0 || !ts) {
            aus.abgelehnt++;
            aus.meldungen.add('Datenpunkt ohne gültigen Wert oder Zeitstempel');
            continue;
          }
          const typ = text(a, 'type', 50) ?? '';
          if (!KONTROLL_TYPEN.has(typ)) {
            aus.ignoriert++;
            continue;
          }
          const wert = Math.round(roh);
          aus.punkte.push({
            ...identitaet(a, personSalt),
            typ,
            model: text(a, 'model') ?? '',
            querySource: text(a, 'query_source', 100) ?? '',
            ts,
            wert,
            kumulativ,
          });
        }
      }
    }
  }
  return aus;
}
