// OIDC je Mandant (SSO je Mandant): Konfiguration in `mandant_oidc` (Secret verschlüsselt unter
// dem Master-Schlüssel), Discovery-Client je Mandant (kurz zwischengespeichert) und die Anmeldung über den
// Anmeldedienst des Mandanten: Konto über (Issuer, Subjekt), sonst über die E-Mail, sonst neu; Gruppen →
// Rollen nur in diesem Mandanten (`rolle.quelle = 'oidc'`); Kontenkontingent bei der ersten Rolle.
import { createHash } from 'node:crypto';
import { protokolliere } from '../audit/protokoll.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { entschluessele } from '../krypto.js';
import { nurEntwickler, ROLLEN, type Rolle } from '@seatmeter/shared';
import * as oidc from 'openid-client';
import { geschuetztesFetch } from './ziel-schutz.js';
import { VERWALTUNG_AUDIT } from '../mandant/verwaltung.js';
import { domainAusEmail, domainVerifiziert } from '../konten/domains.js';
import type { Verwaltung } from '../mandant/verwaltung.js';
import type { KontingentStand } from '../plugin.js';
import { rollenSetzen } from '../konten/konten.js';

export const SECRET_AAD = 'mandant_oidc.client_secret';

export interface MandantOidc {
  mandantId: string;
  slug: string;
  issuer: string;
  clientId: string;
  secret: string;
  scopes: string;
  bezeichnung: string;
  gruppenRollen: Record<string, string[]>;
  aktiv: boolean;
}

/** Konfiguration des Mandanten (mit entschlüsseltem Secret) oder `null`. */
export async function mandantOidcLaden(
  db: Db,
  masterKey: Buffer,
  mandantId: string,
): Promise<MandantOidc | null> {
  const z = await withMandant(db, mandantId, async (trx) => {
    const k = await trx.selectFrom('mandant_oidc').selectAll().executeTakeFirst();
    const m = await trx.selectFrom('mandant').select('slug').executeTakeFirstOrThrow();
    return k ? { ...k, slug: m.slug } : null;
  });
  if (!z) return null;
  return {
    mandantId,
    slug: z.slug,
    issuer: z.issuer,
    clientId: z.client_id,
    secret: entschluessele(masterKey, z.client_secret, SECRET_AAD).toString('utf8'),
    scopes: z.scopes,
    bezeichnung: z.bezeichnung,
    gruppenRollen: z.gruppen_rollen,
    aktiv: z.aktiv,
  };
}

/** Mandant zum Kürzel (Eigentümer-Verbindung vor der Anmeldung, nur die ID). */
export async function mandantZumSlug(db: Db, slug: string): Promise<string | null> {
  const m = await db.selectFrom('mandant').select('id').where('slug', '=', slug).executeTakeFirst();
  return m?.id ?? null;
}

/** Mandanten mit eigener aktiver Konfiguration (Eigentümer-Verbindung, nur IDs). */
export async function mandantenMitEigenemOidc(db: Db): Promise<Set<string>> {
  const z = await db
    .selectFrom('mandant_oidc')
    .select('mandant_id')
    .where('aktiv', '=', true)
    .execute();
  return new Set(z.map((x) => x.mandant_id));
}

