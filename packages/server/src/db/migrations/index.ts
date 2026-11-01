// Alle Migrationen in fester Reihenfolge (Name = Sortierschlüssel). Neue Datei hier eintragen.
import type { Migration } from 'kysely/migration';
import * as m0001 from './2026_10_22_0001_grundschema.js';
import * as m0010 from './2026_10_22_0010_auth_jobs.js';
import * as m0011 from './2026_10_22_0011_einmalcode_bezeichnung.js';
import * as m0012 from './2026_10_22_0012_kalkulation.js';
import * as m0013 from './2026_10_22_0013_auth_oidc.js';
import * as m0014 from './2026_10_22_0014_budgets_abgleich.js';
import * as m0015 from './2026_10_22_0015_pfad_projekt.js';
import * as m0016 from './2026_10_22_0016_speed_normal.js';
import * as m0017 from './2026_10_22_0017_sitztypen_max.js';
import * as m0018 from './2026_10_22_0018_ratenlimit.js';
import * as m0019 from './2026_10_23_0019_sso_je_mandant.js';
import * as m0020 from './2026_10_23_0020_issue_schluessel.js';
import * as m0021 from './2026_10_23_0021_rolle_quelle_scim.js';
import * as m0022 from './2026_10_24_0022_budgets_hinweise.js';
import * as m0023 from './2026_10_24_0023_sso_je_mandant.js';
import * as m0024 from './2026_10_24_0024_scim.js';
import * as m0025 from './2026_10_24_0025_jira.js';
import * as m0026 from './2026_11_01_0026_projektkatalog.js';
import * as m0027 from './2026_11_01_0027_katalog_import_token.js';
import * as m0028 from './2026_11_01_0028_projektwahl_stufe.js';
import * as m0029 from './2026_11_01_0029_katalog_push.js';

export const MIGRATIONEN: Record<string, Migration> = {
  '2026_10_22_0001_grundschema': m0001,
  '2026_10_22_0010_auth_jobs': m0010,
  '2026_10_22_0011_einmalcode_bezeichnung': m0011,
  '2026_10_22_0012_kalkulation': m0012,
  '2026_10_22_0013_auth_oidc': m0013,
  '2026_10_22_0014_budgets_abgleich': m0014,
  '2026_10_22_0015_pfad_projekt': m0015,
  '2026_10_22_0016_speed_normal': m0016,
  '2026_10_22_0017_sitztypen_max': m0017,
  '2026_10_22_0018_ratenlimit': m0018,
  '2026_10_23_0019_sso_je_mandant': m0019,
  '2026_10_23_0020_issue_schluessel': m0020,
  '2026_10_23_0021_rolle_quelle_scim': m0021,
  '2026_10_24_0022_budgets_hinweise': m0022,
  '2026_10_24_0023_sso_je_mandant': m0023,
  '2026_10_24_0024_scim': m0024,
  '2026_10_24_0025_jira': m0025,
  '2026_11_01_0026_projektkatalog': m0026,
  '2026_11_01_0027_katalog_import_token': m0027,
  '2026_11_01_0028_projektwahl_stufe': m0028,
  '2026_11_01_0029_katalog_push': m0029,
};
