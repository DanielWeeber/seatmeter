// Verschlüsselung unter SEATMETER_MASTER_KEY (Architektur §3.1 `mandant_geheimnis`, `person_klar`).
// Format (Version 1): 0x01 | IV (12 Byte) | Tag (16 Byte) | Geheimtext; AES-256-GCM.
// Zusatzdaten (AAD) binden den Geheimtext an Tabelle und Spalte, damit Werte nicht vertauschbar sind.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LAENGE = 12;
const TAG_LAENGE = 16;

export function verschluessele(masterKey: Buffer, klartext: Buffer | string, aad = ''): Buffer {
  if (masterKey.length !== 32) throw new Error('Master-Schlüssel muss 32 Byte haben');
  const iv = randomBytes(IV_LAENGE);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const daten = Buffer.concat([
    cipher.update(typeof klartext === 'string' ? Buffer.from(klartext, 'utf8') : klartext),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), daten]);
}

export function entschluessele(masterKey: Buffer, geheim: Buffer, aad = ''): Buffer {
  if (geheim.length < 1 + IV_LAENGE + TAG_LAENGE || geheim[0] !== VERSION) {
    throw new Error('Unbekanntes Verschlüsselungsformat');
  }
  const iv = geheim.subarray(1, 1 + IV_LAENGE);
  const tag = geheim.subarray(1 + IV_LAENGE, 1 + IV_LAENGE + TAG_LAENGE);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(geheim.subarray(1 + IV_LAENGE + TAG_LAENGE)),
    decipher.final(),
  ]);
}

/** SHA-256 eines Tokens (Sitzungen, Einrichtungs-Token); gespeichert wird nie das Token selbst. */
export function sha256(wert: string): Buffer {
  return createHash('sha256').update(wert, 'utf8').digest();
}

/** Zufallstoken (URL-sicheres Base64). */
export function zufallsToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
