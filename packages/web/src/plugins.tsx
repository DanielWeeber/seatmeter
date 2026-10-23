// Web-Plugins (ee): Seiten und Übersichtskacheln, die beim Bauen über das virtuelle Modul
// `virtual:seatmeter-web-plugins` hereinkommen (vite.config.ts, Umgebung SEATMETER_WEB_PLUGINS).
// Der Kern importiert nie aus `ee/` (Lizenzgrenze, Architektur §8); ohne Variable ist die Liste leer.
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { NavEintrag, SeatmeterWebPlugin } from '@seatmeter/shared';

/** Kachel auf der Übersicht; bekommt den gewählten Monat (`JJJJ-MM`). */
export type UebersichtKachel = ComponentType<{ monat: string }>;

/** Web-Plugin mit React-Komponenten als Seiten und Kacheln. */
export type WebPlugin = SeatmeterWebPlugin<ComponentType, UebersichtKachel>;

/**
 * Navigation: Kern (und ggf. ee-Platzhalter) plus Plugin-Einträge; gleicher Pfad = Plugin-Eintrag
 * (Titel und Gruppe). Wer welche Gruppe sieht, entscheidet das Layout nach `/me` (navigation.ts).
 */
export function mitPluginNavigation(
  basis: NavEintrag[],
  plugins: readonly WebPlugin[],
): NavEintrag[] {
  const eintraege = [...basis];
  for (const plugin of plugins) {
    for (const e of plugin.navigation) {
      const i = eintraege.findIndex((x) => x.pfad === e.pfad);
      if (i >= 0) eintraege[i] = e;
      else eintraege.push(e);
    }
  }
  return eintraege;
}

/** Alle Plugin-Seiten je Pfad (spätere Plugins überschreiben frühere). */
export function pluginSeiten(plugins: readonly WebPlugin[]): Record<string, ComponentType> {
  return Object.assign({}, ...plugins.map((p) => p.seiten ?? {})) as Record<string, ComponentType>;
}

const PluginKontext = createContext<readonly WebPlugin[]>([]);

export function PluginProvider({
  plugins,
  children,
}: {
  plugins: readonly WebPlugin[];
  children: ReactNode;
}) {
  return <PluginKontext.Provider value={plugins}>{children}</PluginKontext.Provider>;
}

export function useUebersichtKacheln(): UebersichtKachel[] {
  return useContext(PluginKontext).flatMap((p) => p.uebersichtKacheln ?? []);
}
