// Navigation laut Architektur §2.4, nach Rollen gruppiert (Entscheidung 2026-10-23):
// Auswertung für alle Rollen, Einrichtung nur für Mandanten-Admins (und Plattform-Admins), Plattform
// nur für Plattform-Admins im eigenen Bereich `/plattform`. Den Plattform-Bereich bringt das ee-Plugin mit
// (Mandantenfähigkeit); alles andere ist seit 2026-10-24 Kern (Entscheidung vom 2026-10-23).
import type { AuthMe, NavEintrag, NavGruppe, Rolle } from '@seatmeter/shared';

export const KERN_NAVIGATION: NavEintrag[] = [
  { pfad: '/', titel: 'Übersicht', gruppe: 'auswertung' },
  { pfad: '/projekte', titel: 'Projekte', gruppe: 'auswertung' },
  { pfad: '/projektpreise', titel: 'Projektpreise', gruppe: 'auswertung' },
  { pfad: '/personen', titel: 'Personen', gruppe: 'auswertung' },
  { pfad: '/rechner', titel: 'Rechner/Agenten', gruppe: 'auswertung' },
  { pfad: '/datenqualitaet', titel: 'Datenqualität', gruppe: 'auswertung' },
  { pfad: '/jira-kosten', titel: 'Jira-Kosten', gruppe: 'auswertung' },
  { pfad: '/projektkosten', titel: 'Projektkosten', gruppe: 'auswertung' },
  { pfad: '/berichte', titel: 'Berichte', gruppe: 'auswertung' },
  { pfad: '/einstellungen', titel: 'Einstellungen', gruppe: 'einrichtung' },
  { pfad: '/preise', titel: 'Preise & Sitzkosten', gruppe: 'einrichtung' },
  { pfad: '/ausrollen', titel: 'Ausrollen', gruppe: 'einrichtung' },
  { pfad: '/budgets', titel: 'Budgets und Alarme', gruppe: 'einrichtung' },
  { pfad: '/hinweise', titel: 'Projekt-Hinweise', gruppe: 'einrichtung' },
  { pfad: '/abgleich', titel: 'Abgleich', gruppe: 'einrichtung' },
  { pfad: '/mandant', titel: 'Tokens und Orgs', gruppe: 'einrichtung' },
  { pfad: '/einrichtung/sso', titel: 'SSO und Konten', gruppe: 'einrichtung' },
  { pfad: '/einrichtung/jira', titel: 'Jira', gruppe: 'einrichtung' },
  { pfad: '/einrichtung/projektkatalog', titel: 'Projektkatalog', gruppe: 'einrichtung' },
];

/**
 * Alte Pfade vor dem Plattform-Bereich (Doku-Links, Lesezeichen) → neue Pfade; `:name` wird aus dem
 * alten Pfad übernommen, die Suchparameter bleiben erhalten.
 */
export const UMLEITUNGEN: Record<string, string> = {
  '/mandanten': '/plattform/mandanten',
  '/mandanten/:id': '/plattform/mandanten/:id',
  '/lizenz': '/plattform/lizenz',
};

export const ROLLEN_TEXT: Record<Rolle, string> = {
  mandanten_admin: 'Mandanten-Admin',
  projektleiter: 'Projektleitung',
  controller: 'Controller/Leser',
  betriebsrat: 'Betriebsrat',
  entwickler: 'Entwicklung',
};

/** Was die Navigation zeigen darf; Quelle ist `/me` (Rollen im aktiven Mandanten, Plattform-Admin). */
export interface NavRechte {
  /** Rolle `mandanten_admin` im aktiven Mandanten oder Auth-Modul im Server inaktiv. */
  mandantenAdmin: boolean;
  /** ee: Plattform-Admin (Feld `plattform_admin` in `/me`). */
  plattformAdmin: boolean;
}

/**
 * Rechte aus `/me`. Ohne Auth-Modul im Server (`me` = `null`) bleibt die Einrichtung sichtbar wie
 * bisher (Authelia schützt davor, der Server entscheidet selbst); den Plattform-Bereich gibt es dann nicht.
 */
export function navRechte(me: AuthMe | null): NavRechte {
  if (!me) return { mandantenAdmin: true, plattformAdmin: false };
  return {
    mandantenAdmin: me.rollen.includes('mandanten_admin'),
    plattformAdmin: me.plattform_admin === true,
  };
}

/** Sichtbare Gruppen je Rolle; Plattform-Admins sehen die Einrichtung jedes Mandanten mit. */
export function gruppeSichtbar(gruppe: NavGruppe, rechte: NavRechte): boolean {
  if (gruppe === 'auswertung') return true;
  if (gruppe === 'einrichtung') return rechte.mandantenAdmin || rechte.plattformAdmin;
  return rechte.plattformAdmin;
}

export function sichtbareEintraege(eintraege: NavEintrag[], rechte: NavRechte): NavEintrag[] {
  return eintraege.filter((e) => gruppeSichtbar(e.gruppe, rechte));
}

/** Anzeige der Rolle im aktiven Mandanten für die Kopfzeile, z. B. „Mandanten-Admin“. */
export function rollenText(rollen: readonly Rolle[]): string {
  return rollen.map((r) => ROLLEN_TEXT[r] ?? r).join(', ');
}

/** Navigation des Kerns; Plugin-Einträge (ee: Plattform-Bereich) ergänzt `mitPluginNavigation`. */
export function navigation(): NavEintrag[] {
  return KERN_NAVIGATION;
}
