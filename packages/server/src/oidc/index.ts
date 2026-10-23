// Modul oidc (Architektur §6, Kern seit 2026-10-24, vorher ee): Anmeldung per Authorization Code + PKCE gegen einen
// OIDC-Provider mit `openid-client`, entweder über den globalen Anbieter des Betreibers (SEATMETER_OIDC_*,
// Referenz Authelia) oder über den Anmeldedienst eines Mandanten (`mandant_oidc`, SSO je Mandant). Nach dem
// Rückruf entsteht eine normale Dashboard-Sitzung (Cookie, `quelle = 'oidc'`).
//   GET  /api/v1/auth/oidc/start[?mandant=<slug>]  → 302 zum Provider (state, nonce, PKCE S256, Mandant im Cookie)
//   GET  /api/v1/auth/oidc/callback                → Token, Konto, Gruppen → Rollen, Sitzung, 302 ins Dashboard
//   POST /api/v1/auth/oidc/logout                  → Sitzung löschen, `{ weiter }` = end_session-URL, falls angeboten
//   GET/PUT/DELETE /api/v1/mandant/oidc, POST …/pruefen      → Konfiguration je Mandant (Mandantenverwaltung)
import {
  erstelleSitzung,
  loescheCookies,
  requireAnmeldung,
  rollenDesBenutzers,
} from '../auth/kontext.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { entschluessele, verschluessele } from '../krypto.js';
import type { AuthProvider } from '../plugin.js';
// Typen für request.cookies / reply.setCookie (Plugin registriert der Kern).
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { domainAusEmail, mandantZurDomain } from '../konten/domains.js';
import type { Konfiguration } from '../config.js';
import { verwaltung } from '../mandant/verwaltung.js';
import type { SeatmeterPlugin } from '../plugin.js';
import { registriereKonfigurationRouten } from './konfiguration-routen.js';
import {
  DiscoveryCache,
  mandantenMitEigenemOidc,
  mandantKontoAnmelden,
  mandantOidcLaden,
  mandantZumSlug,
  type MandantOidc,
} from './mandant.js';
import { rollenAbgleichen, sollRollen } from './rollen.js';

export const OIDC_COOKIE = 'seatmeter_oidc';
const COOKIE_PFAD = '/api/v1/auth/oidc';
const ZUSTAND_AAD = 'oidc.zustand';
const ZUSTAND_SEKUNDEN = 600;
export const OIDC_START = '/api/v1/auth/oidc/start';
const CALLBACK_PFAD = '/api/v1/auth/oidc/callback';

const zustandSchema = z.strictObject({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  ziel: z.string(),
  ablauf: z.number(),
  /** Anmeldung über den Anmeldedienst dieses Mandanten (ID); fehlt beim globalen Anbieter. */
  mandant: z.uuid().optional(),
});

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

/** Rückruf-URL für alle Anbieter: SEATMETER_OIDC_REDIRECT_URI oder SEATMETER_PUBLIC_URL + Callback-Pfad. */
export function redirectUri(ee: Konfiguration, publicUrl: string | undefined): string | null {
  return (
    ee.SEATMETER_OIDC_REDIRECT_URI ??
    (publicUrl ? new URL(CALLBACK_PFAD, publicUrl).toString() : null)
  );
}

/** OIDC ist nutzbar, wenn Issuer, Client-ID, Secret und eine Rückruf-URL feststehen. */
export function oidcEinstellungen(ee: Konfiguration, publicUrl: string | undefined) {
  const { SEATMETER_OIDC_ISSUER: issuer, SEATMETER_OIDC_CLIENT_ID: clientId } = ee;
  const secret = ee.SEATMETER_OIDC_CLIENT_SECRET;
  const redirect = redirectUri(ee, publicUrl);
  if (!issuer || !clientId || !secret || !redirect) return null;
  return { issuer, clientId, secret, redirect, scopes: ee.SEATMETER_OIDC_SCOPES };
}

