// Stufen der Projektwahl (aus, warnen, blockieren) und was dagegen spricht, sie einzuschalten:
// - `auto_rolle`: Im Header-Modus legt der Link neue Konten mit `SEATMETER_AUTO_ROLLE` an. Standard ist
//   `mandanten_admin`, sonst würde jede Person, die dem Link folgt, Admin. Die Standardvorgabe bleibt, darum hier die
//   Sperre, bis die Rolle `entwickler` gesetzt ist.
// - `link_basis`: Mit `SEATMETER_INGEST_URL` ohne `SEATMETER_PUBLIC_URL` zeigte der Link auf den Ingest-Host (404).
// In beiden Fällen weigert sich der Schalter, und die Prüf-Route antwortet `frei`, falls die Stufe schon aktiv ist.
import type { KatalogHinderung, KatalogStufe } from '@seatmeter/shared';
import type { Konfiguration } from '../config.js';
import type { KatalogTrx } from './daten.js';

export function projektwahlHinderung(
  k: Pick<
    Konfiguration,
    'SEATMETER_TRUST_REMOTE_USER_HEADER' | 'SEATMETER_AUTO_ROLLE' | 'SEATMETER_PUBLIC_URL'
  >,
  env: NodeJS.ProcessEnv = process.env,
): KatalogHinderung | null {
  if (k.SEATMETER_TRUST_REMOTE_USER_HEADER && k.SEATMETER_AUTO_ROLLE !== 'entwickler') {
    return 'auto_rolle';
  }
  if (env.SEATMETER_INGEST_URL && !k.SEATMETER_PUBLIC_URL) return 'link_basis';
  return null;
}

/**
 * Kann überhaupt jemand ohne Dashboard-Rolle die Auswahlseite erreichen? Konten mit der Rolle `entwickler`, eine
 * Gruppenzuordnung (SSO des Mandanten oder `SEATMETER_OIDC_GRUPPEN`) oder der Header-Modus mit dieser Rolle.
 */
export async function auswahlErreichbar(trx: KatalogTrx, k: Konfiguration): Promise<boolean> {
  if (k.SEATMETER_TRUST_REMOTE_USER_HEADER && k.SEATMETER_AUTO_ROLLE === 'entwickler') return true;
  const konto = await trx
    .selectFrom('rolle')
    .select('benutzer_id')
    .where('rolle', '=', 'entwickler')
    .limit(1)
    .executeTakeFirst();
  if (konto) return true;
  const sso = await trx.selectFrom('mandant_oidc').select('gruppen_rollen').executeTakeFirst();
  if (
    sso &&
    Object.values(sso.gruppen_rollen ?? {})
      .flat()
      .includes('entwickler')
  )
    return true;
  if (!k.SEATMETER_OIDC_GRUPPEN) return false;
  const m = await trx.selectFrom('mandant').select('slug').executeTakeFirstOrThrow();
  return Object.values(k.SEATMETER_OIDC_GRUPPEN)
    .flat()
    .some((z) => 'mandant' in z && z.mandant === m.slug && z.rolle === 'entwickler');
}

export interface KatalogEinstellungWerte {
  stufe?: KatalogStufe;
  kontakt?: string | null;
  inaktiv_status?: string[] | null;
  sync_warnung_stunden?: number | null;
  sync_deaktivieren_tage?: number | null;
  sync_deaktivieren_max_prozent?: number;
}

/** Schreibt nur, was gesetzt ist; was fehlt, bleibt. */
export async function einstellungSetzen(
  trx: KatalogTrx,
  mandantId: string,
  e: KatalogEinstellungWerte,
): Promise<void> {
  const werte = Object.fromEntries(
    Object.entries({
      ...e,
      inaktiv_status: e.inaktiv_status?.map((s) => s.toLowerCase()) ?? e.inaktiv_status,
    }).filter(([, w]) => w !== undefined),
  ) as KatalogEinstellungWerte;
  if (Object.keys(werte).length === 0) return;
  await trx
    .insertInto('mandant_projektkatalog')
    .values({ mandant_id: mandantId, ...werte })
    .onConflict((oc) => oc.column('mandant_id').doUpdateSet({ ...werte, geaendert: new Date() }))
    .execute();
}

export function stufeSetzen(
  trx: KatalogTrx,
  mandantId: string,
  stufe: KatalogStufe,
): Promise<void> {
  return einstellungSetzen(trx, mandantId, { stufe });
}
