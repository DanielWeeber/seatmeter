// Routen der OIDC-Konfiguration je Mandant (Mandanten-Admin, über ee auch Plattform-Admin; `?mandant=<id>`):
//   GET/PUT/DELETE /api/v1/mandant/oidc, POST …/oidc/pruefen (Discovery, ohne Anmeldung).
// Das Client-Secret steht nur verschlüsselt in der Datenbank und nie in einer Antwort.
import { protokolliere } from '../audit/protokoll.js';
import { requireAnmeldung } from '../auth/kontext.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { verschluessele } from '../krypto.js';
import { ROLLEN } from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ungueltig,
  verwalteterMandant,
  verwaltung,
  VERWALTUNG_AUDIT,
} from '../mandant/verwaltung.js';
import { scimAlleRollenAbgleichen } from '../scim/rollen.js';
import {
  entdecken,
  issuerErlaubt,
  mandantOidcLaden,
  SECRET_AAD,
  type DiscoveryCache,
} from './mandant.js';

type Trx = Parameters<Parameters<typeof withMandant>[2]>[0];

const rolle = z.enum(ROLLEN);

export const oidcKonfigSchema = z.strictObject({
  issuer: z
    .string()
    .trim()
    .max(500)
    .refine(issuerErlaubt, 'Issuer-URL mit https:// erwartet (ohne Query, ohne Zugangsdaten)')
    .transform((u) => u.replace(/\/+$/, '')),
  client_id: z.string().trim().min(1, 'Client-ID fehlt').max(200),
  client_secret: z.string().min(1).max(500).optional(),
  scopes: z
    .string()
    .trim()
    .max(300)
    .refine((s) => s.split(/\s+/).includes('openid'), 'Scopes müssen „openid“ enthalten')
    .default('openid profile email groups'),
  bezeichnung: z.string().trim().min(1, 'Bezeichnung fehlt').max(60),
  gruppen_rollen: z
    .record(
      z.string().trim().min(1).max(200),
      z
        .union([rolle, z.array(rolle).max(ROLLEN.length)])
        .transform((r) => [...new Set(Array.isArray(r) ? r : [r])]),
    )
    .refine((g) => Object.keys(g).length <= 200, 'Höchstens 200 Gruppen')
    .default({}),
  aktiv: z.boolean().default(true),
});

const SPALTEN = [
  'issuer',
  'client_id',
  'scopes',
  'bezeichnung',
  'gruppen_rollen',
  'aktiv',
  'erstellt',
  'geaendert',
  'zuletzt_geprueft',
] as const;

async function ausgabe(trx: Trx) {
  const k = await trx
    .selectFrom('mandant_oidc')
    .select([...SPALTEN])
    .executeTakeFirst();
  return k ? { ...k, client_secret_gesetzt: true as const } : null;
}

