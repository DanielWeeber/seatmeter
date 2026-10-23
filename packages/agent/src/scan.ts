// Inkrementeller Scan (Architektur §2.2): liest geänderte Transkripte ab dem gespeicherten Offset,
// wendet den Pfad-Filter je Zeile an, erkennt das Projekt je cwd und hängt Datensätze an die
// Warteschlange. Ordner unter ~/.claude/projects, die zu keinem eingeschlossenen Pfad passen
// können, werden gar nicht gelesen (Bereichstrennung, §10.4).
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { AgentAnfrage, AgentSitzung, AuthHinweis } from '@seatmeter/shared';
import { istEingeschlossen, projektOrdnerName, type WirksameKonfig } from './konfig.js';
import { projektFuer } from './projekt.js';
import { anfrageKey, fingerabdruck, leseZeile, type AssistentEintrag } from './transkript.js';
import type { Umgebung } from './umgebung.js';
import { anfragenAnhaengen, sitzungenMergen } from './warteschlange.js';
import { OFFEN_BEHALTEN, type DateiZustand, type Zustand } from './zustand.js';

/** Begrenzte Map je Datei: message.id → letzter Beitrag (CCAM `rememberUsageContribution`). */
export const OFFEN_MAX = 1000;
const BLOCK = 1 << 20;

export interface ScanErgebnis {
  dateien: number;
  geaendert: number;
  anfragen: number;
  /** Assistant-Zeilen außerhalb des Pfad-Filters (bleiben auf dem Rechner). */
  ausserhalb: number;
  sitzungen: number;
}

export interface ScanOptionen {
  hinweis: AuthHinweis;
  /** Nur diese Dateien (Hook: Transkript der Sitzung und ihre Subagenten). */
  nurDateien?: string[];
}

export function projekteOrdner(u: Umgebung): string {
  return join(u.claudeDir, 'projects');
}

