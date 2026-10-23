// Navigationseinträge des Dashboards; Kern und ee-Plugins liefern sie gleich aus (Architektur §2.4).

/**
 * Gruppe eines Navigationseintrags (Navigation nach Rollen, Entscheidung 2026-10-23):
 * - `auswertung`: alle Rollen (Seitenleiste, Gruppe „Auswertung“),
 * - `einrichtung`: nur Mandanten-Admin des aktiven Mandanten und Plattform-Admin („Einrichtung“),
 * - `plattform`: nur Plattform-Admin, eigener Bereich unter `/plattform/…` mit eigener Unternavigation.
 */
export type NavGruppe = 'auswertung' | 'einrichtung' | 'plattform';

/** Reihenfolge und deutsche Überschriften der Gruppen. */
export const NAV_GRUPPEN: readonly { gruppe: NavGruppe; titel: string }[] = [
  { gruppe: 'auswertung', titel: 'Auswertung' },
  { gruppe: 'einrichtung', titel: 'Einrichtung' },
  { gruppe: 'plattform', titel: 'Plattform' },
];

/** Präfix des Plattform-Bereichs; Einträge und Seiten der Gruppe `plattform` liegen darunter. */
export const PLATTFORM_PFAD = '/plattform';

/** Liegt der Pfad im Plattform-Bereich (`/plattform` oder `/plattform/…`)? */
export function istPlattformPfad(pfad: string): boolean {
  return pfad === PLATTFORM_PFAD || pfad.startsWith(`${PLATTFORM_PFAD}/`);
}

export interface NavEintrag {
  /** Pfad im Dashboard, z. B. `/projekte`; Gruppe `plattform` immer unter `/plattform/`. */
  pfad: string;
  /** Deutscher Anzeigetext. */
  titel: string;
  /** Gruppe und damit Sichtbarkeit nach Rolle. */
  gruppe: NavGruppe;
  /** Nur mit ee-Lizenz bzw. Feature-Flag sichtbar. */
  ee?: boolean;
}

/**
 * Web-Erweiterung aus `ee/web`: Navigationseinträge, Seiten je Pfad und Kacheln für die Übersicht.
 * Die Typparameter sind im Dashboard React-Komponenten (`packages/web/src/plugins.tsx`); `shared` bleibt
 * ohne React. Geladen wird das Plugin beim Bauen über `SEATMETER_WEB_PLUGINS` (Vite, virtuelles Modul).
 */
export interface SeatmeterWebPlugin<Seite = unknown, Kachel = unknown> {
  name: string;
  /** Einträge mit Gruppe; Einträge der Gruppe `plattform` erscheinen im Plattform-Bereich. */
  navigation: NavEintrag[];
  /**
   * Seiten je Pfad (auch Pfade ohne Navigationseintrag, z. B. `/budgets/:id`). Pfade unter
   * `/plattform/` bekommen das Layout des Plattform-Bereichs, alle anderen die Seitenleiste.
   */
  seiten?: Record<string, Seite>;
  /** Zusätzliche Kacheln auf der Übersicht (bekommen den gewählten Monat). */
  uebersichtKacheln?: Kachel[];
}