export function registriereKonfigurationRouten(
  app: FastifyInstance,
  db: Db,
  angaben: {
    masterKey: Buffer;
    redirectUri: string | null;
    startPfad: string;
    cache: DiscoveryCache;
  },
): void {
  const basis = '/api/v1/mandant/oidc';
  const v = verwaltung(app.seatmeterAuth);
  const opt = { preHandler: requireAnmeldung };
  const startUrl = async (trx: Trx) => {
    const m = await trx.selectFrom('mandant').select('slug').executeTakeFirstOrThrow();
    return `${angaben.startPfad}?mandant=${encodeURIComponent(m.slug)}`;
  };

  app.get(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    return withMandant(db, m.id, async (trx) => ({
      konfiguration: await ausgabe(trx),
      redirect_uri: angaben.redirectUri,
      start_url: await startUrl(trx),
    }));
  });

  app.put(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const e = oidcKonfigSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const benutzerId = request.benutzer!.benutzerId;
    const ergebnis = await withMandant(db, m.id, async (trx) => {
      const alt = await trx.selectFrom('mandant_oidc').selectAll().executeTakeFirst();
      if (!alt && !e.data.client_secret) return null;
      const werte = {
        issuer: e.data.issuer,
        client_id: e.data.client_id,
        scopes: e.data.scopes,
        bezeichnung: e.data.bezeichnung,
        gruppen_rollen: JSON.stringify(e.data.gruppen_rollen),
        aktiv: e.data.aktiv,
        geaendert: new Date(),
        ...(e.data.client_secret
          ? {
              client_secret: verschluessele(angaben.masterKey, e.data.client_secret, SECRET_AAD),
            }
          : {}),
      };
      if (alt) {
        await trx.updateTable('mandant_oidc').set(werte).execute();
      } else {
        await trx
          .insertInto('mandant_oidc')
          .values({
            mandant_id: m.id,
            ...werte,
            client_secret: verschluessele(
              angaben.masterKey,
              e.data.client_secret ?? '',
              SECRET_AAD,
            ),
          })
          .execute();
      }
      // Audit nennt nur geänderte Felder, nie Werte des Secrets.
      const felder = alt
        ? (['issuer', 'client_id', 'scopes', 'bezeichnung', 'aktiv'] as const).filter(
            (f) => String(alt[f]) !== String(e.data[f]),
          )
        : ['neu'];
      if (alt && JSON.stringify(alt.gruppen_rollen) !== JSON.stringify(e.data.gruppen_rollen))
        felder.push('gruppen_rollen');
      if (alt && e.data.client_secret) felder.push('client_secret');
      // Geänderte Gruppen-Zuordnung gilt auch für SCIM-Gruppen: SCIM-Rollen sofort neu.
      if (!alt || felder.includes('gruppen_rollen')) await scimAlleRollenAbgleichen(v, trx);
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.oidcGeaendert,
        objekt: `mandant_oidc: ${felder.join(', ') || 'unverändert'}`,
      });
      return {
        konfiguration: await ausgabe(trx),
        redirect_uri: angaben.redirectUri,
        start_url: await startUrl(trx),
      };
    });
    if (!ergebnis)
      return reply.code(400).send({
        fehler: 'Beim ersten Speichern ist das Client-Secret Pflicht.',
        code: 'client_secret_fehlt',
      });
    angaben.cache.vergessen(m.id);
    return ergebnis;
  });

  app.delete(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const benutzerId = request.benutzer!.benutzerId;
    const ok = await withMandant(db, m.id, async (trx) => {
      const r = await trx.deleteFrom('mandant_oidc').executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) return false;
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.oidcEntfernt,
        objekt: 'mandant_oidc',
      });
      await scimAlleRollenAbgleichen(v, trx);
      return true;
    });
    angaben.cache.vergessen(m.id);
    return ok
      ? reply.code(204).send()
      : reply.code(404).send({ fehler: 'Keine OIDC-Konfiguration' });
  });

  // Prüft Discovery (Endpunkte) mit den gespeicherten Angaben, ohne Anmeldung.
  app.post(`${basis}/pruefen`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const k = await mandantOidcLaden(db, angaben.masterKey, m.id);
    if (!k) return reply.code(404).send({ fehler: 'Keine OIDC-Konfiguration' });
    let ergebnis: {
      ok: boolean;
      fehler: string | null;
      issuer: string | null;
      endpunkte: Record<string, string | null> | null;
    };
    try {
      const meta = (await entdecken(k, 8)).serverMetadata();
      ergebnis = {
        ok: true,
        fehler: null,
        issuer: meta.issuer,
        endpunkte: {
          authorization: meta.authorization_endpoint ?? null,
          token: meta.token_endpoint ?? null,
          userinfo: meta.userinfo_endpoint ?? null,
          end_session: meta.end_session_endpoint ?? null,
        },
      };
      angaben.cache.vergessen(m.id);
    } catch (e) {
      const art = e instanceof Error ? e.name : 'unbekannt';
      request.log.warn({ fehler: art }, 'OIDC-Prüfung des Mandanten fehlgeschlagen');
      ergebnis = {
        ok: false,
        fehler: `Discovery unter ${k.issuer}/.well-known/openid-configuration fehlgeschlagen (${art}).`,
        issuer: null,
        endpunkte: null,
      };
    }
    const geprueft = new Date();
    const benutzerId = request.benutzer!.benutzerId;
    await withMandant(db, m.id, async (trx) => {
      await trx.updateTable('mandant_oidc').set({ zuletzt_geprueft: geprueft }).execute();
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.oidcGeprueft,
        objekt: `mandant_oidc: ${ergebnis.ok ? 'ok' : 'fehlgeschlagen'}`,
      });
    });
    return { ...ergebnis, geprueft };
  });
}
