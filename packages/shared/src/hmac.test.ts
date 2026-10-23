import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32,
  hmacSchluessel,
  personKeyEmail,
  personKeyKonto,
  projektKey,
  pseudonym,
} from './hmac.js';

const salt = Buffer.alloc(32, 7);
const andererSalt = Buffer.alloc(32, 9);

describe('HMAC-Helfer (Architektur §3.2)', () => {
  it('entspricht HMAC-SHA256', () => {
    const erwartet = createHmac('sha256', salt).update('abc').digest();
    expect(hmacSchluessel(salt, 'abc').equals(erwartet)).toBe(true);
    expect(hmacSchluessel(salt, 'abc')).toHaveLength(32);
  });

  it('E-Mail wird getrimmt und klein geschrieben', () => {
    expect(personKeyEmail(salt, '  Max.Muster@Example.ORG ')).toEqual(
      personKeyEmail(salt, 'max.muster@example.org'),
    );
  });

  it('anderes Salt ergibt anderen Schlüssel', () => {
    expect(personKeyKonto(salt, 'konto-1')).not.toEqual(personKeyKonto(andererSalt, 'konto-1'));
    expect(projektKey(salt, 'https://github.com/o/r')).not.toEqual(
      projektKey(andererSalt, 'https://github.com/o/r'),
    );
  });

  it('lehnt zu kurzes Salt ab', () => {
    expect(() => hmacSchluessel(Buffer.alloc(8), 'x')).toThrow();
  });

  it('Base32 nach RFC 4648', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(Buffer.from('f'))).toBe('MY');
  });

  it('Pseudonym hat die Form P- plus 6 Zeichen Base32 und ist stabil', () => {
    const key = personKeyKonto(salt, 'user_01ABC');
    const p = pseudonym(salt, key);
    expect(p).toMatch(/^P-[A-Z2-7]{6}$/);
    expect(pseudonym(salt, key)).toBe(p);
    expect(pseudonym(salt, key, 1)).not.toBe(p);
    expect(pseudonym(andererSalt, key)).not.toBe(p);
  });

  it('enthält die Kennung nicht im Klartext', () => {
    const key = personKeyEmail(salt, 'test@example.org');
    expect(key.toString('utf8')).not.toContain('test@example.org');
    expect(key.toString('hex')).not.toContain(Buffer.from('test').toString('hex'));
  });
});
