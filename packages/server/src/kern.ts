// Kern-Module des Servers als SeatmeterPlugin (Routen und Jobs); Reihenfolge = Registrierung.
// Die Auth-Grundlage (Cookies, request.benutzer) setzt app.ts vorher an der Wurzel-Instanz.
import { abgleichPlugin } from './abgleich/index.js';
import { aggregationPlugin } from './aggregation/index.js';
import { auditPlugin } from './audit/index.js';
import { aufbewahrungPlugin } from './aufbewahrung/index.js';
import { ausrollenPlugin } from './ausrollen/index.js';
import { authPlugin } from './auth/index.js';
import { berichtePlugin } from './berichte/index.js';
import { budgetsPlugin } from './budgets/index.js';
import { hinweisePlugin } from './hinweise/index.js';
import { ingestPlugin } from './ingest-gemeinsam/registrieren.js';
import { issuesPlugin } from './issues/index.js';
import { jiraPlugin } from './jira/index.js';
import { kalkulationPlugin } from './kalkulation/index.js';
import { kontenPlugin } from './konten/index.js';
import { mandantPlugin } from './mandant/index.js';
import { mergePlugin } from './merge/index.js';
import { oidcPlugin } from './oidc/index.js';
import type { SeatmeterPlugin } from './plugin.js';
import { preisePlugin } from './preise/index.js';
import { projektkatalogPlugin } from './projektkatalog/index.js';
import { scimPlugin } from './scim/index.js';

export const KERN_MODULE: readonly SeatmeterPlugin[] = [
  authPlugin,
  auditPlugin,
  preisePlugin,
  aggregationPlugin,
  issuesPlugin,
  mandantPlugin,
  kalkulationPlugin,
  berichtePlugin,
  aufbewahrungPlugin,
  ingestPlugin,
  mergePlugin,
  ausrollenPlugin(),
  budgetsPlugin,
  hinweisePlugin,
  abgleichPlugin,
  oidcPlugin,
  kontenPlugin,
  scimPlugin,
  jiraPlugin,
  projektkatalogPlugin,
];
