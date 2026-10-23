// Selbstverwaltung des Mandanten (Kern seit 2026-10-24, vorher ee): Mandanten-Tokens (Quelle A),
// Positivliste der Anthropic-Orgs, Rollen und die Konten mit Rolle. Zugriff wie die übrige
// Mandantenverwaltung (`verwalteterMandant`): Mandanten-Admin, über ee auch Plattform-Admin; `?mandant=<id>`.
//   GET/POST /api/v1/mandant/tokens, DELETE …/tokens/:tokenId
//   GET/POST /api/v1/mandant/anthropic-orgs, DELETE …/anthropic-orgs/:org
//   GET/POST /api/v1/mandant/rollen, DELETE …/rollen/:rolleId
//   GET      /api/v1/mandant/benutzer
import { ROLLEN } from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { protokolliere } from '../audit/protokoll.js';
import { requireAnmeldung } from '../auth/kontext.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import { tokenErzeugen } from '../ingest-gemeinsam/zugang.js';
import {
  kontingentFehler,
  ungueltig,
  verwalteterMandant,
  verwaltung,
  VERWALTUNG_AUDIT,
} from './verwaltung.js';

type Trx = Transaction<Datenbank>;

const PLAENE = ['team', 'enterprise', 'max_pilot'] as const;

export const orgSchema = z.strictObject({
  org_uuid: z.uuid('Org-ID muss eine UUID sein'),
  bezeichnung: z.string().trim().max(200).optional(),
  plan: z.enum(PLAENE).optional(),
});

export const rolleZuweisenSchema = z
  .strictObject({
    benutzer_id: z.uuid().optional(),
    benutzername: z.string().trim().min(1).max(200).optional(),
    rolle: z.enum(ROLLEN),
    projekt_ids: z.array(z.uuid()).nullable().optional(),
  })
  .refine((e) => (e.benutzer_id === undefined) !== (e.benutzername === undefined), {
    message: 'Genau eines von benutzer_id oder benutzername angeben',
  });

/** Mandanten-Tokens des Mandanten der Transaktion (nur Präfix), neueste zuerst. */
export async function tokenListe(trx: Trx) {
  return trx
    .selectFrom('ingest_token')
    .select(['id', 'typ', 'praefix', 'erstellt', 'zuletzt_genutzt', 'widerrufen'])
    .where('typ', '=', 'mandant')
    .orderBy('erstellt', 'desc')
    .execute();
}

/** Positivliste der Anthropic-Orgs des Mandanten der Transaktion. */
export async function orgListe(trx: Trx) {
  return trx
    .selectFrom('anthropic_org')
    .select(['org_uuid', 'bezeichnung', 'plan', 'gueltig_ab'])
    .orderBy('gueltig_ab')
    .execute();
}

/** Rollen im Mandanten der Transaktion mit Anmeldenamen. */
export async function rollenListe(trx: Trx) {
  return trx
    .selectFrom('rolle as r')
    .innerJoin('benutzer as b', 'b.id', 'r.benutzer_id')
    .select(['r.id', 'r.benutzer_id', 'b.benutzername', 'r.rolle', 'r.projekt_ids', 'r.quelle'])
    .orderBy('b.benutzername')
    .execute();
}

/** Aktives Konto per ID oder Anmeldename (Eigentümer-Verbindung, nur ID und Name). */
export async function benutzerSuchen(db: Db, e: { benutzer_id?: string; benutzername?: string }) {
  let q = db.selectFrom('benutzer').select(['id', 'benutzername']).where('deaktiviert', 'is', null);
  q = e.benutzer_id
    ? q.where('id', '=', e.benutzer_id)
    : q.where('benutzername', '=', e.benutzername ?? '');
  return q.executeTakeFirst();
}

const UUID = /^[0-9a-f-]{36}$/i;

