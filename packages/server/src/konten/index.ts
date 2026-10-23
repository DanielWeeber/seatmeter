// Modul konten (Kern seit 2026-10-24, vorher ee): E-Mail-Domains je Mandant, Kontenverwaltung durch den
// Mandanten-Admin (Einladen, Rollen, Deaktivieren) und Einladung annehmen. Das Kontenkontingent prüft die
// Verwaltung (`mandant/verwaltung.ts`) über die Auth-Erweiterungen (ee). Die Anmeldung je Mandant steht im
// Modul `oidc`. README im Ordner.
import type { SeatmeterPlugin } from '../plugin.js';
import { registriereDomainRouten } from './domains.js';
import { registriereEinladungRouten } from './einladung.js';
import { registriereKontenRouten } from './konten.js';

export {
  kontenListe,
  rollenSetzen,
  kontoSperren,
  kontoEntsperren,
  istLetzterAdmin,
} from './konten.js';
export { domainAusEmail, mandantZurDomain, normalisiereDomain } from './domains.js';

export const kontenPlugin: SeatmeterPlugin = {
  name: 'kern-konten',
  routen(app, { db }) {
    registriereDomainRouten(app, db);
    registriereKontenRouten(app, db);
    registriereEinladungRouten(app, db);
  },
};
