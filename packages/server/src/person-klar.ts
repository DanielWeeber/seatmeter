// Klarnamen (Architektur §3.1 `person_klar`): E-Mail und Anzeigename einer Person, nur verschlüsselt
// (AES-256-GCM unter SEATMETER_MASTER_KEY, AAD `person_klar.<spalte>`) und nur solange
// `mandant.klarnamen_aktiv` gilt. Quellen: E-Mail aus der Telemetrie (Ingest), E-Mail und Name aus
// Anmeldung (OIDC) und SCIM, wenn der Schlüssel `key_email` einer bekannten Person passt. Aus Anmeldung
// und SCIM entsteht nie eine Person. Rohwerte werden nie protokolliert.
import { sql, type Transaction } from 'kysely';
import { normalisiereEmail, personKeyEmail } from '@seatmeter/shared/hmac';
import type { Db } from './db/db.js';
import { withMandant } from './db/mandant.js';
import type { Datenbank } from './db/schema.js';
import { mandantSaltsLesen } from './ingest-gemeinsam/geheimnis.js';
import { entschluessele, verschluessele } from './krypto.js';

type Trx = Transaction<Datenbank>;

const AAD_EMAIL = 'person_klar.email_enc';
const AAD_NAME = 'person_klar.name_enc';
const MAX_NAME = 200;

function lesen(masterKey: Buffer, wert: Buffer | null, aad: string): string | null {
  if (!wert) return null;
  try {
    return entschluessele(masterKey, wert, aad).toString('utf8');
  } catch {
    return null;
  }
}

/** Anzeigename aus OIDC-Claims (`name`, sonst Vor- und Nachname) oder SCIM; `null`, wenn leer. */
export function anzeigenameAus(teile: (string | null | undefined)[]): string | null {
  const text = teile
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim())
    .join(' ')
    .slice(0, MAX_NAME);
  return text === '' ? null : text;
}

export async function klarnamenAktiv(trx: Trx): Promise<boolean> {
  const m = await trx.selectFrom('mandant').select('klarnamen_aktiv').executeTakeFirst();
  return m?.klarnamen_aktiv ?? false;
}

/**
 * Schreibt E-Mail und/oder Namen der Person verschlüsselt, aber nur, wenn sich etwas ändert
 * (kein Schreibzugriff bei gleichem Wert). Fehlende Angaben (`undefined`) bleiben unverändert.
 * Liefert `true`, wenn geschrieben wurde. `trx` stammt aus `withMandant`.
 */
export async function klarSchreiben(
  trx: Trx,
  masterKey: Buffer,
  mandantId: string,
  personId: string,
  neu: { email?: string | null; name?: string | null },
): Promise<boolean> {
  const email = neu.email ? normalisiereEmail(neu.email) : null;
  const name = neu.name ? neu.name.trim().slice(0, MAX_NAME) : null;
  if (!email && !name) return false;
  const alt = await trx
    .selectFrom('person_klar')
    .select(['email_enc', 'name_enc'])
    .where('person_id', '=', personId)
    .executeTakeFirst();
  const emailAendern =
    Boolean(email) && lesen(masterKey, alt?.email_enc ?? null, AAD_EMAIL) !== email;
  const nameAendern = Boolean(name) && lesen(masterKey, alt?.name_enc ?? null, AAD_NAME) !== name;
  if (!emailAendern && !nameAendern) return false;
  const emailEnc = emailAendern && email ? verschluessele(masterKey, email, AAD_EMAIL) : null;
  const nameEnc = nameAendern && name ? verschluessele(masterKey, name, AAD_NAME) : null;
  await sql`
    INSERT INTO person_klar (person_id, mandant_id, email_enc, name_enc)
    VALUES (${personId}::uuid, ${mandantId}::uuid, ${emailEnc}, ${nameEnc})
    ON CONFLICT (person_id) DO UPDATE SET
      email_enc = COALESCE(EXCLUDED.email_enc, person_klar.email_enc),
      name_enc = COALESCE(EXCLUDED.name_enc, person_klar.name_enc)`.execute(trx);
  return true;
}

/**
 * Gleicht eine Anmeldung bzw. einen SCIM-Benutzer mit den Personen des Mandanten ab: Passt der
 * HMAC der E-Mail zu `person.key_email`, werden E-Mail und Name geschrieben. Legt nie eine Person an.
 * Voraussetzung `klarnamen_aktiv` prüft der Aufrufer (`klarnamenAktiv`). Liefert, ob geschrieben wurde.
 */
