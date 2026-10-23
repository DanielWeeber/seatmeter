// Vite-Plugin für das virtuelle Modul `virtual:seatmeter-web-plugins` (Architektur §8, Lizenzgrenze).
// SEATMETER_WEB_PLUGINS = kommagetrennte Paketnamen aus dem pnpm-Workspace (z. B. `@seatmeter/ee-web`).
// Aufgelöst wird über das Feld `source` der package.json des Pakets (Quelltext, von Vite mitgebaut);
// ohne Variable exportiert das Modul eine leere Liste. Der Kern-Quelltext nennt kein Plugin-Paket.
// Tailwind scannt nur das Dashboard-Verzeichnis; deshalb ergänzt das Plugin in `src/index.css` je Web-Plugin
// eine `@source`-Zeile für dessen Ordner (vor dem Tailwind-Plugin, `enforce: 'pre'`).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export const VIRTUELLES_MODUL = 'virtual:seatmeter-web-plugins';
const AUFGELOEST = `\0${VIRTUELLES_MODUL}`;

/** Paketnamen aus der Umgebungsvariable (leer = keine Plugins). */
export function pluginNamen(wert: string | undefined): string[] {
  return (wert ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sucht das Workspace-Paket `name` (Muster `ordner/*` aus pnpm-workspace.yaml) und liefert seine Quelle. */
export function workspaceQuelle(wurzel: string, name: string): string {
  const muster = readFileSync(join(wurzel, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n')
    .map((z) => /^\s*-\s*['"]?([^'"#\s]+)\/\*['"]?\s*$/.exec(z)?.[1])
    .filter((m): m is string => Boolean(m));
  for (const ordner of muster) {
    let eintraege: string[];
    try {
      eintraege = readdirSync(join(wurzel, ordner));
    } catch {
      continue;
    }
    for (const paket of eintraege) {
      const datei = join(wurzel, ordner, paket, 'package.json');
      let inhalt: { name?: string; source?: string };
      try {
        inhalt = JSON.parse(readFileSync(datei, 'utf8')) as { name?: string; source?: string };
      } catch {
        continue;
      }
      if (inhalt.name !== name) continue;
      if (!inhalt.source) throw new Error(`Web-Plugin ${name}: package.json ohne Feld "source"`);
      return resolve(dirname(datei), inhalt.source);
    }
  }
  throw new Error(`Web-Plugin ${name} nicht im Workspace gefunden (SEATMETER_WEB_PLUGINS)`);
}

/** Erzeugt den Quelltext des virtuellen Moduls (Default-Export je Plugin, als Liste). */
export function modulQuelle(pfade: readonly string[]): string {
  const importe = pfade.map((p, i) => `import p${i} from ${JSON.stringify(p)};`);
  return `${importe.join('\n')}\nexport default [${pfade.map((_, i) => `p${i}`).join(', ')}];\n`;
}

/** Ergänzt `@source "<ordner>";` je Plugin-Ordner direkt nach dem Tailwind-Import. */
export function mitQuellen(css: string, ordner: readonly string[]): string {
  if (ordner.length === 0) return css;
  const zeilen = ordner.map((o) => `@source ${JSON.stringify(o)};`).join('\n');
  return css.replace(/(@import\s+['"]tailwindcss['"];?)/, `$1\n${zeilen}`);
}

export function seatmeterWebPlugins(wurzel: string, namen: readonly string[]): Plugin {
  const ordner = () => namen.map((n) => dirname(workspaceQuelle(wurzel, n)));
  return {
    name: 'seatmeter-web-plugins',
    enforce: 'pre',
    transform(code, id) {
      if (namen.length === 0 || !id.split('?', 1)[0]!.endsWith('/src/index.css')) return null;
      return { code: mitQuellen(code, ordner()), map: null };
    },
    resolveId(id) {
      return id === VIRTUELLES_MODUL ? AUFGELOEST : null;
    },
    load(id) {
      if (id !== AUFGELOEST) return null;
      return modulQuelle(namen.map((n) => workspaceQuelle(wurzel, n)));
    },
  };
}