/** http-Issuer nur für lokale Tests (Loopback), sonst https. */
export function issuerErlaubt(issuer: string): boolean {
  try {
    const u = new URL(issuer);
    if (u.username || u.password || u.search || u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Discovery mit Client-Zugang (`client_secret_basic`); `timeout` in Sekunden. */
export function entdecken(
  e: { issuer: string; clientId: string; secret: string },
  timeout = 10,
): Promise<oidc.Configuration> {
  return oidc
    .discovery(
      new URL(e.issuer),
      e.clientId,
      undefined,
      oidc.ClientSecretBasic(e.secret),
      e.issuer.startsWith('http://')
        ? { execute: [oidc.allowInsecureRequests], timeout, [oidc.customFetch]: geschuetztesFetch }
        : { timeout, [oidc.customFetch]: geschuetztesFetch },
    )
    .then((konfig) => {
      konfig[oidc.customFetch] = geschuetztesFetch;
      return konfig;
    });
}

/** Discovery-Clients je Mandant, 5 Minuten gültig; eine geänderte Konfiguration gilt sofort. */
export class DiscoveryCache {
  private readonly eintraege = new Map<
    string,
    { schluessel: string; konfig: Promise<oidc.Configuration>; bis: number }
  >();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  holen(k: MandantOidc): Promise<oidc.Configuration> {
    const schluessel = createHash('sha256')
      .update(`${k.issuer}\n${k.clientId}\n${k.secret}`)
      .digest('base64url');
    const alt = this.eintraege.get(k.mandantId);
    if (alt && alt.schluessel === schluessel && alt.bis > Date.now()) return alt.konfig;
    const konfig = entdecken(k).catch((fehler: unknown) => {
      if (this.eintraege.get(k.mandantId)?.konfig === konfig) this.eintraege.delete(k.mandantId);
      throw fehler;
    });
    this.eintraege.set(k.mandantId, { schluessel, konfig, bis: Date.now() + this.ttlMs });
    return konfig;
  }

  vergessen(mandantId: string): void {
    this.eintraege.delete(mandantId);
  }
}

/** Gruppen → Soll-Rollen (nur bekannte Rollen; Projektleiter ohne Projekte sehen nichts). */
export function sollAusGruppen(
  zuordnung: Record<string, string[]>,
  gruppen: readonly string[],
): Map<Rolle, string[] | null> {
  const soll = new Map<Rolle, string[] | null>();
  for (const g of gruppen) {
    for (const r of zuordnung[g] ?? []) {
      if ((ROLLEN as readonly string[]).includes(r))
        soll.set(r as Rolle, r === 'projektleiter' ? [] : null);
    }
  }
  return soll;
}

export type MandantAnmeldung =
  | { ok: true; benutzer: { id: string; benutzername: string } }
  | { ok: false; grund: 'gesperrt' }
  | { ok: false; grund: 'kontingent'; stand: KontingentStand };

/**
 * Konto zur Anmeldung beim Anmeldedienst des Mandanten, in einer Transaktion des Mandanten:
 *   1. (oidc_issuer, oidc_sub) = (Issuer, sub)
 *   2. sonst Anmeldename = E-Mail (`email_verified` nicht `false`, und `true` oder Domain im Mandanten
 *      verifiziert), nur wenn das Konto noch nicht verknüpft ist und keine Rollen in anderen Mandanten hat
 *      (ein Anmeldedienst übernimmt nie Konten fremder Mandanten)
 *   3. sonst neu (`login = oidc`)
 * Gruppen → Rollen nur, wenn die Konfiguration eine Zuordnung hat; entzogen werden nur OIDC-Rollen.
 */
export async function mandantKontoAnmelden(
  db: Db,
  v: Pick<Verwaltung, 'kontingentPruefen'>,
  k: MandantOidc,
  claims: Record<string, unknown>,
  hatFremdeRollen: (benutzerId: string) => Promise<boolean>,
): Promise<MandantAnmeldung> {
  const sub = String(claims.sub);
  const email =
    typeof claims.email === 'string' && claims.email_verified !== false
      ? claims.email.trim().toLowerCase()
      : null;
  const gruppen = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string')
    : [];
  const mitZuordnung = Object.keys(k.gruppenRollen).length > 0;
  const soll = sollAusGruppen(k.gruppenRollen, gruppen);
  const ersatzName = `oidc:${k.slug}:${sub}`.slice(0, 200);

  // Kandidat über die E-Mail vorab (Rollen in anderen Mandanten liest die Eigentümer-Verbindung).
  let kandidat: string | null = null;
  if (email) {
    const gleich = await db
      .selectFrom('benutzer')
      .select(['id', 'oidc_sub'])
      .where('benutzername', '=', email)
      .executeTakeFirst();
    if (gleich && !gleich.oidc_sub && !(await hatFremdeRollen(gleich.id))) kandidat = gleich.id;
  }

  return withMandant(db, k.mandantId, async (trx): Promise<MandantAnmeldung> => {
    let konto = await trx
      .selectFrom('benutzer')
      .select(['id', 'benutzername', 'deaktiviert', 'passwort_hash'])
      .where('oidc_issuer', '=', k.issuer)
      .where('oidc_sub', '=', sub)
      .executeTakeFirst();
    let verknuepfen = false;
    if (!konto && kandidat && email) {
      const domain = domainAusEmail(email);
      const vertraut =
        claims.email_verified === true ||
        (domain !== null && (await domainVerifiziert(trx, domain)));
      if (vertraut) {
        konto = await trx
          .selectFrom('benutzer')
          .select(['id', 'benutzername', 'deaktiviert', 'passwort_hash'])
          .where('id', '=', kandidat)
          .where('oidc_sub', 'is', null)
          .executeTakeFirst();
        verknuepfen = Boolean(konto);
      }
    }
    if (konto?.deaktiviert) return { ok: false, grund: 'gesperrt' };

    // Erste Rolle im Mandanten belegt einen Platz im Kontenkontingent.
    if (mitZuordnung && soll.size > 0) {
      const voll = await v.kontingentPruefen(trx, konto?.id ?? null);
      if (voll) return { ok: false, grund: 'kontingent', stand: voll };
    }

    if (!konto) {
      const frei =
        email &&
        !(await trx
          .selectFrom('benutzer')
          .select('id')
          .where('benutzername', '=', email)
          .executeTakeFirst());
      const neu = await trx
        .insertInto('benutzer')
        .values({
          benutzername: frei ? email : ersatzName,
          login: 'oidc',
          oidc_sub: sub,
          oidc_issuer: k.issuer,
        })
        .returning(['id', 'benutzername', 'deaktiviert', 'passwort_hash'])
        .executeTakeFirstOrThrow();
      // Nur `entwickler`: ohne Konto im Audit, das Anlegen passiert beim ersten Folgen des Links, direkt vor der Wahl.
      const nurWahl = mitZuordnung && nurEntwickler([...soll.keys()]);
      await protokolliere(trx, {
        benutzerId: nurWahl ? null : neu.id,
        aktion: VERWALTUNG_AUDIT.kontoAngelegt,
        objekt: nurWahl
          ? 'OIDC des Mandanten, Rolle entwickler'
          : `benutzer:${neu.id} (OIDC des Mandanten)`,
      });
      konto = neu;
    } else if (verknuepfen) {
      await trx
        .updateTable('benutzer')
        .set({
          oidc_sub: sub,
          oidc_issuer: k.issuer,
          ...(konto.passwort_hash ? {} : { login: 'oidc' as const }),
        })
        .where('id', '=', konto.id)
        .execute();
    }

    if (mitZuordnung) {
      await rollenSetzen(trx, {
        benutzerId: konto.id,
        soll,
        quelle: 'oidc',
        entziehen: 'quelle',
        akteur: konto.id,
        hinweis: 'OIDC-Gruppe',
        ohneKontoBeiEntwickler: true,
      });
    }
    return { ok: true, benutzer: { id: konto.id, benutzername: konto.benutzername } };
  });
}
