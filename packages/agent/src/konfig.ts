// Konfiguration: Vorgaben vom Server (`GET /api/agent/v1/config`, zwischengespeichert in
// `server-config.json`) plus lokale Überschreibungen in `~/.seatmeter/config.json`.
// Lokale Werte gewinnen je Feld; `exclude_paths` werden vereinigt (Ausschluss geht immer vor).
import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  agentKonfigurationSchema,
  PFAD_PROJEKT_NAME,
  type AgentKonfiguration,
} from '@seatmeter/shared';
import { leseJson, schreibeJson } from './dateien.js';
import type { Umgebung } from './umgebung.js';

export type Modus = AgentKonfiguration['modus'];

export interface LokaleKonfig {
  server_url?: string;
  modus?: Modus;
  sweeper_intervall_min?: number;
  include_paths?: string[];
  exclude_paths?: string[];
  rueckfuellung_tage?: number;
  /**
   * Pfad-Präfix → Projektbezeichnung (nur lokal, nie vom Server): Sitzungen ohne Git-Remote unter
   * diesem Pfad zählen als Pfad-Projekt statt „unzugeordnet“. Gesendet wird nur die Bezeichnung.
   */
  pfad_projekte?: Record<string, string>;
}

export interface PfadProjektRegel {
  /** Absoluter, bereinigter Pfad. */
  pfad: string;
  name: string;
}

export interface WirksameKonfig {
  server_url: string | null;
  modus: Modus;
  sweeper_intervall_min: number;
  /** Absolute, bereinigte Pfade (leer = alle Sitzungen). */
  include_paths: string[];
  exclude_paths: string[];
  rueckfuellung_tage: number;
  /** Längster Pfad zuerst (der genaueste Eintrag gewinnt). */
  pfad_projekte: PfadProjektRegel[];
}

export const pfadLokal = (u: Umgebung) => join(u.agentDir, 'config.json');
export const pfadServer = (u: Umgebung) => join(u.agentDir, 'server-config.json');

export function ladeLokal(u: Umgebung): LokaleKonfig {
  return leseJson<LokaleKonfig>(pfadLokal(u)) ?? {};
}

export function speichereLokal(u: Umgebung, k: LokaleKonfig): void {
  schreibeJson(pfadLokal(u), k);
}

export function ladeServerKonfig(u: Umgebung): AgentKonfiguration | null {
  const roh = leseJson<unknown>(pfadServer(u));
  const p = agentKonfigurationSchema.safeParse(roh);
  return p.success ? p.data : null;
}

export function speichereServerKonfig(u: Umgebung, k: AgentKonfiguration): void {
  schreibeJson(pfadServer(u), k);
}

/** `~` auflösen, absolut machen, abschließenden Trenner entfernen. */
export function normalisierePfad(u: Umgebung, p: string): string {
  let x = p.trim();
  if (x === '~') x = u.home;
  else if (x.startsWith('~/') || x.startsWith('~\\')) x = join(u.home, x.slice(2));
  x = isAbsolute(x) ? resolve(x) : resolve(u.home, x);
  if (x.length > 1 && (x.endsWith('/') || x.endsWith('\\'))) x = x.slice(0, -1);
  return x;
}

/** Pfad plus (falls vorhanden) seine echte Form ohne Symlinks, z. B. `/tmp` → `/private/tmp`. */
function varianten(p: string): string[] {
  try {
    const echt = realpathSync(p);
    return echt === p ? [p] : [p, echt];
  } catch {
    return [p];
  }
}

export function wirksameKonfig(u: Umgebung): WirksameKonfig {
  const server = ladeServerKonfig(u);
  const lokal = ladeLokal(u);
  const liste = (l: string[] | undefined) => [
    ...new Set((l ?? []).flatMap((p) => varianten(normalisierePfad(u, p)))),
  ];
  return {
    server_url: lokal.server_url ?? server?.server_url ?? null,
    modus: lokal.modus ?? server?.modus ?? 'hooks',
    sweeper_intervall_min: lokal.sweeper_intervall_min ?? server?.sweeper_intervall_min ?? 10,
    include_paths: liste(lokal.include_paths ?? server?.include_paths),
    exclude_paths: liste([...(server?.exclude_paths ?? []), ...(lokal.exclude_paths ?? [])]),
    rueckfuellung_tage: lokal.rueckfuellung_tage ?? server?.rueckfuellung_tage ?? 30,
    pfad_projekte: pfadProjektRegeln(u, lokal.pfad_projekte),
  };
}

/** Gültige Bezeichnung eines Pfad-Projekts (wie `pfadProjektSchema`). */
export function istPfadProjektName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && PFAD_PROJEKT_NAME.test(name);
}

function pfadProjektRegeln(
  u: Umgebung,
  roh: Record<string, string> | undefined,
): PfadProjektRegel[] {
  const regeln: PfadProjektRegel[] = [];
  for (const [p, name] of Object.entries(roh ?? {})) {
    if (typeof name !== 'string' || !istPfadProjektName(name.trim())) continue;
    for (const pfad of varianten(normalisierePfad(u, p))) regeln.push({ pfad, name: name.trim() });
  }
  return regeln.sort((a, b) => b.pfad.length - a.pfad.length);
}

/** Pfad-Projekt für ein cwd (längster passender Präfix) oder `null`. */
export function pfadProjektFuer(cwd: string, k: Pick<WirksameKonfig, 'pfad_projekte'>) {
  const p = cwd.length > 1 && (cwd.endsWith('/') || cwd.endsWith('\\')) ? cwd.slice(0, -1) : cwd;
  const regel = k.pfad_projekte.find((r) => liegtUnter(p, r.pfad));
  return regel ? { typ: 'pfad' as const, name: regel.name } : null;
}

function liegtUnter(pfad: string, basis: string): boolean {
  if (pfad === basis) return true;
  const mitTrenner = basis.endsWith(sep) || basis.endsWith('/') ? basis : `${basis}${sep}`;
  return pfad.startsWith(mitTrenner) || (sep !== '/' && pfad.startsWith(`${basis}/`));
}

/**
 * Pfad-Filter (Architektur §2.2): Eine Anfrage zählt nur, wenn ihr `cwd` unter einem
 * eingeschlossenen Pfad liegt (leer = alle) und unter keinem ausgeschlossenen. Ohne `cwd`
 * bleibt sie bei gesetztem Filter auf dem Rechner.
 */
export function istEingeschlossen(cwd: string | null, k: WirksameKonfig): boolean {
  if (cwd === null || cwd === '')
    return k.include_paths.length === 0 && k.exclude_paths.length === 0;
  const p = cwd.length > 1 && (cwd.endsWith('/') || cwd.endsWith('\\')) ? cwd.slice(0, -1) : cwd;
  if (k.exclude_paths.some((b) => liegtUnter(p, b))) return false;
  if (k.include_paths.length === 0) return true;
  return k.include_paths.some((b) => liegtUnter(p, b));
}

/**
 * Name des Projektordners unter `~/.claude/projects/`, den Claude Code für ein Arbeitsverzeichnis
 * anlegt (jedes Zeichen außer Buchstaben und Ziffern wird `-`). Die Kodierung ist verlustbehaftet
 * und dient nur als Vorfilter: Ordner, die zu keinem eingeschlossenen Pfad passen können, liest der
 * Agent gar nicht erst. Maßgeblich bleibt `istEingeschlossen` je Zeile.
 */
export function projektOrdnerName(pfad: string): string {
  return pfad.replace(/[^a-zA-Z0-9]/g, '-');
}
