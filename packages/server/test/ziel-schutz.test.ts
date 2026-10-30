// SSRF-Schutz der OIDC-Discovery je Mandant: interne Ziele gesperrt, Ausnahme per ENV.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adresseIntern, pruefeZiel } from '../src/oidc/ziel-schutz.js';

describe('OIDC-Zielschutz', () => {
  const alt = process.env.SEATMETER_OIDC_PRIVATE_ZIELE;
  beforeEach(() => {
    delete process.env.SEATMETER_OIDC_PRIVATE_ZIELE;
  });
  afterEach(() => {
    if (alt === undefined) delete process.env.SEATMETER_OIDC_PRIVATE_ZIELE;
    else process.env.SEATMETER_OIDC_PRIVATE_ZIELE = alt;
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    ['192', '168', '1', '1'].join('.'),
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ])('sperrt %s', (a) => expect(adresseIntern(a)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])('erlaubt %s', (a) =>
    expect(adresseIntern(a)).toBe(false),
  );

  it('prüft Literale und localhost', async () => {
    await expect(pruefeZiel(new URL('https://169.254.169.254/'))).rejects.toThrow(/nicht erlaubt/);
    await expect(pruefeZiel(new URL('https://[::1]/'))).rejects.toThrow(/nicht erlaubt/);
    await expect(pruefeZiel(new URL('https://localhost/'))).rejects.toThrow(/nicht erlaubt/);
    await expect(pruefeZiel(new URL('https://8.8.8.8/'))).resolves.toBeUndefined();
  });

  it('Ausnahme per ENV', async () => {
    process.env.SEATMETER_OIDC_PRIVATE_ZIELE = '1';
    await expect(pruefeZiel(new URL('https://10.0.0.1/'))).resolves.toBeUndefined();
  });
});