export async function klarAbgleichen(
  trx: Trx,
  masterKey: Buffer,
  mandantId: string,
  angaben: { email: string; name?: string | null },
): Promise<boolean> {
  const salts = await mandantSaltsLesen(trx, masterKey, mandantId);
  if (!salts) return false;
  const person = await trx
    .selectFrom('person')
    .select('id')
    .where('mandant_id', '=', mandantId)
    .where('key_email', '=', personKeyEmail(salts.personSalt, angaben.email))
    .executeTakeFirst();
  if (!person) return false;
  return klarSchreiben(trx, masterKey, mandantId, person.id, angaben);
}

/**
 * Beim Einschalten: füllt aus den vorhandenen Dashboard- und SCIM-Konten des Mandanten (Anmeldename
 * = E-Mail) alle Personen, deren `key_email` passt. Namen kennt seatmeter dort nicht, sie kommen
 * mit der nächsten Anmeldung bzw. dem nächsten SCIM-Abgleich. Liefert die Zahl befüllter Personen.
 */
export async function klarNachfuellen(
  trx: Trx,
  masterKey: Buffer,
  mandantId: string,
): Promise<number> {
  const salts = await mandantSaltsLesen(trx, masterKey, mandantId);
  if (!salts) return 0;
  const konten = await sql<{ benutzername: string }>`
    SELECT DISTINCT b.benutzername FROM benutzer b
    WHERE b.benutzername LIKE '%@%' AND (
      EXISTS (SELECT 1 FROM rolle r WHERE r.benutzer_id = b.id AND r.mandant_id = ${mandantId}::uuid)
      OR EXISTS (SELECT 1 FROM scim_konto s WHERE s.benutzer_id = b.id AND s.mandant_id = ${mandantId}::uuid))`.execute(
    trx,
  );
  let befuellt = 0;
  for (const k of konten.rows) {
    const person = await trx
      .selectFrom('person')
      .select('id')
      .where('mandant_id', '=', mandantId)
      .where('key_email', '=', personKeyEmail(salts.personSalt, k.benutzername))
      .executeTakeFirst();
    if (
      person &&
      (await klarSchreiben(trx, masterKey, mandantId, person.id, { email: k.benutzername }))
    )
      befuellt++;
  }
  return befuellt;
}

/** Beim Ausschalten: löscht alle Klarnamen des Mandanten (Datensparsamkeit). Liefert die Zahl der Zeilen. */
export async function klarLoeschen(trx: Trx, mandantId: string): Promise<number> {
  const r = await trx
    .deleteFrom('person_klar')
    .where('mandant_id', '=', mandantId)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}

/**
 * Nach einer Anmeldung: E-Mail und Name aus den OIDC-Claims in jedem Mandanten des Kontos (Rollen oder
 * SCIM-Verknüpfung) mit aktiven Klarnamen abgleichen. Fehler brechen die Anmeldung nie ab; geloggt
 * wird nur der Fehlertyp.
 */
export async function klarNachAnmeldung(
  db: Db,
  masterKey: Buffer,
  benutzerId: string,
  claims: Record<string, unknown>,
  benutzername: string,
  log: { warn: (o: object, m: string) => void },
  mandantIds?: string[],
): Promise<void> {
  try {
    const email =
      typeof claims.email === 'string' && claims.email_verified !== false
        ? claims.email.trim()
        : benutzername.includes('@')
          ? benutzername
          : null;
    if (!email) return;
    const text = (w: unknown) => (typeof w === 'string' ? w : null);
    const name =
      anzeigenameAus([text(claims.name)]) ??
      anzeigenameAus([text(claims.given_name), text(claims.family_name)]);
    let ids = mandantIds;
    if (!ids) {
      const z = await sql<{ mandant_id: string }>`
        SELECT mandant_id FROM rolle WHERE benutzer_id = ${benutzerId}::uuid
        UNION SELECT mandant_id FROM scim_konto WHERE benutzer_id = ${benutzerId}::uuid`.execute(
        db,
      );
      ids = z.rows.map((r) => r.mandant_id);
    }
    for (const mandantId of ids) {
      await withMandant(db, mandantId, async (trx) => {
        if (await klarnamenAktiv(trx))
          await klarAbgleichen(trx, masterKey, mandantId, { email, name });
      });
    }
  } catch (e) {
    log.warn(
      { fehler: e instanceof Error ? e.name : 'unbekannt' },
      'Klarnamen aus Anmeldung nicht übernommen',
    );
  }
}
