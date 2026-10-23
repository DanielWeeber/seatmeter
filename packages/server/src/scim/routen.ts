// SCIM 2.0 (RFC 7643/7644) unter /scim/v2 je Mandant, Anmeldung per Bearer-Token des Mandanten. Getestet mit
// Anfragefolgen wie Entra ID (POST Users, GET mit Filter, PATCH active "False", Gruppen-PATCH add members)
// und Okta (PUT Users, PATCH replace). Fehler im SCIM-Format, Content-Type application/scim+json.
import { protokolliere } from '../audit/protokoll.js';
import { rollenDesBenutzers } from '../auth/kontext.js';
import { Ratenbegrenzer } from '../auth/ratenbegrenzer.js';
import type { Konfiguration } from '../config.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { TokenEimer } from '../ingest-gemeinsam/ratenlimit.js';
import { sha256 } from '../krypto.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { kontoEntsperren, kontoSperren, rollenSetzen, type Trx } from '../konten/konten.js';
import { verwaltung, VERWALTUNG_AUDIT, type Verwaltung } from '../mandant/verwaltung.js';
import {
  alsBoolean,
  alsObjekt,
  alsText,
  liste,
  patchOperationen,
  ScimAbbruch,
  scimFehler,
  scimSenden,
} from './basis.js';
import { attribut, filterLesen, passt, pfadLesen, ScimFilterFehler } from './filter.js';
import {
  gruppeRessource,
  gruppenLaden,
  kontenLaden,
  mitgliedschaften,
  resourceTypes,
  schemas,
  serviceProviderConfig,
  userRessource,
} from './ressourcen.js';
import { scimRollenAbgleichen, zuordnungLaden } from './rollen.js';

/** Je Token 600 Anfragen pro Minute, Stoß 300 (Entra ID schickt Zyklen in Schüben). */
const TOKEN_GRENZE = { proMinute: 600, stoss: 300 } as const;

interface ScimKontext {
  mandantId: string;
  tokenId: string;
}

const listeSchema = z.object({
  filter: z.string().max(2000).optional(),
  startIndex: z.coerce.number().int().min(1).default(1),
  count: z.coerce.number().int().min(0).max(200).default(100),
  excludedAttributes: z.string().max(500).optional(),
  attributes: z.string().max(500).optional(),
});

const idSchema = z.uuid();

/** Konto mit Rollen in anderen Mandanten oder Plattform-Admin: nie global sperren oder umbenennen. */
async function mehrereMandanten(
  v: Verwaltung,
  db: Db,
  benutzerId: string,
  mandantId: string,
): Promise<boolean> {
  if (await v.istPlattformAdmin(benutzerId)) return true;
  return (await rollenDesBenutzers(db, benutzerId)).some((r) => r.mandant_id !== mandantId);
}

/**
 * Setzt `active` im Mandanten. Inaktiv: Konto ohne weitere Mandanten wird gesperrt (alle Sitzungen enden),
 * sonst verliert es nur seine Rollen und Sitzungen in diesem Mandanten. Aktiv: Sperre aufheben (Kontingent)
 * und SCIM-Rollen neu.
 */
async function aktivSetzen(
  v: Verwaltung,
  trx: Trx,
  benutzerId: string,
  aktiv: boolean,
  fremd: boolean,
) {
  await trx
    .updateTable('scim_konto')
    .set({ aktiv, geaendert: new Date() })
    .where('benutzer_id', '=', benutzerId)
    .execute();
  const b = await trx
    .selectFrom('benutzer')
    .select('deaktiviert')
    .where('id', '=', benutzerId)
    .executeTakeFirstOrThrow();
  if (!aktiv) {
    if (!fremd) {
      if (!b.deaktiviert) await kontoSperren(trx, benutzerId, null);
    } else {
      await rollenSetzen(trx, {
        benutzerId,
        soll: new Map(),
        quelle: 'scim',
        entziehen: 'alle',
        akteur: null,
        hinweis: 'SCIM: inaktiv',
      });
      await trx
        .deleteFrom('benutzer_sitzung')
        .where('benutzer_id', '=', benutzerId)
        .where('mandant_id', '=', sql<string>`app_mandant_id()`)
        .execute();
    }
  } else if (b.deaktiviert && !fremd) {
    const voll = await v.kontingentPruefen(trx, benutzerId);
    if (voll)
      throw new ScimAbbruch(
        409,
        `konten_kontingent: Das Kontenkontingent des Mandanten ist ausgeschöpft (${voll.belegt} von ${voll.max ?? '∞'} Konten).`,
        'tooMany',
      );
    await kontoEntsperren(trx, benutzerId, null);
  }
  await scimRollenAbgleichen(v, trx, benutzerId, await zuordnungLaden(trx));
}

