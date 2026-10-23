// Jira-Client (nur lesend, fetch, keine Jira-Bibliothek): Konto prüfen, Projekte laden, Titel und Status
// einzelner Issues. Cloud: REST v3 mit Basic `email:API-Token`; Data Center: REST v2 mit `Bearer <PAT>`.
// Zeitlimit 10 s je Aufruf, keine Weiterleitungen, Ziele im internen Netz nur mit
// SEATMETER_JIRA_INTERN_ERLAUBT. Fehlermeldungen enthalten nie das Token.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { JiraArt, JiraProjekt } from '@seatmeter/shared';

export type JiraFehlerArt = 'auth' | 'nicht_gefunden' | 'netz' | 'zeit' | 'antwort' | 'ziel';

export class JiraFehler extends Error {
  constructor(
    readonly art: JiraFehlerArt,
    readonly status: number | null,
    meldung: string,
  ) {
    super(meldung);
    this.name = 'JiraFehler';
  }
}

export interface JiraZugang {
  /** Normalisierte Basis-URL ohne abschließenden Schrägstrich (Data Center auch mit Kontextpfad). */
  basisUrl: string;
  art: JiraArt;
  email: string | null;
  token: string;
}

export interface JiraClientOptionen {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** http und Adressen im internen Netz erlauben (Selbstbetrieb, Tests). */
  internErlaubt?: boolean;
  /** Für Tests: Namensauflösung ersetzen. */
  aufloesen?: (host: string) => Promise<string[]>;
}

export const JIRA_TIMEOUT_MS = 10_000;
/** Höchstens so viele Seiten der Projektliste (Cloud, je 50). */
const MAX_SEITEN = 20;

/** IPv4-Adresse aus ihren vier Teilen (die Netze unten stehen als Zahlen, nicht als Adresstext). */
const v4 = (...teile: [number, number, number, number]) => teile.join('.');

const INTERN = new BlockList();
for (const [netz, praefix] of [
  [v4(0, 0, 0, 0), 8],
  [v4(10, 0, 0, 0), 8],
  [v4(100, 64, 0, 0), 10],
  [v4(127, 0, 0, 0), 8],
  [v4(169, 254, 0, 0), 16],
  [v4(172, 16, 0, 0), 12],
  [v4(192, 168, 0, 0), 16],
] as const)
  INTERN.addSubnet(netz, praefix, 'ipv4');
for (const [netz, praefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  INTERN.addSubnet(netz, praefix, 'ipv6');

export function istInterneAdresse(adresse: string): boolean {
  const v = isIP(adresse);
  if (v === 4) return INTERN.check(adresse, 'ipv4');
  if (v === 6) {
    const gemappt = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(adresse);
    if (gemappt?.[1]) return INTERN.check(gemappt[1], 'ipv4');
    return INTERN.check(adresse, 'ipv6');
  }
  return false;
}

/**
 * Prüft und normalisiert die Basis-URL: https (http nur mit `internErlaubt`), ohne Zugangsdaten, Query
 * und Fragment; Pfad ohne abschließenden Schrägstrich. Wirft `JiraFehler('ziel')`.
 */
export function normalisiereBasisUrl(roh: string, internErlaubt = false): string {
  let u: URL;
  try {
    u = new URL(roh.trim());
  } catch {
    throw new JiraFehler('ziel', null, 'Basis-URL ist keine gültige URL');
  }
  if (u.protocol !== 'https:' && !(internErlaubt && u.protocol === 'http:'))
    throw new JiraFehler('ziel', null, 'Basis-URL muss mit https:// beginnen');
  if (u.username || u.password)
    throw new JiraFehler('ziel', null, 'Basis-URL darf keine Zugangsdaten enthalten');
  if (u.search || u.hash)
    throw new JiraFehler('ziel', null, 'Basis-URL ohne Query und Fragment angeben');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!internErlaubt && (host === 'localhost' || istInterneAdresse(host)))
    throw new JiraFehler('ziel', null, 'Ziele im internen Netz sind nicht erlaubt');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

async function zielPruefen(basisUrl: string, o: JiraClientOptionen): Promise<void> {
  if (o.internErlaubt) return;
  const host = new URL(basisUrl).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (istInterneAdresse(host))
      throw new JiraFehler('ziel', null, 'Ziele im internen Netz sind nicht erlaubt');
    return;
  }
  let adressen: string[];
  try {
    adressen = o.aufloesen
      ? await o.aufloesen(host)
      : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new JiraFehler('netz', null, 'Jira-Host nicht auflösbar');
  }
  if (adressen.length === 0 || adressen.some(istInterneAdresse))
    throw new JiraFehler('ziel', null, 'Ziele im internen Netz sind nicht erlaubt');
}

function kopfzeilen(z: JiraZugang): Record<string, string> {
  const anmeldung =
    z.art === 'cloud'
      ? `Basic ${Buffer.from(`${z.email ?? ''}:${z.token}`).toString('base64')}`
      : `Bearer ${z.token}`;
  return { authorization: anmeldung, accept: 'application/json' };
}

const version = (z: JiraZugang) => (z.art === 'cloud' ? '3' : '2');

async function holen(z: JiraZugang, pfad: string, o: JiraClientOptionen): Promise<unknown> {
  await zielPruefen(z.basisUrl, o);
  const f = o.fetch ?? fetch;
  let r: Response;
  try {
    r = await f(`${z.basisUrl}${pfad}`, {
      headers: kopfzeilen(z),
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs ?? JIRA_TIMEOUT_MS),
    });
  } catch (fehler) {
    if (fehler instanceof Error && (fehler.name === 'TimeoutError' || fehler.name === 'AbortError'))
      throw new JiraFehler('zeit', null, 'Jira antwortet nicht (Zeitlimit 10 s)');
    throw new JiraFehler('netz', null, 'Jira nicht erreichbar');
  }
  if (r.status >= 300 && r.status < 400)
    throw new JiraFehler('ziel', r.status, 'Jira leitet weiter (Basis-URL prüfen)');
  if (r.status === 401 || r.status === 403)
    throw new JiraFehler('auth', r.status, 'Jira lehnt den Zugang ab (Token und Rechte prüfen)');
  if (r.status === 404) throw new JiraFehler('nicht_gefunden', 404, 'Bei Jira nicht gefunden');
  if (!r.ok) throw new JiraFehler('antwort', r.status, `Jira antwortet mit HTTP ${r.status}`);
  try {
    return (await r.json()) as unknown;
  } catch {
    throw new JiraFehler('antwort', r.status, 'Jira-Antwort ist kein JSON');
  }
}

