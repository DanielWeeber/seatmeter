// Rollen aus SCIM-Gruppen: Gruppenname (displayName) oder externalId → Rollen über `mandant_oidc.gruppen_rollen`
// (dieselbe Zuordnung wie beim OIDC-Login). Rollen tragen `quelle = 'scim'`; der Abgleich je Konto entzieht nur
// SCIM-Rollen. Bekäme ein Konto seine erste Rolle im Mandanten, greift das Kontenkontingent.
import type { Rolle } from '@seatmeter/shared';
import type { Verwaltung } from '../mandant/verwaltung.js';
import { rollenSetzen, type Trx } from '../konten/konten.js';
import { sollAusGruppen } from '../oidc/mandant.js';
import { ScimAbbruch } from './basis.js';

export async function zuordnungLaden(trx: Trx): Promise<Record<string, string[]>> {
  const k = await trx.selectFrom('mandant_oidc').select('gruppen_rollen').executeTakeFirst();
  return k?.gruppen_rollen ?? {};
}

async function sollFuer(trx: Trx, benutzerId: string, zuordnung: Record<string, string[]>) {
  const konto = await trx
    .selectFrom('scim_konto')
    .select('aktiv')
    .where('benutzer_id', '=', benutzerId)
    .executeTakeFirst();
  const b = await trx
    .selectFrom('benutzer')
    .select('deaktiviert')
    .where('id', '=', benutzerId)
    .executeTakeFirst();
  if (!b || b.deaktiviert || konto?.aktiv === false) return new Map<Rolle, string[] | null>();
  const gruppen = await trx
    .selectFrom('mandant_scim_mitglied as m')
    .innerJoin('mandant_scim_gruppe as g', 'g.id', 'm.gruppe_id')
    .select(['g.display_name', 'g.external_id'])
    .where('m.benutzer_id', '=', benutzerId)
    .execute();
  const namen = gruppen.flatMap((g) => [g.display_name, ...(g.external_id ? [g.external_id] : [])]);
  return sollAusGruppen(zuordnung, namen);
}

/**
 * Gleicht die SCIM-Rollen eines Kontos ab. Mit `kontingentStrikt` bricht ein volles Kontingent mit 409 ab
 * (SCIM-Anfrage), sonst wird das Konto übersprungen (Neuberechnung nach geänderter Zuordnung).
 */
export async function scimRollenAbgleichen(
  v: Pick<Verwaltung, 'kontingentPruefen'>,
  trx: Trx,
  benutzerId: string,
  zuordnung: Record<string, string[]>,
  kontingentStrikt = true,
): Promise<boolean> {
  const soll = await sollFuer(trx, benutzerId, zuordnung);
  if (soll.size > 0) {
    const voll = await v.kontingentPruefen(trx, benutzerId);
    if (voll) {
      if (!kontingentStrikt) return false;
      throw new ScimAbbruch(
        409,
        `konten_kontingent: Das Kontenkontingent des Mandanten ist ausgeschöpft (${voll.belegt} von ${voll.max ?? '∞'} Konten).`,
        'tooMany',
      );
    }
  }
  await rollenSetzen(trx, {
    benutzerId,
    soll,
    quelle: 'scim',
    entziehen: 'quelle',
    akteur: null,
    hinweis: 'SCIM-Gruppe',
  });
  return true;
}

/** Nach geänderter Gruppen-Zuordnung: SCIM-Rollen aller Gruppenmitglieder neu (volles Kontingent = übersprungen). */
export async function scimAlleRollenAbgleichen(
  v: Pick<Verwaltung, 'kontingentPruefen'>,
  trx: Trx,
): Promise<number> {
  const zuordnung = await zuordnungLaden(trx);
  const konten = new Set<string>([
    ...(await trx.selectFrom('mandant_scim_mitglied').select('benutzer_id').execute()).map(
      (z) => z.benutzer_id,
    ),
    ...(
      await trx.selectFrom('rolle').select('benutzer_id').where('quelle', '=', 'scim').execute()
    ).map((z) => z.benutzer_id),
  ]);
  let uebersprungen = 0;
  for (const id of konten)
    if (!(await scimRollenAbgleichen(v, trx, id, zuordnung, false))) uebersprungen++;
  return uebersprungen;
}
