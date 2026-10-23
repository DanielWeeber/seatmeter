// Datenzugriff des Jira-Moduls (immer in `withMandant`, RLS): Verbindung mit verschlüsseltem Token,
// Positivliste `mandant.issue_praefixe` aus der Zuordnung, Titel-Zwischenspeicher.
import type { Datenbank } from '../db/schema.js';
import { entschluessele, verschluessele } from '../krypto.js';
import type { JiraVerbindung } from '@seatmeter/shared';
import type { Transaction } from 'kysely';
import type { JiraZugang } from './client.js';

export type JiraTrx = Transaction<Datenbank>;

export const AAD_JIRA_TOKEN = 'mandant_jira.token';

/** Zwischenspeicher der Titel: 24 h gültig, Einträge älter als 30 Tage werden gelöscht. */
export const CACHE_MS = 24 * 3600 * 1000;
export const CACHE_LOESCHEN_MS = 30 * 24 * 3600 * 1000;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export async function verbindungLaden(trx: JiraTrx): Promise<JiraVerbindung> {
  const v = await trx.selectFrom('mandant_jira').selectAll().executeTakeFirst();
  if (!v) {
    return {
      eingerichtet: false,
      basis_url: null,
      art: null,
      benutzer_email: null,
      token_gesetzt: false,
      aktiv: false,
      nur_zugeordnete: false,
      zuletzt_geprueft: null,
      fehler: null,
    };
  }
  return {
    eingerichtet: true,
    basis_url: v.basis_url,
    art: v.art,
    benutzer_email: v.benutzer_email,
    token_gesetzt: v.token.length > 0,
    aktiv: v.aktiv,
    nur_zugeordnete: v.nur_zugeordnete,
    zuletzt_geprueft: iso(v.zuletzt_geprueft),
    fehler: v.fehler,
  };
}

/** Entschlüsselter Zugang (nur für den Aufruf an Jira); `null` ohne aktive Verbindung. */
export async function zugangLaden(
  trx: JiraTrx,
  masterKey: Buffer,
  auchInaktiv = false,
): Promise<JiraZugang | null> {
  const v = await trx.selectFrom('mandant_jira').selectAll().executeTakeFirst();
  if (!v || (!v.aktiv && !auchInaktiv)) return null;
  return {
    basisUrl: v.basis_url,
    art: v.art,
    email: v.benutzer_email,
    token: entschluessele(masterKey, v.token, AAD_JIRA_TOKEN).toString('utf8'),
  };
}

export interface VerbindungSpeichern {
  basisUrl: string;
  art: 'cloud' | 'datacenter';
  email: string | null;
  /** `undefined` = gespeichertes Token behalten. */
  token: string | undefined;
  aktiv: boolean;
  nurZugeordnete: boolean;
}

/** Legt die Verbindung an oder ändert sie; ohne Token und ohne vorhandene Zeile → `false`. */
export async function verbindungSpeichern(
  trx: JiraTrx,
  masterKey: Buffer,
  mandantId: string,
  e: VerbindungSpeichern,
): Promise<boolean> {
  const vorhanden = await trx.selectFrom('mandant_jira').select('token').executeTakeFirst();
  const token =
    e.token !== undefined
      ? verschluessele(masterKey, e.token, AAD_JIRA_TOKEN)
      : (vorhanden?.token ?? null);
  if (!token) return false;
  const werte = {
    basis_url: e.basisUrl,
    art: e.art,
    benutzer_email: e.art === 'cloud' ? e.email : null,
    token,
    aktiv: e.aktiv,
    nur_zugeordnete: e.nurZugeordnete,
    geaendert: new Date(),
    // Neue Zugangsdaten: alte Prüfung gilt nicht mehr.
    ...(e.token !== undefined ? { zuletzt_geprueft: null, fehler: null } : {}),
  };
  await trx
    .insertInto('mandant_jira')
    .values({ mandant_id: mandantId, ...werte })
    .onConflict((oc) => oc.column('mandant_id').doUpdateSet(werte))
    .execute();
  return true;
}

/**
 * Positivliste der Projektschlüssel (`mandant.issue_praefixe`): mit „nur zugeordnete“ und mindestens
 * einer Zuordnung die zugeordneten Jira-Projektschlüssel, sonst `NULL` (alle erkannten Schlüssel).
 */
export async function positivlisteAbgleichen(trx: JiraTrx): Promise<string[] | null> {
  const v = await trx.selectFrom('mandant_jira').select('nur_zugeordnete').executeTakeFirst();
  const schluessel = (
    await trx
      .selectFrom('projekt_jira')
      .select('jira_projekt_schluessel')
      .distinct()
      .orderBy('jira_projekt_schluessel')
      .execute()
  ).map((z) => z.jira_projekt_schluessel);
  const liste = v?.nur_zugeordnete && schluessel.length > 0 ? schluessel : null;
  await trx.updateTable('mandant').set({ issue_praefixe: liste }).execute();
  return liste;
}

export interface TitelEintrag {
  titel: string | null;
  status: string | null;
  gefunden: boolean;
  geholt: Date;
}

export async function titelLaden(
  trx: JiraTrx,
  schluessel: readonly string[],
): Promise<Map<string, TitelEintrag>> {
  if (schluessel.length === 0) return new Map();
  const r = await trx
    .selectFrom('jira_issue_cache')
    .select(['schluessel', 'titel', 'status', 'gefunden', 'geholt'])
    .where('schluessel', 'in', [...schluessel])
    .execute();
  return new Map(
    r.map((z) => [
      z.schluessel,
      { titel: z.titel, status: z.status, gefunden: z.gefunden, geholt: new Date(z.geholt) },
    ]),
  );
}

export async function titelSpeichern(
  trx: JiraTrx,
  mandantId: string,
  eintraege: {
    schluessel: string;
    titel: string | null;
    status: string | null;
    gefunden: boolean;
  }[],
  jetzt = new Date(),
): Promise<void> {
  for (const e of eintraege) {
    const werte = { titel: e.titel, status: e.status, gefunden: e.gefunden, geholt: jetzt };
    await trx
      .insertInto('jira_issue_cache')
      .values({ mandant_id: mandantId, schluessel: e.schluessel, ...werte })
      .onConflict((oc) => oc.columns(['mandant_id', 'schluessel']).doUpdateSet(werte))
      .execute();
  }
  await trx
    .deleteFrom('jira_issue_cache')
    .where('geholt', '<', new Date(jetzt.getTime() - CACHE_LOESCHEN_MS))
    .execute();
}