const objekt = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const text = (x: unknown, max = 500): string | null =>
  typeof x === 'string' && x !== '' ? x.slice(0, max) : null;

/** Konto prüfen (`/rest/api/{3|2}/myself`); liefert nur den Anzeigenamen. */
export async function jiraMyself(
  z: JiraZugang,
  o: JiraClientOptionen = {},
): Promise<{ konto: string | null }> {
  const d = objekt(await holen(z, `/rest/api/${version(z)}/myself`, o));
  return { konto: text(d.displayName, 200) ?? text(d.name, 200) };
}

function projektAus(x: unknown): JiraProjekt | null {
  const p = objekt(x);
  const schluessel = text(p.key, 50);
  if (!schluessel || !/^[A-Z][A-Z0-9]+$/.test(schluessel)) return null;
  return { schluessel, name: text(p.name, 200) ?? schluessel };
}

/** Projektliste: Cloud `/rest/api/3/project/search` (seitenweise), Data Center `/rest/api/2/project`. */
export async function jiraProjekte(
  z: JiraZugang,
  o: JiraClientOptionen = {},
): Promise<JiraProjekt[]> {
  const aus: JiraProjekt[] = [];
  if (z.art === 'datacenter') {
    const d = await holen(z, '/rest/api/2/project', o);
    for (const p of Array.isArray(d) ? d : []) {
      const x = projektAus(p);
      if (x) aus.push(x);
    }
  } else {
    let start = 0;
    for (let seite = 0; seite < MAX_SEITEN; seite++) {
      const d = objekt(
        await holen(z, `/rest/api/3/project/search?startAt=${start}&maxResults=50&orderBy=key`, o),
      );
      const werte = Array.isArray(d.values) ? d.values : [];
      for (const p of werte) {
        const x = projektAus(p);
        if (x) aus.push(x);
      }
      start += werte.length;
      if (d.isLast === true || werte.length === 0) break;
    }
  }
  return aus.sort((a, b) => a.schluessel.localeCompare(b.schluessel));
}

/** Titel und Status eines Issues; `null`, wenn Jira es nicht kennt (404). */
export async function jiraIssue(
  z: JiraZugang,
  schluessel: string,
  o: JiraClientOptionen = {},
): Promise<{ titel: string | null; status: string | null } | null> {
  try {
    const d = objekt(
      await holen(
        z,
        `/rest/api/${version(z)}/issue/${encodeURIComponent(schluessel)}?fields=summary,status`,
        o,
      ),
    );
    const felder = objekt(d.fields);
    return { titel: text(felder.summary), status: text(objekt(felder.status).name, 100) };
  } catch (fehler) {
    if (fehler instanceof JiraFehler && fehler.art === 'nicht_gefunden') return null;
    throw fehler;
  }
}
