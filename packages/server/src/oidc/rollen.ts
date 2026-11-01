// Gruppen → Rollen beim OIDC-Login (SEATMETER_OIDC_GRUPPEN). Zuordnungen aus OIDC tragen `quelle = 'oidc'`
// und werden beim nächsten Login ohne passende Gruppe wieder entzogen; manuell vergebene Rollen bleiben.
import { protokolliere } from '../audit/protokoll.js';
import { rollenDesBenutzers } from '../auth/kontext.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { nurEntwickler, type Rolle } from '@seatmeter/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { GruppenZuordnung } from '../config.js';
import type { Verwaltung } from '../mandant/verwaltung.js';
import { VERWALTUNG_AUDIT } from '../mandant/verwaltung.js';

interface Soll {
  rollen: Map<string, Map<Rolle, string[] | null>>;
  plattformAdmin: boolean;
}

/** Ermittelt die Soll-Rollen aus den Gruppen; unbekannte Mandanten-Slugs werden übersprungen. */
export async function sollRollen(
  db: Db,
  zuordnung: GruppenZuordnung,
  gruppen: readonly string[],
  log?: FastifyBaseLogger,
): Promise<Soll> {
  const soll: Soll = { rollen: new Map(), plattformAdmin: false };
  const slugs = new Map<string, string | null>();
  for (const gruppe of gruppen) {
    for (const ziel of zuordnung[gruppe] ?? []) {
      if ('plattform_admin' in ziel) {
        soll.plattformAdmin = true;
        continue;
      }
      if (!slugs.has(ziel.mandant)) {
        const m = await db
          .selectFrom('mandant')
          .select('id')
          .where('slug', '=', ziel.mandant)
          .executeTakeFirst();
        slugs.set(ziel.mandant, m?.id ?? null);
        if (!m)
          log?.warn(
            { mandant: ziel.mandant },
            'OIDC-Gruppen: Mandant aus SEATMETER_OIDC_GRUPPEN fehlt',
          );
      }
      const mandantId = slugs.get(ziel.mandant);
      if (!mandantId) continue;
      const rollen = soll.rollen.get(mandantId) ?? new Map<Rolle, string[] | null>();
      rollen.set(ziel.rolle, ziel.rolle === 'projektleiter' ? (ziel.projekt_ids ?? []) : null);
      soll.rollen.set(mandantId, rollen);
    }
  }
  return soll;
}

/**
 * Gleicht Rollen und Plattform-Admin des Benutzers mit den Soll-Rollen ab (mit Audit je Mandant).
 * `ausgenommen`: Mandanten mit eigenem Anmeldedienst (SSO je Mandant); dort entzieht der globale Anbieter
 * nichts, solange seine Zuordnung den Mandanten nicht selbst nennt.
 */
export async function rollenAbgleichen(
  db: Db,
  benutzerId: string,
  soll: Soll,
  ausgenommen: ReadonlySet<string>,
  v: Pick<Verwaltung, 'plattformAdminAbgleichen'>,
): Promise<void> {
  const mandanten = new Set<string>([
    ...soll.rollen.keys(),
    ...(await rollenDesBenutzers(db, benutzerId))
      .map((r) => r.mandant_id)
      .filter((id) => !ausgenommen.has(id)),
  ]);
  for (const mandantId of mandanten) {
    const wunsch = soll.rollen.get(mandantId) ?? new Map<Rolle, string[] | null>();
    await withMandant(db, mandantId, async (trx) => {
      const ist = await trx
        .selectFrom('rolle')
        .select(['id', 'rolle', 'quelle'])
        .where('benutzer_id', '=', benutzerId)
        .execute();
      // Bleibt nur `entwickler`: ohne Konto im Audit, der Abgleich passiert bei der Anmeldung direkt vor der Wahl.
      const ohneKonto = nurEntwickler([
        ...wunsch.keys(),
        ...ist.filter((r) => r.quelle !== 'oidc').map((r) => r.rolle),
      ]);
      const akteur = ohneKonto ? null : benutzerId;
      const ziel = ohneKonto ? '' : `benutzer:${benutzerId} `;
      for (const [rolle, projektIds] of wunsch) {
        if (ist.some((r) => r.rolle === rolle)) continue;
        await trx
          .insertInto('rolle')
          .values({
            mandant_id: mandantId,
            benutzer_id: benutzerId,
            rolle,
            projekt_ids: projektIds,
            quelle: 'oidc',
          })
          .onConflict((oc) => oc.columns(['mandant_id', 'benutzer_id', 'rolle']).doNothing())
          .execute();
        await protokolliere(trx, {
          benutzerId: akteur,
          aktion: VERWALTUNG_AUDIT.rolleZugewiesen,
          objekt: `${ziel}rolle:${rolle} (OIDC-Gruppe)`,
        });
      }
      for (const r of ist) {
        if (r.quelle !== 'oidc' || wunsch.has(r.rolle)) continue;
        await trx.deleteFrom('rolle').where('id', '=', r.id).execute();
        await protokolliere(trx, {
          benutzerId: akteur,
          aktion: VERWALTUNG_AUDIT.rolleEntzogen,
          objekt: `${ziel}rolle:${r.rolle} (OIDC-Gruppe fehlt)`,
        });
      }
    });
  }
  // Plattform-Admin aus Gruppen setzt bzw. entzieht nur die Mandantenfähigkeit (ee); sonst wirkungslos.
  await v.plattformAdminAbgleichen(benutzerId, soll.plattformAdmin);
}
