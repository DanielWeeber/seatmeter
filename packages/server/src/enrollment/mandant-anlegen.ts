// Mandant einrichten (Architektur §10.1, Pilot §10.4): Mandant, verschlüsselte Salts, Org-Positivliste
// und ein Mandanten-Ingest-Token (`smi_…`, nur einmal im Klartext). Idempotent über den Slug; ein schon
// vorhandener Mandant (z. B. aus der Einrichtung im Dashboard) bekommt Orgs und Token dazu, und ein
// ausdrücklich angegebener Plan wird übernommen.
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { mandantSaltsLaden } from '../ingest-gemeinsam/geheimnis.js';
import { tokenErzeugen } from '../ingest-gemeinsam/zugang.js';

export const mandantAnlegenSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Slug: klein, Ziffern, Bindestrich'),
  name: z.string().min(1).max(200),
  plan: z.enum(['team', 'enterprise', 'max_pilot']).default('team'),
  orgs: z.array(z.uuid()).default([]),
  /** Neues Mandanten-Token auch dann, wenn schon eines aktiv ist. */
  neuesToken: z.boolean().default(false),
});
export type MandantAnlegenEingabe = z.input<typeof mandantAnlegenSchema>;

export interface MandantAnlegenErgebnis {
  mandantId: string;
  mandantNeu: boolean;
  orgsNeu: number;
  /** Klartext nur, wenn ein Token erzeugt wurde. */
  token: string | null;
  tokenPraefix: string;
}

export async function mandantAnlegen(
  db: Db,
  masterKey: Buffer,
  eingabe: MandantAnlegenEingabe,
): Promise<MandantAnlegenErgebnis> {
  const e = mandantAnlegenSchema.parse(eingabe);
  // `mandant` als Eigentümer anlegen (die ID gibt es vorher nicht); alles Weitere unter RLS.
  const neu = await db
    .insertInto('mandant')
    .values({ name: e.name, slug: e.slug, plan: e.plan })
    .onConflict((oc) => oc.column('slug').doNothing())
    .returning('id')
    .executeTakeFirst();
  const mandantId =
    neu?.id ??
    (
      await db
        .selectFrom('mandant')
        .select('id')
        .where('slug', '=', e.slug)
        .executeTakeFirstOrThrow()
    ).id;
  if (!neu && eingabe.plan !== undefined) {
    await db.updateTable('mandant').set({ plan: e.plan }).where('id', '=', mandantId).execute();
  }

  return withMandant(db, mandantId, async (trx) => {
    await mandantSaltsLaden(trx, masterKey, mandantId);
    let orgsNeu = 0;
    for (const org of e.orgs) {
      const r = await trx
        .insertInto('anthropic_org')
        .values({ mandant_id: mandantId, org_uuid: org.toLowerCase(), plan: e.plan })
        .onConflict((oc) => oc.columns(['mandant_id', 'org_uuid']).doNothing())
        .executeTakeFirst();
      orgsNeu += Number(r.numInsertedOrUpdatedRows ?? 0);
    }
    const aktiv = await trx
      .selectFrom('ingest_token')
      .select('praefix')
      .where('typ', '=', 'mandant')
      .where('widerrufen', 'is', null)
      .orderBy('erstellt', 'desc')
      .executeTakeFirst();
    if (aktiv && !e.neuesToken) {
      return {
        mandantId,
        mandantNeu: Boolean(neu),
        orgsNeu,
        token: null,
        tokenPraefix: aktiv.praefix,
      };
    }
    const token = tokenErzeugen('mandant');
    await trx
      .insertInto('ingest_token')
      .values({
        mandant_id: mandantId,
        typ: 'mandant',
        rechner_id: null,
        token_sha256: token.sha256,
        praefix: token.praefix,
      })
      .execute();
    return {
      mandantId,
      mandantNeu: Boolean(neu),
      orgsNeu,
      token: token.klartext,
      tokenPraefix: token.praefix,
    };
  });
}