interface UserAenderung {
  userName?: string;
  externalId?: string | null;
  active?: boolean;
}

/** Wendet userName/externalId/active an (PUT, PATCH); Konto muss sichtbar sein. */
async function userAendern(
  v: Verwaltung,
  trx: Trx,
  id: string,
  aenderung: UserAenderung,
  fremd: boolean,
) {
  const [k] = await kontenLaden(trx, id);
  if (!k) throw new ScimAbbruch(404, 'User nicht gefunden');
  // Konten mit Rolle, aber ohne SCIM-Verknüpfung übernimmt SCIM beim ersten Schreiben.
  await trx
    .insertInto('scim_konto')
    .values({ mandant_id: sql<string>`app_mandant_id()`, benutzer_id: id })
    .onConflict((oc) => oc.columns(['mandant_id', 'benutzer_id']).doNothing())
    .execute();
  if (aenderung.userName !== undefined && aenderung.userName !== k.benutzername) {
    if (fremd)
      throw new ScimAbbruch(
        400,
        'userName eines Kontos mit weiteren Mandanten ist nicht änderbar',
        'mutability',
      );
    const belegt = await trx
      .selectFrom('benutzer')
      .select('id')
      .where('benutzername', '=', aenderung.userName)
      .executeTakeFirst();
    if (belegt) throw new ScimAbbruch(409, 'userName ist schon vergeben', 'uniqueness');
    await trx
      .updateTable('benutzer')
      .set({ benutzername: aenderung.userName })
      .where('id', '=', id)
      .execute();
  }
  if (aenderung.externalId !== undefined && aenderung.externalId !== k.external_id) {
    if (aenderung.externalId !== null) {
      const belegt = await trx
        .selectFrom('scim_konto')
        .select('benutzer_id')
        .where('external_id', '=', aenderung.externalId)
        .where('benutzer_id', '<>', id)
        .executeTakeFirst();
      if (belegt) throw new ScimAbbruch(409, 'externalId ist schon vergeben', 'uniqueness');
    }
    await trx
      .updateTable('scim_konto')
      .set({ external_id: aenderung.externalId, geaendert: new Date() })
      .where('benutzer_id', '=', id)
      .execute();
  }
  if (aenderung.active !== undefined) await aktivSetzen(v, trx, id, aenderung.active, fremd);
  else await scimRollenAbgleichen(v, trx, id, await zuordnungLaden(trx));
}

/** Mitglieder aus `[{ value: "<id>" }, …]`. */
function mitgliederAus(wert: unknown): string[] {
  if (wert === undefined || wert === null) return [];
  const liste = Array.isArray(wert) ? wert : [wert];
  return liste.map((m) => {
    const v = attribut(m, 'value');
    if (typeof v !== 'string' || !idSchema.safeParse(v).success)
      throw new ScimAbbruch(400, 'members[].value muss eine User-ID sein', 'invalidValue');
    return v;
  });
}