export function registriereVerwaltungRouten(app: FastifyInstance, db: Db): void {
  const opt = { preHandler: requireAnmeldung };
  const v = verwaltung(app.seatmeterAuth);

  // Mandanten-Tokens (Quelle A): Liste, neu (Klartext nur einmal), widerrufen.
  app.get('/api/v1/mandant/tokens', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    return { tokens: await withMandant(db, m.id, tokenListe) };
  });

  app.post('/api/v1/mandant/tokens', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const token = tokenErzeugen('mandant');
    const benutzerId = request.benutzer!.benutzerId;
    const zeile = await withMandant(db, m.id, async (trx) => {
      const z = await trx
        .insertInto('ingest_token')
        .values({
          mandant_id: m.id,
          typ: 'mandant',
          rechner_id: null,
          token_sha256: token.sha256,
          praefix: token.praefix,
        })
        .returning(['id', 'praefix', 'erstellt'])
        .executeTakeFirstOrThrow();
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.tokenErzeugt,
        objekt: `token:${token.praefix}`,
      });
      return z;
    });
    return reply.code(201).send({ ...zeile, token: token.klartext });
  });

  app.delete('/api/v1/mandant/tokens/:tokenId', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const tokenId = (request.params as { tokenId?: string }).tokenId ?? '';
    if (!UUID.test(tokenId)) return reply.code(400).send({ fehler: 'ungültige Token-ID' });
    const benutzerId = request.benutzer!.benutzerId;
    const ok = await withMandant(db, m.id, async (trx) => {
      const z = await trx
        .updateTable('ingest_token')
        .set({ widerrufen: new Date() })
        .where('id', '=', tokenId)
        .where('typ', '=', 'mandant')
        .where('widerrufen', 'is', null)
        .returning('praefix')
        .executeTakeFirst();
      if (z)
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.tokenWiderrufen,
          objekt: `token:${z.praefix}`,
        });
      return Boolean(z);
    });
    return ok ? reply.code(204).send() : reply.code(404).send({ fehler: 'Token nicht gefunden' });
  });

  // Positivliste der Anthropic-Orgs (Abo-Filter, Architektur §4).
  app.get('/api/v1/mandant/anthropic-orgs', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    return { orgs: await withMandant(db, m.id, orgListe) };
  });

  app.post('/api/v1/mandant/anthropic-orgs', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const e = orgSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const benutzerId = request.benutzer!.benutzerId;
    const neu = await withMandant(db, m.id, async (trx) => {
      const r = await trx
        .insertInto('anthropic_org')
        .values({
          mandant_id: m.id,
          org_uuid: e.data.org_uuid.toLowerCase(),
          bezeichnung: e.data.bezeichnung ?? null,
          plan: e.data.plan ?? null,
        })
        .onConflict((oc) => oc.columns(['mandant_id', 'org_uuid']).doNothing())
        .returning('org_uuid')
        .executeTakeFirst();
      if (r)
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.orgHinzugefuegt,
          objekt: `org:${r.org_uuid}`,
        });
      return Boolean(r);
    });
    return reply.code(neu ? 201 : 200).send({ org_uuid: e.data.org_uuid.toLowerCase(), neu });
  });

  app.delete('/api/v1/mandant/anthropic-orgs/:org', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const org = ((request.params as { org?: string }).org ?? '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(org)) return reply.code(400).send({ fehler: 'ungültige Org-ID' });
    const benutzerId = request.benutzer!.benutzerId;
    const ok = await withMandant(db, m.id, async (trx) => {
      const r = await trx
        .deleteFrom('anthropic_org')
        .where('org_uuid', '=', org)
        .executeTakeFirst();
      const n = Number(r.numDeletedRows);
      if (n > 0)
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.orgEntfernt,
          objekt: `org:${org}`,
        });
      return n > 0;
    });
    return ok ? reply.code(204).send() : reply.code(404).send({ fehler: 'Org nicht gefunden' });
  });

  // Rollen je Mandant; die erste Rolle eines Kontos belegt einen Platz im Kontenkontingent (ee).
  app.get('/api/v1/mandant/rollen', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    return { rollen: await withMandant(db, m.id, rollenListe) };
  });

  app.post('/api/v1/mandant/rollen', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const e = rolleZuweisenSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const ziel = await benutzerSuchen(db, e.data);
    if (!ziel) return reply.code(404).send({ fehler: 'Benutzer nicht gefunden' });
    const benutzerId = request.benutzer!.benutzerId;
    const projektIds = e.data.rolle === 'projektleiter' ? (e.data.projekt_ids ?? []) : null;
    const zeile = await withMandant(db, m.id, async (trx) => {
      const voll = await v.kontingentPruefen(trx, ziel.id);
      if (voll) return { art: 'voll' as const, stand: voll };
      const z = await trx
        .insertInto('rolle')
        .values({
          mandant_id: m.id,
          benutzer_id: ziel.id,
          rolle: e.data.rolle,
          projekt_ids: projektIds,
          quelle: 'manuell',
        })
        .onConflict((oc) =>
          oc
            .columns(['mandant_id', 'benutzer_id', 'rolle'])
            .doUpdateSet({ projekt_ids: projektIds, quelle: 'manuell' }),
        )
        .returning(['id', 'rolle', 'projekt_ids', 'quelle'])
        .executeTakeFirstOrThrow();
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.rolleZugewiesen,
        objekt: `benutzer:${ziel.id} rolle:${e.data.rolle}`,
      });
      return z;
    });
    if ('art' in zeile) return reply.code(409).send(kontingentFehler(zeile.stand));
    return reply
      .code(201)
      .send({ ...zeile, benutzer_id: ziel.id, benutzername: ziel.benutzername });
  });

  app.delete('/api/v1/mandant/rollen/:rolleId', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const rolleId = (request.params as { rolleId?: string }).rolleId ?? '';
    if (!UUID.test(rolleId)) return reply.code(400).send({ fehler: 'ungültige Rollen-ID' });
    const benutzerId = request.benutzer!.benutzerId;
    const ok = await withMandant(db, m.id, async (trx) => {
      const z = await trx
        .deleteFrom('rolle')
        .where('id', '=', rolleId)
        .returning(['benutzer_id', 'rolle'])
        .executeTakeFirst();
      if (z)
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.rolleEntzogen,
          objekt: `benutzer:${z.benutzer_id} rolle:${z.rolle}`,
        });
      return Boolean(z);
    });
    return ok ? reply.code(204).send() : reply.code(404).send({ fehler: 'Rolle nicht gefunden' });
  });

  // Konten mit Rolle im Mandanten (ohne Passwort-Hash); `plattform_admin` aus der Verwaltung (ee).
  app.get('/api/v1/mandant/benutzer', opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const ids = (
      await withMandant(db, m.id, (trx) => trx.selectFrom('rolle').select('benutzer_id').execute())
    ).map((z) => z.benutzer_id);
    if (ids.length === 0) return { benutzer: [] };
    const admins = await v.plattformAdmins();
    const zeilen = await db
      .selectFrom('benutzer')
      .select(['id', 'benutzername', 'login', 'erstellt', 'deaktiviert'])
      .where('id', 'in', ids)
      .orderBy('benutzername')
      .execute();
    return { benutzer: zeilen.map((z) => ({ ...z, plattform_admin: admins.has(z.id) })) };
  });
}
