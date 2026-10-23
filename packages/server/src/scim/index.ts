// Modul scim (Kern seit 2026-10-24, vorher ee): SCIM 2.0 je Mandant unter /scim/v2 (`routen.ts`) und die
// Verwaltung der Bearer-Tokens je Mandant für die Seite „SSO und Konten“:
//   GET/POST /api/v1/mandant/scim-tokens, DELETE …/scim-tokens/:tokenId (`?mandant=<id>` wie in der Verwaltung)
import { protokolliere } from '../audit/protokoll.js';
import { requireAnmeldung } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { zufallsToken, sha256 } from '../krypto.js';
import { sql } from 'kysely';
import { verwalteterMandant, VERWALTUNG_AUDIT } from '../mandant/verwaltung.js';
import type { SeatmeterPlugin } from '../plugin.js';
import { registriereScimRouten } from './routen.js';

const TOKEN_SPALTEN = [
  'id',
  'praefix',
  'bezeichnung',
  'erstellt',
  'zuletzt_genutzt',
  'widerrufen',
] as const;

export const scimPlugin: SeatmeterPlugin = {
  name: 'kern-scim',

  routen(app, { db, konfiguration }) {
    registriereScimRouten(app, db, konfiguration);
    const basis = '/api/v1/mandant/scim-tokens';
    const opt = { preHandler: requireAnmeldung };
    const basisUrl = konfiguration.SEATMETER_PUBLIC_URL
      ? new URL('/scim/v2', konfiguration.SEATMETER_PUBLIC_URL).toString()
      : null;

    app.get(basis, opt, async (request, reply) => {
      const m = await verwalteterMandant(request, reply);
      if (!m) return reply;
      return withMandant(db, m.id, async (trx) => {
        const tokens = await trx
          .selectFrom('mandant_scim_token')
          .select([...TOKEN_SPALTEN])
          .orderBy('erstellt', 'desc')
          .execute();
        const konten = await trx
          .selectFrom('scim_konto')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow();
        const gruppen = await trx
          .selectFrom('mandant_scim_gruppe')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow();
        const letzte = tokens
          .map((t) => t.zuletzt_genutzt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
        return {
          tokens,
          basis_url: basisUrl,
          konten_synchronisiert: Number(konten.n),
          gruppen_synchronisiert: Number(gruppen.n),
          letzte_synchronisation: letzte ?? null,
        };
      });
    });

    app.post(basis, opt, async (request, reply) => {
      const m = await verwalteterMandant(request, reply);
      if (!m) return reply;
      const roh = (request.body ?? {}) as { bezeichnung?: unknown };
      const bezeichnung =
        typeof roh.bezeichnung === 'string' && roh.bezeichnung.trim()
          ? roh.bezeichnung.trim().slice(0, 100)
          : null;
      const klartext = `sms_${zufallsToken(32)}`;
      const praefix = klartext.slice(0, 12);
      const benutzerId = request.benutzer!.benutzerId;
      const zeile = await withMandant(db, m.id, async (trx) => {
        const z = await trx
          .insertInto('mandant_scim_token')
          .values({
            mandant_id: sql<string>`app_mandant_id()`,
            token_sha256: sha256(klartext),
            praefix,
            bezeichnung,
          })
          .returning([...TOKEN_SPALTEN])
          .executeTakeFirstOrThrow();
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.scimTokenErzeugt,
          objekt: `scim-token:${praefix}`,
        });
        return z;
      });
      // Klartext nur in dieser Antwort.
      return reply.code(201).send({ ...zeile, token: klartext });
    });

    app.delete(`${basis}/:tokenId`, opt, async (request, reply) => {
      const m = await verwalteterMandant(request, reply);
      if (!m) return reply;
      const tokenId = (request.params as { tokenId?: string }).tokenId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(tokenId))
        return reply.code(400).send({ fehler: 'ungültige Token-ID' });
      const benutzerId = request.benutzer!.benutzerId;
      const ok = await withMandant(db, m.id, async (trx) => {
        const z = await trx
          .updateTable('mandant_scim_token')
          .set({ widerrufen: new Date() })
          .where('id', '=', tokenId)
          .where('widerrufen', 'is', null)
          .returning('praefix')
          .executeTakeFirst();
        if (z)
          await protokolliere(trx, {
            benutzerId,
            aktion: VERWALTUNG_AUDIT.scimTokenWiderrufen,
            objekt: `scim-token:${z.praefix}`,
          });
        return Boolean(z);
      });
      return ok ? reply.code(204).send() : reply.code(404).send({ fehler: 'Token nicht gefunden' });
    });
  },
};
