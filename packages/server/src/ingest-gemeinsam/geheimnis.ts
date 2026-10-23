// Mandanten-Salts (Architektur §3.1 `mandant_geheimnis`), verschlüsselt mit `krypto.ts`
// (AES-256-GCM unter SEATMETER_MASTER_KEY, AAD `mandant_geheimnis.<spalte>`, wie die Einrichtung im Modul auth).
import { randomBytes } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Datenbank } from '../db/schema.js';
import { entschluessele, verschluessele } from '../krypto.js';

export const SALT_LAENGE = 32;

const AAD_PERSON = 'mandant_geheimnis.person_salt';
const AAD_PROJEKT = 'mandant_geheimnis.projekt_salt';

export interface MandantSalts {
  personSalt: Buffer;
  projektSalt: Buffer;
}

/**
 * Liest die Salts des Mandanten (innerhalb von `withMandant`) und entschlüsselt sie. Fehlt der
 * Datensatz, wird er mit frischen Zufalls-Salts angelegt (idempotent, `ON CONFLICT DO NOTHING`).
 */
export async function mandantSaltsLaden(
  trx: Transaction<Datenbank>,
  masterKey: Buffer,
  mandantId: string,
): Promise<MandantSalts> {
  let zeile = await trx
    .selectFrom('mandant_geheimnis')
    .select(['person_salt', 'projekt_salt'])
    .where('mandant_id', '=', mandantId)
    .executeTakeFirst();
  if (!zeile) {
    await trx
      .insertInto('mandant_geheimnis')
      .values({
        mandant_id: mandantId,
        person_salt: verschluessele(masterKey, randomBytes(SALT_LAENGE), AAD_PERSON),
        projekt_salt: verschluessele(masterKey, randomBytes(SALT_LAENGE), AAD_PROJEKT),
        analytics_key: null,
      })
      .onConflict((oc) => oc.column('mandant_id').doNothing())
      .execute();
    zeile = await trx
      .selectFrom('mandant_geheimnis')
      .select(['person_salt', 'projekt_salt'])
      .where('mandant_id', '=', mandantId)
      .executeTakeFirstOrThrow();
  }
  return {
    personSalt: entschluessele(masterKey, zeile.person_salt, AAD_PERSON),
    projektSalt: entschluessele(masterKey, zeile.projekt_salt, AAD_PROJEKT),
  };
}
