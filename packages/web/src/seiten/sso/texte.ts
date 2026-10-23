// Deutsche Texte und kleine Helfer von „SSO und Konten“.
import { ApiFehler } from '../../api/client';
import { fehlerBeimSpeichern } from '../../komponenten/Formular';
import { ROLLEN_OPTIONEN } from '../mandant/api';
import type { Kontingent } from './api';

export const TEXT_NUR_ADMIN = 'Nur für Mandanten-Admins.';
export const TEXT_KEIN_MANDANT = 'Kein aktiver Mandant.';

export function kontingentText(k: Kontingent): string {
  return `Konten: ${k.belegt} von ${k.max === null ? 'unbegrenzt' : k.max}`;
}

/** Deutscher Text zu einem fehlgeschlagenen Speichern auf dieser Seite (spezielle Codes zuerst). */
export function ssoFehler(fehler: unknown, kontingent?: Kontingent | null): string {
  if (fehler instanceof ApiFehler) {
    switch (fehler.code) {
      case 'domain_vergeben':
        return 'Diese Domain gehört schon zu einem anderen Mandanten.';
      case 'domain_oeffentlich':
        return 'Öffentliche E-Mail-Anbieter (z. B. gmail.com) können nicht verifiziert werden.';
      case 'domain_ungueltig':
        return 'Das ist keine gültige Domain.';
      case 'konten_kontingent':
        return kontingent
          ? `Das Kontenkontingent ist ausgeschöpft (${kontingent.belegt} von ${kontingent.max ?? 'unbegrenzt'}). Bitte den Plattform-Betreiber kontaktieren.`
          : 'Das Kontenkontingent ist ausgeschöpft. Bitte den Plattform-Betreiber kontaktieren.';
      case 'letzter_admin':
        return 'Der letzte Mandanten-Admin kann nicht entfernt oder deaktiviert werden.';
      case 'konto_mehrere_mandanten':
        return 'Das Konto hat Rollen in weiteren Mandanten; bitte stattdessen die Rollen entziehen.';
      case 'client_secret_fehlt':
        return 'Beim ersten Speichern ist ein Client-Secret nötig.';
      default:
    }
  }
  return fehlerBeimSpeichern(fehler);
}

/** Basis-URL für SCIM: Angabe des Servers, sonst aus der Adresse dieser Seite abgeleitet. */
export function scimBasisUrl(basisUrl: string | null): string {
  return basisUrl ?? `${window.location.origin}/scim/v2`;
}

export const ROLLEN_NAMEN = Object.fromEntries(ROLLEN_OPTIONEN) as Record<string, string>;

/** Einladungslink absolut machen (der Server liefert `/einladung/<token>`). */
export function absoluterLink(url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** Text in die Zwischenablage; ohne Berechtigung oder API bleibt es stumm (der Text steht sichtbar da). */
export async function kopieren(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Zeilenliste „Gruppe → Rolle, Rolle“ ⇄ Zuordnung des Servers. */
export function gruppenAlsText(zuordnung: Record<string, string | string[]>): string {
  return Object.entries(zuordnung)
    .map(([gruppe, r]) => `${gruppe} → ${(Array.isArray(r) ? r : [r]).join(', ')}`)
    .join('\n');
}

export function gruppenAusText(
  text: string,
): { ok: true; wert: Record<string, string[]> } | { ok: false; fehler: string } {
  const erlaubt = new Set(ROLLEN_OPTIONEN.map(([r]) => r as string));
  const wert: Record<string, string[]> = {};
  for (const [i, roh] of text.split('\n').entries()) {
    const zeile = roh.trim();
    if (!zeile) continue;
    const teile = zeile.split(/\s*(?:→|->|=>|=)\s*/);
    const gruppe = teile[0]?.trim() ?? '';
    const rollen = (teile[1] ?? '')
      .split(/[\s,;]+/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (teile.length !== 2 || !gruppe || rollen.length === 0)
      return { ok: false, fehler: `Zeile ${i + 1}: Format „Gruppe → Rolle, Rolle“ erwartet.` };
    const unbekannt = rollen.find((r) => !erlaubt.has(r));
    if (unbekannt)
      return {
        ok: false,
        fehler: `Zeile ${i + 1}: Unbekannte Rolle „${unbekannt}“ (erlaubt: ${[...erlaubt].join(', ')}).`,
      };
    wert[gruppe] = [...new Set([...(wert[gruppe] ?? []), ...rollen])];
  }
  return { ok: true, wert };
}
