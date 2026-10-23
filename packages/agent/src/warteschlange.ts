// Warteschlange auf Platte (Architektur §2.2): Anfragen als JSONL, Sitzungen als JSON-Objekt je
// session_id. Enthält nur, was auch gesendet werden darf (Schema `agentAnfrageSchema`).
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAnfrage, AgentSitzung } from '@seatmeter/shared';
import { haengeAn, leseJson, schreibeAtomar, schreibeJson } from './dateien.js';
import type { Umgebung } from './umgebung.js';

const pfadAnfragen = (u: Umgebung) => join(u.agentDir, 'queue', 'anfragen.jsonl');
const pfadSitzungen = (u: Umgebung) => join(u.agentDir, 'queue', 'sitzungen.json');

export const schluesselVon = (a: Pick<AgentAnfrage, 'request_id' | 'message_id'>) =>
  a.request_id ?? `msg:${a.message_id}`;

export function anfragenAnhaengen(u: Umgebung, liste: AgentAnfrage[]): void {
  if (liste.length === 0) return;
  haengeAn(pfadAnfragen(u), liste.map((a) => `${JSON.stringify(a)}\n`).join(''));
}

/** Lädt die Warteschlange; je Schlüssel gilt der zuletzt angehängte Datensatz. */
export function ladeAnfragen(u: Umgebung): AgentAnfrage[] {
  let text: string;
  try {
    text = readFileSync(pfadAnfragen(u), 'utf8');
  } catch {
    return [];
  }
  const je = new Map<string, AgentAnfrage>();
  for (const zeile of text.split('\n')) {
    if (zeile.trim() === '') continue;
    try {
      const a = JSON.parse(zeile) as AgentAnfrage;
      const k = schluesselVon(a);
      je.delete(k);
      je.set(k, a);
    } catch {
      // kaputte Zeile (z. B. Abbruch beim Schreiben) überspringen
    }
  }
  return [...je.values()];
}

export function ersetzeAnfragen(u: Umgebung, rest: AgentAnfrage[]): void {
  if (rest.length === 0) {
    rmSync(pfadAnfragen(u), { force: true });
    return;
  }
  schreibeAtomar(pfadAnfragen(u), rest.map((a) => `${JSON.stringify(a)}\n`).join(''));
}

export function ladeSitzungen(u: Umgebung): Record<string, AgentSitzung> {
  return leseJson<Record<string, AgentSitzung>>(pfadSitzungen(u)) ?? {};
}

export function ersetzeSitzungen(u: Umgebung, s: Record<string, AgentSitzung>): void {
  if (Object.keys(s).length === 0) {
    rmSync(pfadSitzungen(u), { force: true });
    return;
  }
  schreibeJson(pfadSitzungen(u), s);
}

/** Führt neue Sitzungsmeldungen ein: frühester Start, spätestes Ende, erstes Projekt. */
export function sitzungenMergen(u: Umgebung, neu: AgentSitzung[]): void {
  if (neu.length === 0) return;
  const alle = ladeSitzungen(u);
  for (const s of neu) {
    const v = alle[s.session_id];
    if (!v) {
      alle[s.session_id] = s;
      continue;
    }
    if (s.start < v.start) v.start = s.start;
    if (s.ende && (!v.ende || s.ende > v.ende)) v.ende = s.ende;
    v.projekt ??= s.projekt;
    v.cc_version = s.cc_version ?? v.cc_version;
    v.auth_hinweis = s.auth_hinweis;
  }
  ersetzeSitzungen(u, alle);
}

export function warteschlangeGroesse(u: Umgebung): { anfragen: number; sitzungen: number } {
  return { anfragen: ladeAnfragen(u).length, sitzungen: Object.keys(ladeSitzungen(u)).length };
}
