// SSRF-Schutz für OIDC je Mandant: Discovery, JWKS, Token und Userinfo laufen unter einer
// vom Mandanten-Admin eingetragenen URL. Ziele in privaten, Loopback-, Link-Local- und Metadaten-Bereichen
// werden vor der Anfrage gesperrt (DNS-Auflösung, alle Adressen müssen öffentlich sein). Ausnahme für Tests und
// On-Prem: SEATMETER_OIDC_PRIVATE_ZIELE=1. Weiterleitungen werden nicht verfolgt.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** true, wenn die Adresse nicht öffentlich routbar ist (RFC1918, CGNAT, Loopback, Link-Local, ULA, Multicast …). */
export function adresseIntern(adresse: string): boolean {
  let a = adresse.toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped?.[1]) a = mapped[1];
  const v = isIP(a);
  if (v === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return (
      p === 0 ||
      p === 10 ||
      p === 127 ||
      p >= 224 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 192 && q === 0) ||
      (p === 198 && (q === 18 || q === 19))
    );
  }
  if (v === 6) {
    return (
      a === '::' ||
      a === '::1' ||
      /^f[cd]/.test(a) ||
      /^fe[89ab]/.test(a) ||
      a.startsWith('ff') ||
      a.startsWith('64:ff9b:') ||
      a.startsWith('::ffff:')
    );
  }
  return true;
}

function privateZieleErlaubt(): boolean {
  return process.env.SEATMETER_OIDC_PRIVATE_ZIELE === '1';
}

/** Wirft, wenn der Host intern ist oder auf eine interne Adresse auflöst. */
export async function pruefeZiel(url: URL): Promise<void> {
  if (privateZieleErlaubt()) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const adressen = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((x) => x.address);
  if (adressen.length === 0 || adressen.some(adresseIntern)) {
    throw new Error(`OIDC-Ziel ${url.hostname} ist nicht erlaubt (interne Adresse)`);
  }
}

/** fetch für `openid-client` (customFetch): Ziel prüfen, keine Weiterleitungen. */
export async function geschuetztesFetch(url: string, optionen: RequestInit): Promise<Response> {
  await pruefeZiel(new URL(url));
  return fetch(url, { ...optionen, redirect: 'error' });
}
