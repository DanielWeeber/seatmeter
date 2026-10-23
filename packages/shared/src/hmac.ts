// HMAC-Helfer für Pseudonyme und Projektschlüssel (Architektur §3.2, §3.3).
// Nur für Node (node:crypto); deshalb eigener Einstieg `@seatmeter/shared/hmac`, nicht im Haupt-Index.
import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PSEUDONYM_LAENGE = 6;

/** HMAC-SHA256(salt, wert) als 32-Byte-Buffer. */
export function hmacSchluessel(salt: Uint8Array, wert: string): Buffer {
  if (salt.length < 16) throw new Error('Salt zu kurz (mindestens 16 Byte, Standard 32)');
  return createHmac('sha256', salt).update(wert, 'utf8').digest();
}

/** E-Mail für den Schlüssel: getrimmt, klein (Architektur §3.2). */
export function normalisiereEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** `key_konto` = HMAC(person_salt, account_id bzw. account_uuid). */
export function personKeyKonto(personSalt: Uint8Array, kontoKennung: string): Buffer {
  return hmacSchluessel(personSalt, kontoKennung.trim());
}

/** `key_email` = HMAC(person_salt, lower(email)). */
export function personKeyEmail(personSalt: Uint8Array, email: string): Buffer {
  return hmacSchluessel(personSalt, normalisiereEmail(email));
}

/** `projekt_key` = HMAC(projekt_salt, url_norm). */
export function projektKey(projektSalt: Uint8Array, urlNorm: string): Buffer {
  return hmacSchluessel(projektSalt, urlNorm);
}

/** Kodiert Bytes als Base32 (RFC 4648, ohne Auffüllung). */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let wert = 0;
  let aus = '';
  for (const byte of bytes) {
    wert = (wert << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      aus += BASE32[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) aus += BASE32[(wert << (5 - bits)) & 31];
  return aus;
}

/**
 * Anzeige-Pseudonym `P-` + 6 Zeichen Base32 aus einem eigenen HMAC-Label über den Personenschlüssel.
 * `versuch` > 0 erzeugt ein anderes Pseudonym, falls es im Mandanten schon vergeben ist.
 */
export function pseudonym(personSalt: Uint8Array, personKey: Uint8Array, versuch = 0): string {
  const label = `seatmeter:pseudonym:v1:${versuch}:${Buffer.from(personKey).toString('hex')}`;
  return `P-${base32(hmacSchluessel(personSalt, label)).slice(0, PSEUDONYM_LAENGE)}`;
}
