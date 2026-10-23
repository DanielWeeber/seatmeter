// Lokaler Zustand in ~/.seatmeter/state.json: je Transkriptdatei Inode, Größe, Offset und die
// zuletzt gesehenen Beiträge je message.id; dazu Projekt-Cache je cwd, Push- und Heartbeat-Status.
// Die Datei bleibt auf dem Rechner (enthält lokale Pfade) und wird nie gesendet.
import { join } from 'node:path';
import type { ProjektAngabe } from '@seatmeter/shared';
import { leseJson, schreibeJson } from './dateien.js';
import type { Umgebung } from './umgebung.js';

export interface DateiZustand {
  ino: number;
  groesse: number;
  offset: number;
  /** message.id → Fingerabdruck des letzten Beitrags (nur die jüngsten Einträge). */
  offen: Record<string, string>;
}

export interface ProjektCacheEintrag {
  projekt: ProjektAngabe | null;
  geprueft: string;
}

export interface Zustand {
  version: 1;
  dateien: Record<string, DateiZustand>;
  projekte: Record<string, ProjektCacheEintrag>;
  push: {
    letzter_erfolg: string | null;
    letzter_versuch: string | null;
    naechster_versuch: string | null;
    fehlversuche: number;
    letzter_fehler: string | null;
    gesendet_gesamt: number;
  };
  /** Lebenszeichen an den Server (`POST /api/agent/v1/heartbeat`) nach jedem Push-Lauf. */
  heartbeat: {
    letzter_erfolg: string | null;
    letzter_fehler: string | null;
  };
  token_ungueltig: boolean;
  letzter_scan: string | null;
}

/** So viele Beiträge je Datei bleiben über einen Scan hinaus gespeichert (Streaming-Nachzügler). */
export const OFFEN_BEHALTEN = 20;

export const pfadZustand = (u: Umgebung) => join(u.agentDir, 'state.json');

export function leererZustand(): Zustand {
  return {
    version: 1,
    dateien: {},
    projekte: {},
    push: {
      letzter_erfolg: null,
      letzter_versuch: null,
      naechster_versuch: null,
      fehlversuche: 0,
      letzter_fehler: null,
      gesendet_gesamt: 0,
    },
    heartbeat: { letzter_erfolg: null, letzter_fehler: null },
    token_ungueltig: false,
    letzter_scan: null,
  };
}

export function ladeZustand(u: Umgebung): Zustand {
  const z = leseJson<Partial<Zustand>>(pfadZustand(u));
  const leer = leererZustand();
  if (!z || z.version !== 1) return leer;
  return {
    ...leer,
    ...z,
    dateien: z.dateien ?? {},
    projekte: z.projekte ?? {},
    push: { ...leer.push, ...(z.push ?? {}) },
    heartbeat: { ...leer.heartbeat, ...(z.heartbeat ?? {}) },
  };
}

export function speichereZustand(u: Umgebung, z: Zustand): void {
  schreibeJson(pfadZustand(u), z);
}