/** Projektordner, die zum Filter passen können (Vorfilter über den kodierten Ordnernamen). */
export function passendeOrdner(u: Umgebung, k: WirksameKonfig): string[] {
  const basis = projekteOrdner(u);
  let namen: string[];
  try {
    namen = readdirSync(basis, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const praefixe = k.include_paths.map(projektOrdnerName);
  return namen
    .filter((n) => praefixe.length === 0 || praefixe.some((p) => n.startsWith(p)))
    .sort()
    .map((n) => join(basis, n));
}

function jsonlUnter(ordner: string, ergebnis: string[], tiefe: number): void {
  if (tiefe > 4) return;
  let eintraege;
  try {
    eintraege = readdirSync(ordner, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of eintraege) {
    const p = join(ordner, e.name);
    if (e.isDirectory()) jsonlUnter(p, ergebnis, tiefe + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) ergebnis.push(p);
  }
}

/** Transkripte eines Projektordners: `<session>.jsonl` und `<session>/subagents/**.jsonl`. */
export function transkriptDateien(ordner: string): string[] {
  const dateien: string[] = [];
  let eintraege;
  try {
    eintraege = readdirSync(ordner, { withFileTypes: true });
  } catch {
    return dateien;
  }
  for (const e of eintraege) {
    const p = join(ordner, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) dateien.push(p);
    else if (e.isDirectory()) {
      const sub = join(p, 'subagents');
      if (existsSync(sub)) jsonlUnter(sub, dateien, 0);
    }
  }
  return dateien.sort();
}

/** Transkript einer Sitzung plus ihre Subagent-Dateien (`<session>/subagents/**.jsonl`). */
export function dateienDerSitzung(transkript: string): string[] {
  const dateien = [transkript];
  jsonlUnter(join(transkript.replace(/\.jsonl$/, ''), 'subagents'), dateien, 0);
  return dateien;
}

/** Subagent-Datei, wenn ein Pfadteil `subagents` heißt. */
export function istSubagentDatei(pfad: string): boolean {
  return pfad.split(sep).includes('subagents') || pfad.split('/').includes('subagents');
}

/** Liest vollständige Zeilen ab `offset`; liefert sie samt neuem Offset (nach dem letzten `\n`). */
function leseAb(
  pfad: string,
  offset: number,
  groesse: number,
): { zeilen: string[]; offset: number } {
  const fd = openSync(pfad, 'r');
  const zeilen: string[] = [];
  let pos = offset;
  let rest = Buffer.alloc(0);
  try {
    while (pos < groesse) {
      const puffer = Buffer.alloc(Math.min(BLOCK, groesse - pos));
      const n = readSync(fd, puffer, 0, puffer.length, pos);
      if (n <= 0) break;
      pos += n;
      const daten =
        rest.length > 0 ? Buffer.concat([rest, puffer.subarray(0, n)]) : puffer.subarray(0, n);
      const letztes = daten.lastIndexOf(0x0a);
      if (letztes < 0) {
        rest = Buffer.from(daten);
        continue;
      }
      for (const z of daten.subarray(0, letztes).toString('utf8').split('\n'))
        if (z !== '') zeilen.push(z);
      rest = Buffer.from(daten.subarray(letztes + 1));
    }
  } finally {
    closeSync(fd);
  }
  return { zeilen, offset: pos - rest.length };
}

function zuAnfrage(
  e: AssistentEintrag,
  subagent: boolean,
  hinweis: AuthHinweis,
  projekt: AgentAnfrage['projekt'],
): AgentAnfrage {
  return {
    request_id: e.requestId,
    message_id: e.messageId,
    session_id: e.sessionId,
    ts: e.ts,
    model: e.model,
    input_tokens: e.input,
    output_tokens: e.output,
    cache_read_input_tokens: e.cacheRead,
    cache_creation_input_tokens: e.cacheCreation,
    cache_write_5m: e.cache5m,
    cache_write_1h: e.cache1h,
    web_search_requests: e.webSearch,
    speed: e.speed,
    service_tier: e.serviceTier,
    inference_geo: e.inferenceGeo,
    ist_subagent: subagent || e.isSidechain,
    cc_version: e.version,
    projekt,
    auth_hinweis: hinweis,
    // Nur der Schlüssel aus dem Branch-Namen; ohne Branch-Angabe fehlt das Feld.
    ...(e.issueSchluessel ? { issue_schluessel: e.issueSchluessel } : {}),
  };
}

/**
 * Scannt alle passenden Transkripte inkrementell und hängt neue bzw. geänderte Anfragen an die
 * Warteschlange. Der Zustand `z` wird angepasst (Aufrufer speichert ihn).
 */
export function scanne(u: Umgebung, k: WirksameKonfig, z: Zustand, o: ScanOptionen): ScanErgebnis {
  const ergebnis: ScanErgebnis = {
    dateien: 0,
    geaendert: 0,
    anfragen: 0,
    ausserhalb: 0,
    sitzungen: 0,
  };
  const grenze = u.jetzt().getTime() - k.rueckfuellung_tage * 86_400_000;
  const praefixe = k.include_paths.map(projektOrdnerName);
  const dateien =
    o.nurDateien?.filter((d) => {
      // Auch im Hook nur Dateien aus passenden Projektordnern lesen.
      const ordner = basename(dirname(d.split(`${sep}subagents${sep}`)[0] ?? d));
      return (
        d.startsWith(projekteOrdner(u)) &&
        (praefixe.length === 0 || praefixe.some((p) => ordner.startsWith(p)))
      );
    }) ?? passendeOrdner(u, k).flatMap(transkriptDateien);

  const neu = new Map<string, AgentAnfrage>();
  const sitzungen = new Map<string, AgentSitzung>();
  const gesehen = new Set<string>();

  for (const pfad of dateien) {
    ergebnis.dateien++;
    gesehen.add(pfad);
    const st = statSync(pfad, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.mtimeMs < grenze) continue;
    let alt: DateiZustand | undefined = z.dateien[pfad];
    // Neue Datei oder ersetzt/gekürzt: von vorn lesen (Server-Upsert ist idempotent).
    if (alt && (alt.ino !== st.ino || st.size < alt.offset)) alt = undefined;
    if (alt && alt.offset === st.size) continue;
    ergebnis.geaendert++;
    const offen = new Map<string, string>(Object.entries(alt?.offen ?? {}));
    const { zeilen, offset } = leseAb(pfad, alt?.offset ?? 0, st.size);
    const subagent = istSubagentDatei(pfad.slice(projekteOrdner(u).length));
    for (const zeile of zeilen) {
      const e = leseZeile(zeile);
      if (!e) continue;
      if (!istEingeschlossen(e.cwd, k)) {
        ergebnis.ausserhalb++;
        continue;
      }
      if (new Date(e.ts).getTime() < grenze) continue;
      const fp = fingerabdruck(e);
      if (offen.get(e.messageId) === fp) continue;
      offen.delete(e.messageId);
      offen.set(e.messageId, fp);
      if (offen.size > OFFEN_MAX) {
        const aeltester = offen.keys().next().value;
        if (aeltester !== undefined) offen.delete(aeltester);
      }
      const projekt = e.cwd ? projektFuer(u, z, e.cwd, k) : null;
      const a = zuAnfrage(e, subagent, o.hinweis, projekt);
      const key = anfrageKey(e);
      neu.delete(key);
      neu.set(key, a);
      const s = sitzungen.get(e.sessionId);
      if (!s) {
        sitzungen.set(e.sessionId, {
          session_id: e.sessionId,
          start: e.ts,
          ende: e.ts,
          cc_version: e.version,
          projekt,
          auth_hinweis: o.hinweis,
        });
      } else {
        if (e.ts < s.start) s.start = e.ts;
        if (!s.ende || e.ts > s.ende) s.ende = e.ts;
        s.cc_version = e.version ?? s.cc_version;
        s.projekt ??= projekt;
      }
    }
    z.dateien[pfad] = {
      ino: st.ino,
      groesse: st.size,
      offset,
      offen: Object.fromEntries([...offen.entries()].slice(-OFFEN_BEHALTEN)),
    };
  }
  // Zustand verschwundener Dateien entfernen (nur beim Vollscan).
  if (!o.nurDateien)
    for (const p of Object.keys(z.dateien)) if (!gesehen.has(p)) delete z.dateien[p];

  anfragenAnhaengen(u, [...neu.values()]);
  sitzungenMergen(u, [...sitzungen.values()]);
  ergebnis.anfragen = neu.size;
  ergebnis.sitzungen = sitzungen.size;
  z.letzter_scan = u.jetzt().toISOString();
  return ergebnis;
}