/** Nur Pfade im Dashboard als Ziel nach der Anmeldung (keine offenen Weiterleitungen). */
function sicheresZiel(wert: unknown): string {
  return typeof wert === 'string' && /^\/(?![/\\])[^\s]*$/.test(wert) && wert.length <= 500
    ? wert
    : '/';
}

const ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const html = (t: string) => t.replace(/[&<>"']/g, (z) => ESCAPE[z] ?? z);

/** Fehler im Anmeldeablauf: für Browser eine verständliche Seite, sonst JSON `{ code, fehler }`. */
function fehler(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  text: string,
) {
  if (!String(request.headers.accept ?? '').includes('text/html'))
    return reply.code(status).type('application/json').send({ code, fehler: text });
  const seite = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Anmeldung – seatmeter</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:16px}
main{max-width:28rem;margin:10vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:24px}
a{color:#0f172a}</style></head><body><main data-code="${html(code)}"><p><strong>seatmeter</strong></p>
<h1>Anmeldung nicht möglich</h1><p>${html(text)}</p><p><a href="/">Zur Anmeldeseite</a></p></main></body></html>`;
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(seite);
}

export const oidcPlugin: SeatmeterPlugin = {
  name: 'kern-oidc',

  authProvider: [
    {
      name: 'oidc',
      // Nach dem Rückruf gilt die normale Sitzung (Cookie); pro Anfrage ist OIDC nicht zuständig.
      authentifizieren: async () => null,
      anmeldeLink(ctx) {
        const k = ctx.konfiguration;
        if (!oidcEinstellungen(k, k.SEATMETER_PUBLIC_URL)) return null;
        return { titel: `Mit ${k.SEATMETER_OIDC_BEZEICHNUNG} anmelden`, start: OIDC_START };
      },
      // Anmeldeseite: verifizierte Domain bzw. Kürzel → aktiver Anmeldedienst des Mandanten.
      async anmeldeZiel(abfrage, ctx) {
        if (!redirectUri(ctx.konfiguration, ctx.konfiguration.SEATMETER_PUBLIC_URL)) return null;
        let mandantId: string | null = null;
        if (abfrage.email) {
          const domain = domainAusEmail(abfrage.email);
          mandantId = domain ? await mandantZurDomain(ctx.db, domain) : null;
        } else if (abfrage.mandant) {
          mandantId = await mandantZumSlug(ctx.db, abfrage.mandant);
        }
        if (!mandantId) return null;
        const z = await withMandant(ctx.db, mandantId, async (trx) => {
          const k = await trx
            .selectFrom('mandant_oidc')
            .select(['bezeichnung', 'aktiv'])
            .executeTakeFirst();
          const m = await trx.selectFrom('mandant').select('slug').executeTakeFirstOrThrow();
          return k ? { ...k, slug: m.slug } : null;
        });
        if (!z?.aktiv) return null;
        return {
          bezeichnung: z.bezeichnung,
          start: `${OIDC_START}?mandant=${encodeURIComponent(z.slug)}`,
        };
      },
    } satisfies AuthProvider,
  ],

  routen(app, { db, konfiguration }) {
    const ee = konfiguration;
    const v = verwaltung(app.seatmeterAuth);
    const einstellungen = oidcEinstellungen(ee, konfiguration.SEATMETER_PUBLIC_URL);
    const redirect = redirectUri(ee, konfiguration.SEATMETER_PUBLIC_URL);
    const masterKey = konfiguration.SEATMETER_MASTER_KEY;
    const secure = (redirect ?? konfiguration.SEATMETER_PUBLIC_URL ?? '').startsWith('https://');
    const cache = new DiscoveryCache();
    let konfig: Promise<oidc.Configuration> | null = null;

    registriereKonfigurationRouten(app, db, {
      masterKey,
      redirectUri: redirect,
      startPfad: OIDC_START,
      cache,
    });

    /** Discovery des globalen Anbieters einmal je Prozess; schlägt sie fehl, beim nächsten Versuch erneut. */
    function providerKonfiguration(): Promise<oidc.Configuration> {
      if (!einstellungen) throw new Error('OIDC nicht konfiguriert');
      konfig ??= oidc
        .discovery(
          new URL(einstellungen.issuer),
          einstellungen.clientId,
          undefined,
          oidc.ClientSecretBasic(einstellungen.secret),
          // http-Issuer nur für Tests und lokale Entwicklung.
          einstellungen.issuer.startsWith('http://')
            ? { execute: [oidc.allowInsecureRequests] }
            : undefined,
        )
        .catch((e: unknown) => {
          konfig = null;
          throw e;
        });
      return konfig;
    }

    /** Aktive Konfiguration eines Mandanten (per ID) oder `null`. */
    async function mandantKonfig(mandantId: string): Promise<MandantOidc | null> {
      const k = await mandantOidcLaden(db, masterKey, mandantId);
      return k?.aktiv ? k : null;
    }

    app.get(OIDC_START, async (request, reply) => {
      const query = request.query as { ziel?: unknown; mandant?: unknown };
      let mandant: MandantOidc | null = null;
      if (query.mandant !== undefined) {
        const slug = slugSchema.safeParse(query.mandant);
        const id = slug.success ? await mandantZumSlug(db, slug.data) : null;
        mandant = id ? await mandantKonfig(id) : null;
        if (!mandant || !redirect)
          return fehler(
            request,
            reply,
            404,
            'oidc_aus',
            'Für diesen Mandanten ist keine SSO-Anmeldung eingerichtet.',
          );
      } else if (!einstellungen) {
        return fehler(request, reply, 404, 'oidc_aus', 'OIDC-Anmeldung ist nicht konfiguriert.');
      }
      let config: oidc.Configuration;
      try {
        config = mandant ? await cache.holen(mandant) : await providerKonfiguration();
      } catch (e) {
        request.log.error(
          { fehler: e instanceof Error ? e.name : 'unbekannt', mandant: mandant?.slug ?? null },
          'OIDC-Discovery fehlgeschlagen',
        );
        return fehler(
          request,
          reply,
          502,
          'oidc_provider',
          'Der Anmeldedienst ist nicht erreichbar.',
        );
      }
      const verifier = oidc.randomPKCECodeVerifier();
      const zustand = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier,
        ziel: sicheresZiel(query.ziel),
        ablauf: Date.now() + ZUSTAND_SEKUNDEN * 1000,
        ...(mandant ? { mandant: mandant.mandantId } : {}),
      };
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: mandant ? (redirect ?? '') : (einstellungen?.redirect ?? ''),
        scope: mandant ? mandant.scopes : (einstellungen?.scopes ?? 'openid'),
        state: zustand.state,
        nonce: zustand.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      });
      reply.setCookie(
        OIDC_COOKIE,
        verschluessele(masterKey, JSON.stringify(zustand), ZUSTAND_AAD).toString('base64url'),
        { path: COOKIE_PFAD, httpOnly: true, sameSite: 'lax', secure, maxAge: ZUSTAND_SEKUNDEN },
      );
      return reply.redirect(url.href, 302);
    });

    app.get(CALLBACK_PFAD, async (request, reply) => {
      const roh = request.cookies[OIDC_COOKIE];
      reply.clearCookie(OIDC_COOKIE, { path: COOKIE_PFAD });
      const zustand = zustandAus(roh, masterKey);
      if (!zustand && !einstellungen && !roh)
        return fehler(request, reply, 404, 'oidc_aus', 'OIDC-Anmeldung ist nicht konfiguriert.');
      if (!zustand) {
        return fehler(
          request,
          reply,
          400,
          'oidc_zustand',
          'Anmeldung abgelaufen oder ungültig. Bitte erneut anmelden.',
        );
      }
      const mandant = zustand.mandant ? await mandantKonfig(zustand.mandant) : null;
      const rueckruf = mandant ? redirect : (einstellungen?.redirect ?? null);
      if ((zustand.mandant && !mandant) || !rueckruf)
        return fehler(request, reply, 404, 'oidc_aus', 'OIDC-Anmeldung ist nicht konfiguriert.');
      let config: oidc.Configuration;
      try {
        config = mandant ? await cache.holen(mandant) : await providerKonfiguration();
      } catch (e) {
        request.log.error(
          { fehler: e instanceof Error ? e.name : 'unbekannt', mandant: mandant?.slug ?? null },
          'OIDC-Discovery fehlgeschlagen',
        );
        return fehler(
          request,
          reply,
          502,
          'oidc_provider',
          'Der Anmeldedienst ist nicht erreichbar.',
        );
      }
      const aktuell = new URL(rueckruf);
      aktuell.search = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      let claims: Record<string, unknown>;
      try {
        const tokens = await oidc.authorizationCodeGrant(config, aktuell, {
          pkceCodeVerifier: zustand.verifier,
          expectedState: zustand.state,
          expectedNonce: zustand.nonce,
          idTokenExpected: true,
        });
        claims = { ...(tokens.claims() ?? {}) };
        const sub = claims.sub;
        if (typeof sub !== 'string') throw new Error('ID-Token ohne sub');
        if (claims.email === undefined || claims.groups === undefined) {
          const info = await oidc.fetchUserInfo(config, tokens.access_token, sub);
          claims = {
            ...info,
            ...claims,
            groups: claims.groups ?? info.groups,
            email: claims.email ?? info.email,
          };
        }
      } catch (e) {
        const code =
          e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : null;
        request.log.warn(
          { fehler: e instanceof Error ? e.name : 'unbekannt', code },
          'OIDC-Rückruf abgelehnt',
        );
        return fehler(
          request,
          reply,
          401,
          'oidc_abgelehnt',
          'Die Anmeldung wurde vom Anmeldedienst abgelehnt.',
        );
      }

      if (mandant) {
        const ergebnis = await mandantKontoAnmelden(db, v, mandant, claims, async (id) =>
          (await rollenDesBenutzers(db, id)).some((r) => r.mandant_id !== mandant.mandantId),
        );
        if (!ergebnis.ok && ergebnis.grund === 'gesperrt')
          return fehler(request, reply, 403, 'konto_gesperrt', 'Dieses Konto ist deaktiviert.');
        if (!ergebnis.ok) {
          const { belegt, max } = ergebnis.stand;
          return fehler(
            request,
            reply,
            403,
            'konten_kontingent',
            `Für Ihr Konto ist kein Platz mehr frei: Das Kontenkontingent Ihrer Organisation ist ausgeschöpft (${belegt} von ${max ?? '∞'} Konten). Bitte wenden Sie sich an Ihre Administration.`,
          );
        }
        await erstelleSitzung(
          app.seatmeterAuth,
          reply,
          ergebnis.benutzer,
          'oidc',
          mandant.mandantId,
        );
        return reply.redirect(zustand.ziel, 302);
      }

      const issuer = einstellungen?.issuer ?? '';
      const benutzer = await kontoVerknuepfen(db, claims, issuer);
      if (!benutzer)
        return fehler(request, reply, 403, 'konto_gesperrt', 'Dieses Konto ist deaktiviert.');
      if (ee.SEATMETER_OIDC_GRUPPEN) {
        const gruppen = Array.isArray(claims.groups)
          ? claims.groups.filter((g) => typeof g === 'string')
          : [];
        // Mandanten mit eigenem Anmeldedienst verwalten ihre OIDC-Rollen selbst.
        await rollenAbgleichen(
          db,
          benutzer.id,
          await sollRollen(db, ee.SEATMETER_OIDC_GRUPPEN, gruppen, request.log),
          await mandantenMitEigenemOidc(db),
          v,
        );
      }
      await erstelleSitzung(app.seatmeterAuth, reply, benutzer, 'oidc');
      return reply.redirect(zustand.ziel, 302);
    });

    app.post(
      '/api/v1/auth/oidc/logout',
      { preHandler: requireAnmeldung },
      async (request, reply) => {
        const a = request.benutzer;
        if (a?.sitzungId)
          await db.deleteFrom('benutzer_sitzung').where('id', '=', a.sitzungId).execute();
        loescheCookies(reply);
        let weiter: string | null = null;
        try {
          // end_session des Anbieters, über den das Konto angemeldet ist (global oder Mandant).
          const b = a
            ? await db
                .selectFrom('benutzer')
                .select('oidc_issuer')
                .where('id', '=', a.benutzerId)
                .executeTakeFirst()
            : undefined;
          const mandant = a?.mandantId ? await mandantKonfig(a.mandantId) : null;
          let config: oidc.Configuration | null = null;
          if (mandant && b?.oidc_issuer === mandant.issuer) config = await cache.holen(mandant);
          else if (einstellungen) config = await providerKonfiguration();
          if (config?.serverMetadata().end_session_endpoint) {
            const ziel = konfiguration.SEATMETER_PUBLIC_URL;
            weiter = oidc.buildEndSessionUrl(
              config,
              ziel ? { post_logout_redirect_uri: ziel } : {},
            ).href;
          }
        } catch {
          weiter = null;
        }
        return { weiter };
      },
    );
  },
};

function zustandAus(roh: string | undefined, masterKey: Buffer) {
  if (!roh) return null;
  try {
    const z = zustandSchema.parse(
      JSON.parse(
        entschluessele(masterKey, Buffer.from(roh, 'base64url'), ZUSTAND_AAD).toString('utf8'),
      ),
    );
    return z.ablauf > Date.now() ? z : null;
  } catch {
    return null;
  }
}

/**
 * Konto zum Subjekt des globalen Anbieters: zuerst über (`oidc_issuer`, `oidc_sub`) – Konten von vor
 * Migration 0019 tragen noch keinen Issuer und bekommen ihn jetzt –, sonst über den Anmeldenamen (= E-Mail,
 * wie im Header-Modus hinter Authelia), sonst neu. Eine E-Mail mit `email_verified = false` verknüpft nie.
 */
export async function kontoVerknuepfen(
  db: Db,
  claims: Record<string, unknown>,
  issuer: string,
): Promise<{ id: string; benutzername: string } | null> {
  const sub = String(claims.sub);
  const vorhanden = await db
    .selectFrom('benutzer')
    .select(['id', 'benutzername', 'deaktiviert', 'oidc_issuer'])
    .where('oidc_sub', '=', sub)
    .where((eb) => eb.or([eb('oidc_issuer', '=', issuer), eb('oidc_issuer', 'is', null)]))
    .orderBy('oidc_issuer')
    .executeTakeFirst();
  if (vorhanden) {
    if (vorhanden.oidc_issuer === null)
      await db
        .updateTable('benutzer')
        .set({ oidc_issuer: issuer })
        .where('id', '=', vorhanden.id)
        .execute();
    return vorhanden.deaktiviert ? null : vorhanden;
  }

  const email =
    typeof claims.email === 'string' && claims.email_verified !== false
      ? claims.email.trim().toLowerCase()
      : null;
  const name =
    email ??
    (typeof claims.preferred_username === 'string'
      ? `oidc:${claims.preferred_username}`
      : `oidc:${sub}`);
  const gleich = await db
    .selectFrom('benutzer')
    .select(['id', 'benutzername', 'deaktiviert', 'passwort_hash', 'oidc_sub'])
    .where('benutzername', '=', name)
    .executeTakeFirst();
  if (gleich) {
    if (gleich.deaktiviert) return null;
    // Schon mit einem anderen Subjekt verknüpft: nicht übernehmen, eigenes Konto anlegen.
    if (!gleich.oidc_sub && email) {
      await db
        .updateTable('benutzer')
        .set({
          oidc_sub: sub,
          oidc_issuer: issuer,
          ...(gleich.passwort_hash ? {} : { login: 'oidc' as const }),
        })
        .where('id', '=', gleich.id)
        .execute();
      return { id: gleich.id, benutzername: gleich.benutzername };
    }
  }
  const neu = await db
    .insertInto('benutzer')
    .values({
      benutzername: gleich ? `oidc:${sub}` : name,
      login: 'oidc',
      oidc_sub: sub,
      oidc_issuer: issuer,
    })
    .returning(['id', 'benutzername'])
    .executeTakeFirstOrThrow();
  return neu;
}