export function registriereScimRouten(
  app: FastifyInstance,
  db: Db,
  konfiguration: Konfiguration,
): void {
  const kontexte = new WeakMap<FastifyRequest, ScimKontext>();
  const v = verwaltung(app.seatmeterAuth);
  const eimer = new TokenEimer();
  const fehlversuche = new Ratenbegrenzer(30, 15 * 60_000);
  const zuletztGeschrieben = new Map<string, number>();

  const basisUrl = (request: FastifyRequest) =>
    konfiguration.SEATMETER_PUBLIC_URL
      ? new URL('/scim/v2', konfiguration.SEATMETER_PUBLIC_URL).toString()
      : `${request.protocol}://${request.host}/scim/v2`;

  async function anmelden(request: FastifyRequest, reply: FastifyReply) {
    const ip = request.ip || 'unbekannt';
    if (fehlversuche.gesperrt(ip)) {
      void reply.header('retry-after', '900');
      return scimFehler(reply, 429, 'Zu viele Fehlversuche');
    }
    const kopf = request.headers.authorization ?? '';
    const t = /^Bearer\s+(\S{20,300})$/i.exec(kopf)?.[1];
    const zeile = t
      ? await db
          .selectFrom('mandant_scim_token')
          .select(['id', 'mandant_id'])
          .where('token_sha256', '=', sha256(t))
          .where('widerrufen', 'is', null)
          .executeTakeFirst()
      : undefined;
    if (!zeile) {
      fehlversuche.fehlschlag(ip);
      return scimFehler(reply, 401, 'Bearer-Token fehlt, ist unbekannt oder widerrufen');
    }
    const warten = eimer.pruefen(zeile.id, TOKEN_GRENZE);
    if (warten > 0) {
      void reply.header('retry-after', String(warten));
      return scimFehler(reply, 429, 'Zu viele Anfragen für dieses Token');
    }
    kontexte.set(request, { mandantId: zeile.mandant_id, tokenId: zeile.id });
    const jetzt = Date.now();
    if ((zuletztGeschrieben.get(zeile.id) ?? 0) < jetzt - 60_000) {
      zuletztGeschrieben.set(zeile.id, jetzt);
      await withMandant(db, zeile.mandant_id, (trx) =>
        trx
          .updateTable('mandant_scim_token')
          .set({ zuletzt_genutzt: new Date(jetzt) })
          .where('id', '=', zeile.id)
          .execute(),
      );
    }
    return undefined;
  }

  type Handler = (
    request: FastifyRequest,
    reply: FastifyReply,
    k: ScimKontext,
    basis: string,
  ) => Promise<unknown>;

  const sicher =
    (fn: Handler) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const k = kontexte.get(request);
      if (!k) return scimFehler(reply, 401, 'nicht angemeldet');
      try {
        return await fn(request, reply, k, basisUrl(request));
      } catch (e) {
        if (e instanceof ScimAbbruch) return scimFehler(reply, e.status, e.detail, e.scimType);
        if (e instanceof ScimFilterFehler)
          return scimFehler(reply, 400, e.message, 'invalidFilter');
        if (e && typeof e === 'object' && 'code' in e && e.code === '23505')
          return scimFehler(reply, 409, 'Wert ist schon vergeben', 'uniqueness');
        throw e;
      }
    };

  function idAus(request: FastifyRequest): string {
    const id = (request.params as { id?: string }).id ?? '';
    if (!idSchema.safeParse(id).success) throw new ScimAbbruch(404, 'Ressource nicht gefunden');
    return id;
  }

  async function userLesen(trx: Trx, id: string, basis: string) {
    const [k] = await kontenLaden(trx, id);
    if (!k) throw new ScimAbbruch(404, 'User nicht gefunden');
    const alle = await gruppenLaden(trx);
    const eigene = new Set(
      (await mitgliedschaften(trx)).filter((m) => m.benutzer_id === id).map((m) => m.gruppe_id),
    );
    return userRessource(
      k,
      basis,
      alle.filter((g) => eigene.has(g.id)),
    );
  }

  async function gruppeLesen(trx: Trx, id: string, basis: string, mitMitgliedern = true) {
    const [g] = await gruppenLaden(trx, id);
    if (!g) throw new ScimAbbruch(404, 'Group nicht gefunden');
    const mg = mitMitgliedern
      ? (await mitgliedschaften(trx)).filter((m) => m.gruppe_id === id)
      : null;
    return gruppeRessource(g, basis, mg);
  }

  /** Setzt Mitglieder einer Gruppe; unbekannte IDs werden übersprungen. Liefert betroffene Konten. */
  async function mitgliederAendern(
    trx: Trx,
    gruppeId: string,
    art: 'add' | 'remove' | 'replace',
    ids: string[] | null,
  ): Promise<Set<string>> {
    const vorher = new Set(
      (
        await trx
          .selectFrom('mandant_scim_mitglied')
          .select('benutzer_id')
          .where('gruppe_id', '=', gruppeId)
          .execute()
      ).map((z) => z.benutzer_id),
    );
    const sichtbar = new Set((await kontenLaden(trx)).map((k) => k.id));
    const gueltig = (ids ?? []).filter((id) => sichtbar.has(id));
    const betroffen = new Set<string>();
    if (art === 'replace' || (art === 'remove' && ids === null)) {
      const soll = new Set(art === 'replace' ? gueltig : []);
      for (const id of vorher) {
        if (soll.has(id)) continue;
        await trx
          .deleteFrom('mandant_scim_mitglied')
          .where('gruppe_id', '=', gruppeId)
          .where('benutzer_id', '=', id)
          .execute();
        betroffen.add(id);
      }
      if (art === 'remove') return betroffen;
    }
    if (art === 'remove') {
      for (const id of gueltig) {
        if (!vorher.has(id)) continue;
        await trx
          .deleteFrom('mandant_scim_mitglied')
          .where('gruppe_id', '=', gruppeId)
          .where('benutzer_id', '=', id)
          .execute();
        betroffen.add(id);
      }
      return betroffen;
    }
    for (const id of gueltig) {
      if (vorher.has(id)) continue;
      await trx
        .insertInto('mandant_scim_mitglied')
        .values({ mandant_id: sql<string>`app_mandant_id()`, gruppe_id: gruppeId, benutzer_id: id })
        .onConflict((oc) => oc.columns(['gruppe_id', 'benutzer_id']).doNothing())
        .execute();
      betroffen.add(id);
    }
    return betroffen;
  }

  async function nameFrei(trx: Trx, name: string, ausser?: string) {
    let q = trx
      .selectFrom('mandant_scim_gruppe')
      .select('id')
      .where(sql<boolean>`lower(display_name) = lower(${name})`);
    if (ausser) q = q.where('id', '<>', ausser);
    if (await q.executeTakeFirst())
      throw new ScimAbbruch(409, 'displayName ist schon vergeben', 'uniqueness');
  }

  async function rollenNeu(trx: Trx, konten: Iterable<string>) {
    const zuordnung = await zuordnungLaden(trx);
    for (const id of konten) await scimRollenAbgleichen(v, trx, id, zuordnung);
  }

  async function alleMitglieder(trx: Trx, gruppeId: string): Promise<string[]> {
    return (
      await trx
        .selectFrom('mandant_scim_mitglied')
        .select('benutzer_id')
        .where('gruppe_id', '=', gruppeId)
        .execute()
    ).map((z) => z.benutzer_id);
  }

  void app.register(async (scim) => {
    scim.addContentTypeParser(
      'application/scim+json',
      { parseAs: 'string' },
      (_request, body, fertig) => {
        try {
          fertig(null, body === '' ? {} : JSON.parse(String(body)));
        } catch {
          const fehler = new Error('Ungültiges JSON') as Error & { statusCode: number };
          fehler.statusCode = 400;
          fertig(fehler, undefined);
        }
      },
    );
    scim.addHook('preHandler', anmelden);
    const P = '/scim/v2';

    scim.get(
      `${P}/ServiceProviderConfig`,
      sicher(async (_q, reply, _k, basis) => scimSenden(reply, 200, serviceProviderConfig(basis))),
    );
    scim.get(
      `${P}/ResourceTypes`,
      sicher(async (_q, reply, _k, basis) => {
        const r = resourceTypes(basis);
        return scimSenden(reply, 200, liste(r, 1, r.length));
      }),
    );
    scim.get(
      `${P}/Schemas`,
      sicher(async (_q, reply, _k, basis) => {
        const r = schemas(basis);
        return scimSenden(reply, 200, liste(r, 1, r.length));
      }),
    );

    // ---------------------------------------------------------------------------------- Users
    scim.get(
      `${P}/Users`,
      sicher(async (request, reply, k, basis) => {
        const q = listeSchema.safeParse(request.query);
        if (!q.success) throw new ScimAbbruch(400, 'Ungültige Abfrage', 'invalidValue');
        const f = q.data.filter ? filterLesen(q.data.filter) : null;
        const ressourcen = await withMandant(db, k.mandantId, async (trx) => {
          const konten = await kontenLaden(trx);
          const gruppen = new Map((await gruppenLaden(trx)).map((g) => [g.id, g] as const));
          const mg = await mitgliedschaften(trx);
          return konten.map((konto) =>
            userRessource(
              konto,
              basis,
              mg
                .filter((m) => m.benutzer_id === konto.id)
                .flatMap((m) => {
                  const g = gruppen.get(m.gruppe_id);
                  return g ? [g] : [];
                }),
            ),
          );
        });
        const treffer = f ? ressourcen.filter((r) => passt(f, r)) : ressourcen;
        return scimSenden(reply, 200, liste(treffer, q.data.startIndex, q.data.count));
      }),
    );

    scim.get(
      `${P}/Users/:id`,
      sicher(async (request, reply, k, basis) => {
        const id = idAus(request);
        const r = await withMandant(db, k.mandantId, (trx) => userLesen(trx, id, basis));
        return scimSenden(reply, 200, r);
      }),
    );

    scim.post(
      `${P}/Users`,
      sicher(async (request, reply, k, basis) => {
        const body = alsObjekt(request.body);
        const userName = alsText(body.userName, 'userName').toLowerCase();
        const externalId =
          body.externalId === undefined || body.externalId === null
            ? null
            : alsText(body.externalId, 'externalId');
        const aktiv = body.active === undefined ? true : alsBoolean(body.active);
        const vorhanden = await db
          .selectFrom('benutzer')
          .select('id')
          .where('benutzername', '=', userName)
          .executeTakeFirst();
        const fremd = vorhanden ? await mehrereMandanten(v, db, vorhanden.id, k.mandantId) : false;
        const r = await withMandant(db, k.mandantId, async (trx) => {
          if (
            externalId &&
            (await trx
              .selectFrom('scim_konto')
              .select('benutzer_id')
              .where('external_id', '=', externalId)
              .executeTakeFirst())
          )
            throw new ScimAbbruch(409, 'externalId ist schon vergeben', 'uniqueness');
          if (vorhanden) {
            const schon = await trx
              .selectFrom('scim_konto')
              .select('benutzer_id')
              .where('benutzer_id', '=', vorhanden.id)
              .executeTakeFirst();
            if (schon) throw new ScimAbbruch(409, 'userName ist schon vergeben', 'uniqueness');
            if (fremd)
              throw new ScimAbbruch(
                409,
                'Das Konto gehört auch zu einem anderen Mandanten und kann nicht per SCIM verwaltet werden',
                'uniqueness',
              );
          }
          if (aktiv) {
            const voll = await v.kontingentPruefen(trx, vorhanden?.id ?? null);
            if (voll)
              throw new ScimAbbruch(
                409,
                `konten_kontingent: Das Kontenkontingent des Mandanten ist ausgeschöpft (${voll.belegt} von ${voll.max ?? '∞'} Konten).`,
                'tooMany',
              );
          }
          let id = vorhanden?.id;
          if (!id) {
            const neu = await trx
              .insertInto('benutzer')
              .values({ benutzername: userName, login: 'oidc' })
              .returning('id')
              .executeTakeFirstOrThrow();
            id = neu.id;
            await protokolliere(trx, {
              benutzerId: null,
              aktion: VERWALTUNG_AUDIT.kontoAngelegt,
              objekt: `benutzer:${id} (SCIM)`,
            });
          }
          await trx
            .insertInto('scim_konto')
            .values({
              mandant_id: sql<string>`app_mandant_id()`,
              benutzer_id: id,
              external_id: externalId,
              aktiv,
            })
            .execute();
          await aktivSetzen(v, trx, id, aktiv, fremd);
          return userLesen(trx, id, basis);
        });
        void reply.header('location', r.meta.location);
        return scimSenden(reply, 201, r);
      }),
    );

    scim.put(
      `${P}/Users/:id`,
      sicher(async (request, reply, k, basis) => {
        const id = idAus(request);
        const body = alsObjekt(request.body);
        const aenderung: UserAenderung = {
          userName: alsText(body.userName, 'userName').toLowerCase(),
          ...(body.externalId !== undefined
            ? {
                externalId:
                  body.externalId === null ? null : alsText(body.externalId, 'externalId'),
              }
            : {}),
          ...(body.active !== undefined ? { active: alsBoolean(body.active) } : {}),
        };
        const fremd = await mehrereMandanten(v, db, id, k.mandantId);
        const r = await withMandant(db, k.mandantId, async (trx) => {
          await userAendern(v, trx, id, aenderung, fremd);
          return userLesen(trx, id, basis);
        });
        return scimSenden(reply, 200, r);
      }),
    );

    scim.patch(
      `${P}/Users/:id`,
      sicher(async (request, reply, k, basis) => {
        const id = idAus(request);
        const aenderung: UserAenderung = {};
        const setze = (pfadText: string, wert: unknown, op: string, ohnePfad: boolean) => {
          let p;
          try {
            p = pfadLesen(pfadText);
          } catch (e) {
            if (ohnePfad) return; // unbekannte Schlüssel im Wertobjekt ignorieren
            throw new ScimAbbruch(400, (e as Error).message, 'invalidPath');
          }
          const a = p.attr.toLowerCase();
          if (a === 'username' && !p.filter && !p.sub) {
            if (op === 'remove') throw new ScimAbbruch(400, 'userName ist Pflicht', 'mutability');
            aenderung.userName = alsText(wert, 'userName').toLowerCase();
          } else if (a === 'externalid' && !p.filter) {
            aenderung.externalId = op === 'remove' ? null : alsText(wert, 'externalId');
          } else if (a === 'active' && !p.filter) {
            if (op !== 'remove') aenderung.active = alsBoolean(wert);
          }
          // Alle übrigen Attribute (Namen, E-Mails, Titel, Enterprise-Erweiterung) speichert seatmeter nicht.
        };
        for (const o of patchOperationen(request.body)) {
          if (o.path) setze(o.path, o.value, o.op, false);
          else {
            if (o.op === 'remove')
              throw new ScimAbbruch(400, 'remove braucht einen Pfad', 'noTarget');
            for (const [schluessel, wert] of Object.entries(alsObjekt(o.value)))
              setze(schluessel, wert, o.op, true);
          }
        }
        const fremd = await mehrereMandanten(v, db, id, k.mandantId);
        const r = await withMandant(db, k.mandantId, async (trx) => {
          await userAendern(v, trx, id, aenderung, fremd);
          return userLesen(trx, id, basis);
        });
        return scimSenden(reply, 200, r);
      }),
    );

    // DELETE = deprovisionieren: Rollen und Gruppen im Mandanten weg, Konto ohne weitere Mandanten gesperrt.
    scim.delete(
      `${P}/Users/:id`,
      sicher(async (request, reply, k) => {
        const id = idAus(request);
        const fremd = await mehrereMandanten(v, db, id, k.mandantId);
        await withMandant(db, k.mandantId, async (trx) => {
          const [konto] = await kontenLaden(trx, id);
          if (!konto) throw new ScimAbbruch(404, 'User nicht gefunden');
          await trx.deleteFrom('mandant_scim_mitglied').where('benutzer_id', '=', id).execute();
          await rollenSetzen(trx, {
            benutzerId: id,
            soll: new Map(),
            quelle: 'scim',
            entziehen: 'alle',
            akteur: null,
            hinweis: 'SCIM: gelöscht',
          });
          await trx.deleteFrom('scim_konto').where('benutzer_id', '=', id).execute();
          if (!fremd && !konto.deaktiviert) await kontoSperren(trx, id, null);
          if (fremd)
            await trx
              .deleteFrom('benutzer_sitzung')
              .where('benutzer_id', '=', id)
              .where('mandant_id', '=', sql<string>`app_mandant_id()`)
              .execute();
        });
        return reply.code(204).send();
      }),
    );

    // --------------------------------------------------------------------------------- Groups
    scim.get(
      `${P}/Groups`,
      sicher(async (request, reply, k, basis) => {
        const q = listeSchema.safeParse(request.query);
        if (!q.success) throw new ScimAbbruch(400, 'Ungültige Abfrage', 'invalidValue');
        const f = q.data.filter ? filterLesen(q.data.filter) : null;
        const ohneMitglieder = (q.data.excludedAttributes ?? '')
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .includes('members');
        const ressourcen = await withMandant(db, k.mandantId, async (trx) => {
          const mg = await mitgliedschaften(trx);
          return (await gruppenLaden(trx)).map((g) =>
            gruppeRessource(
              g,
              basis,
              mg.filter((m) => m.gruppe_id === g.id),
            ),
          );
        });
        const treffer = (f ? ressourcen.filter((r) => passt(f, r)) : ressourcen).map((r) => {
          if (!ohneMitglieder) return r;
          const { members: _m, ...rest } = r as typeof r & { members?: unknown };
          return rest;
        });
        return scimSenden(reply, 200, liste(treffer, q.data.startIndex, q.data.count));
      }),
    );

    scim.get(
      `${P}/Groups/:id`,
      sicher(async (request, reply, k, basis) => {
        const id = idAus(request);
        const ohne = String(
          (request.query as { excludedAttributes?: string }).excludedAttributes ?? '',
        )
          .toLowerCase()
          .includes('members');
        const r = await withMandant(db, k.mandantId, (trx) => gruppeLesen(trx, id, basis, !ohne));
        return scimSenden(reply, 200, r);
      }),
    );

    scim.post(
      `${P}/Groups`,
      sicher(async (request, reply, k, basis) => {
        const body = alsObjekt(request.body);
        const name = alsText(body.displayName, 'displayName');
        const externalId =
          body.externalId === undefined || body.externalId === null
            ? null
            : alsText(body.externalId, 'externalId');
        const mitglieder = mitgliederAus(body.members);
        const r = await withMandant(db, k.mandantId, async (trx) => {
          await nameFrei(trx, name);
          const g = await trx
            .insertInto('mandant_scim_gruppe')
            .values({
              mandant_id: sql<string>`app_mandant_id()`,
              display_name: name,
              external_id: externalId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const betroffen = await mitgliederAendern(trx, g.id, 'add', mitglieder);
          await rollenNeu(trx, betroffen);
          await protokolliere(trx, {
            benutzerId: null,
            aktion: VERWALTUNG_AUDIT.scimGruppe,
            objekt: `gruppe:${g.id} angelegt (${betroffen.size} Mitglieder)`,
          });
          return gruppeLesen(trx, g.id, basis);
        });
        void reply.header('location', r.meta.location);
        return scimSenden(reply, 201, r);
      }),
    );

    scim.put(
      `${P}/Groups/:id`,
      sicher(async (request, reply, k, basis) => {
        const id = idAus(request);
        const body = alsObjekt(request.body);
        const name = alsText(body.displayName, 'displayName');
        const mitglieder = body.members === undefined ? null : mitgliederAus(body.members);
        const r = await withMandant(db, k.mandantId, async (trx) => {
          const [g] = await gruppenLaden(trx, id);
          if (!g) throw new ScimAbbruch(404, 'Group nicht gefunden');
          await nameFrei(trx, name, id);
          const vorher = await alleMitglieder(trx, id);
          await trx
            .updateTable('mandant_scim_gruppe')
            .set({
              display_name: name,
              ...(body.externalId !== undefined
                ? {
                    external_id:
                      body.externalId === null ? null : alsText(body.externalId, 'externalId'),
                  }
                : {}),
              geaendert: new Date(),
            })
            .where('id', '=', id)
            .execute();
          if (mitglieder) await mitgliederAendern(trx, id, 'replace', mitglieder);
          await rollenNeu(trx, new Set([...vorher, ...(await alleMitglieder(trx, id))]));
          await protokolliere(trx, {
            benutzerId: null,
            aktion: VERWALTUNG_AUDIT.scimGruppe,
            objekt: `gruppe:${id} ersetzt`,
          });
          return gruppeLesen(trx, id, basis);
        });
        return scimSenden(reply, 200, r);
      }),
    );

    scim.patch(
      `${P}/Groups/:id`,
      sicher(async (request, reply, k) => {
        const id = idAus(request);
        const ops = patchOperationen(request.body);
        await withMandant(db, k.mandantId, async (trx) => {
          const [g] = await gruppenLaden(trx, id);
          if (!g) throw new ScimAbbruch(404, 'Group nicht gefunden');
          const vorher = await alleMitglieder(trx, id);
          let umbenannt = false;
          const betroffen = new Set<string>();
          const aendern = async (
            pfadText: string | null,
            op: string,
            wert: unknown,
            ausWertobjekt = false,
          ): Promise<void> => {
            if (pfadText === null) {
              if (op === 'remove')
                throw new ScimAbbruch(400, 'remove braucht einen Pfad', 'noTarget');
              // Okta schickt im Wertobjekt auch `id` und `schemas` mit: unbekannte Schlüssel ignorieren.
              for (const [schluessel, w] of Object.entries(alsObjekt(wert)))
                await aendern(schluessel, op, w, true);
              return;
            }
            let p;
            try {
              p = pfadLesen(pfadText);
            } catch (e) {
              if (ausWertobjekt) return;
              throw new ScimAbbruch(400, (e as Error).message, 'invalidPath');
            }
            const a = p.attr.toLowerCase();
            if (a === 'displayname') {
              if (op === 'remove')
                throw new ScimAbbruch(400, 'displayName ist Pflicht', 'mutability');
              const name = alsText(wert, 'displayName');
              await nameFrei(trx, name, id);
              await trx
                .updateTable('mandant_scim_gruppe')
                .set({ display_name: name, geaendert: new Date() })
                .where('id', '=', id)
                .execute();
              umbenannt = true;
            } else if (a === 'externalid') {
              await trx
                .updateTable('mandant_scim_gruppe')
                .set({
                  external_id: op === 'remove' ? null : alsText(wert, 'externalId'),
                  geaendert: new Date(),
                })
                .where('id', '=', id)
                .execute();
              umbenannt = true;
            } else if (a === 'members') {
              let ids: string[] | null;
              if (p.filter) {
                if (op !== 'remove')
                  throw new ScimAbbruch(400, 'Filter im Pfad nur bei remove', 'invalidPath');
                ids = vorher.filter((m) => passt(p.filter!, { value: m }));
              } else ids = wert === undefined ? null : mitgliederAus(wert);
              const art = op === 'replace' ? 'replace' : op === 'remove' ? 'remove' : 'add';
              for (const b of await mitgliederAendern(trx, id, art, ids)) betroffen.add(b);
            } else if (!ausWertobjekt) {
              throw new ScimAbbruch(400, `Unbekanntes Attribut: ${p.attr}`, 'invalidPath');
            }
          };
          for (const o of ops) await aendern(o.path, o.op, o.value);
          const konten = umbenannt
            ? new Set([...vorher, ...(await alleMitglieder(trx, id))])
            : betroffen;
          await rollenNeu(trx, konten);
          await trx
            .updateTable('mandant_scim_gruppe')
            .set({ geaendert: new Date() })
            .where('id', '=', id)
            .execute();
          await protokolliere(trx, {
            benutzerId: null,
            aktion: VERWALTUNG_AUDIT.scimGruppe,
            objekt: `gruppe:${id} geändert (${konten.size} Konten abgeglichen)`,
          });
        });
        return reply.code(204).send();
      }),
    );

    scim.delete(
      `${P}/Groups/:id`,
      sicher(async (request, reply, k) => {
        const id = idAus(request);
        await withMandant(db, k.mandantId, async (trx) => {
          const [g] = await gruppenLaden(trx, id);
          if (!g) throw new ScimAbbruch(404, 'Group nicht gefunden');
          const vorher = await alleMitglieder(trx, id);
          await trx.deleteFrom('mandant_scim_gruppe').where('id', '=', id).execute();
          await rollenNeu(trx, vorher);
          await protokolliere(trx, {
            benutzerId: null,
            aktion: VERWALTUNG_AUDIT.scimGruppe,
            objekt: `gruppe:${id} gelöscht`,
          });
        });
        return reply.code(204).send();
      }),
    );
  });
}
