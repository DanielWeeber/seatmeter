// Upload für geplante Katalog-Importe: `POST /api/v1/projektkatalog/import/datei` mit rohem `text/csv`, für angemeldete
// Mandanten-Admins oder mit einem Katalog-Token (`smk_…`) vom Zweck `csv_import`. Das Mandanten-Token gilt hier nie: Es
// steht in den verwalteten Einstellungen, alle Beschäftigten können es lesen. Umgekehrt gilt das Token nur für diese
// Route: Die Anmeldung der übrigen Routen wertet es nicht aus, der Ingest kennt das Präfix nicht, und der Push verlangt
// den Zweck `katalog_api`.
// Die Anmeldung läuft vor dem Lesen des Körpers. Vom Token steht nur der SHA-256 in der Datenbank.
import {
  KATALOG_DATEI_MAX_BYTES,
  KATALOG_TOKEN_PRAEFIX,
  KATALOG_TRENNZEICHEN_STANDARD,
  katalogSpaltenSchema,
  katalogTokenEingabeSchema,
  katalogTrennzeichenLesen,
  type KatalogSpalten,
  type KatalogToken,
  type KatalogTokenListe,
  type KatalogTokenNeu,
  type KatalogTokenScope,
} from '@seatmeter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle } from '../auth/kontext.js';
import { Ratenbegrenzer } from '../auth/ratenbegrenzer.js';
import { withMandant } from '../db/mandant.js';
import { TokenEimer, type Grenze } from '../ingest-gemeinsam/ratenlimit.js';
import { sha256, zufallsToken } from '../krypto.js';
import type { PluginKontext } from '../plugin.js';
import { AUDIT_KATALOG } from './audit.js';
import { katalogImportieren } from './importieren.js';
import { csvDateiQuelle, QuelleFehler } from './quelle.js';

const ADMIN = requireRolle('mandanten_admin');
const PFAD_DATEI = '/api/v1/projektkatalog/import/datei';
const PFAD_TOKENS = '/api/v1/projektkatalog/tokens';

/** Ein geplanter Lauf braucht wenige Anfragen; die Grenze gilt je Token bzw. je Mandant im Dashboard. */
const UPLOAD_GRENZE: Grenze = { proMinute: 10, stoss: 30 };
const FEHLVERSUCHE_GRENZE = 20;
const FEHLVERSUCHE_FENSTER_MS = 15 * 60_000;

const TOKEN_SPALTEN = [
  'id',
  'bezeichnung',
  'praefix',
  'scope',
  'erstellt',
  'zuletzt_genutzt',
  'widerrufen',
] as const;

interface TokenZeile {
  id: string;
  bezeichnung: string;
  praefix: string;
  scope: KatalogTokenScope;
  erstellt: Date;
  zuletzt_genutzt: Date | null;
  widerrufen: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function tokenAntwort(z: TokenZeile): KatalogToken {
  return {
    id: z.id,
    bezeichnung: z.bezeichnung,
    praefix: z.praefix,
    scope: z.scope,
    erstellt: new Date(z.erstellt).toISOString(),
    zuletzt_genutzt: iso(z.zuletzt_genutzt),
    widerrufen: iso(z.widerrufen),
  };
}

const idParameter = z.object({ id: z.uuid() });

/** Anlegen, Auflisten und Widerrufen der Import-Tokens (nur Mandanten-Admin). */
export function katalogTokenRouten(app: FastifyInstance, ctx: PluginKontext) {
  const { db } = ctx;

  app.get(PFAD_TOKENS, { preHandler: ADMIN }, async (request): Promise<KatalogTokenListe> => {
    const zeilen = await withMandant(db, benutzerVon(request).mandantId, (trx) =>
      trx
        .selectFrom('katalog_import_token')
        .select([...TOKEN_SPALTEN])
        .orderBy('erstellt', 'desc')
        .execute(),
    );
    return { tokens: zeilen.map(tokenAntwort) };
  });

  app.post(PFAD_TOKENS, { preHandler: ADMIN }, async (request, reply) => {
    const e = katalogTokenEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'Bezeichnung fehlt oder ist zu lang' });
    const a = benutzerVon(request);
    const klartext = `${KATALOG_TOKEN_PRAEFIX}${zufallsToken(32)}`;
    const praefix = klartext.slice(0, 12);
    const zeile = await withMandant(db, a.mandantId, async (trx) => {
      const z = await trx
        .insertInto('katalog_import_token')
        .values({
          mandant_id: a.mandantId,
          token_sha256: sha256(klartext),
          praefix,
          bezeichnung: e.data.bezeichnung,
          scope: e.data.scope,
        })
        .returning([...TOKEN_SPALTEN])
        .executeTakeFirstOrThrow();
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_KATALOG.importTokenErzeugt,
        objekt: `katalog-token:${praefix} scope:${e.data.scope}`,
      });
      return z;
    });
    // Klartext nur in dieser Antwort.
    const antwort: KatalogTokenNeu = { ...tokenAntwort(zeile), token: klartext };
    return reply.code(201).send(antwort);
  });

  app.delete(`${PFAD_TOKENS}/:id`, { preHandler: ADMIN }, async (request, reply) => {
    const p = idParameter.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ fehler: 'ungültige Token-ID' });
    const a = benutzerVon(request);
    const ok = await withMandant(db, a.mandantId, async (trx) => {
      const z = await trx
        .updateTable('katalog_import_token')
        .set({ widerrufen: new Date() })
        .where('id', '=', p.data.id)
        .where('widerrufen', 'is', null)
        .returning('praefix')
        .executeTakeFirst();
      if (z) {
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_KATALOG.importTokenWiderrufen,
          objekt: `katalog-token:${z.praefix}`,
        });
      }
      return Boolean(z);
    });
    return ok ? reply.code(204).send() : reply.code(404).send({ fehler: 'Token nicht gefunden' });
  });
}

const schalter = (standard: boolean) =>
  z
    .enum(['0', '1', 'true', 'false', 'ja', 'nein'])
    .optional()
    .transform((w) => (w === undefined ? standard : ['1', 'true', 'ja'].includes(w)));

/** Streng: Ein Tippfehler bei `trockenlauf` darf nicht zu einem echten Import werden. */
const dateiAbfrage = z.strictObject({
  trennzeichen: z.string().optional(),
  spalte_id: z.string().optional(),
  spalte_name: z.string().optional(),
  spalte_nummer: z.string().optional(),
  spalte_kunde: z.string().optional(),
  spalte_aktiv: z.string().optional(),
  spalte_parent: z.string().optional(),
  trockenlauf: schalter(false),
  vollstaendig: schalter(true),
});

interface UploadZugang {
  mandantId: string;
  benutzerId: string | null;
  ausloeser: string;
}

/** Die Route selbst, in eigenem Geltungsbereich: Hier kommt `text/csv` als unveränderte Bytes an. */
export function katalogDateiRoute(app: FastifyInstance, ctx: PluginKontext) {
  const { db } = ctx;
  const fehlversuche = new Ratenbegrenzer(FEHLVERSUCHE_GRENZE, FEHLVERSUCHE_FENSTER_MS);
  const eimer = new TokenEimer();
  const zugaenge = new WeakMap<FastifyRequest, UploadZugang>();

  const zuViele = (reply: FastifyReply, sekunden: number, text: string) =>
    reply.code(429).header('retry-after', String(sekunden)).send({ fehler: text });

  const tokenAnmelden = async (request: FastifyRequest, reply: FastifyReply, kopf: string) => {
    const t = /^Bearer\s+(\S{1,200})\s*$/i.exec(kopf)?.[1];
    const zeile = t?.startsWith(KATALOG_TOKEN_PRAEFIX)
      ? await db
          .selectFrom('katalog_import_token')
          .select(['id', 'mandant_id', 'praefix'])
          .where('token_sha256', '=', sha256(t))
          .where('widerrufen', 'is', null)
          .where('scope', '=', 'csv_import')
          .executeTakeFirst()
      : undefined;
    if (!zeile) {
      // Erst nach der Suche begrenzen: Fehlversuche hinter demselben Proxy dürfen ein gültiges Token nie treffen.
      const ip = request.ip || 'unbekannt';
      if (fehlversuche.gesperrt(ip)) {
        return zuViele(reply, FEHLVERSUCHE_FENSTER_MS / 1000, 'Zu viele Fehlversuche');
      }
      fehlversuche.fehlschlag(ip);
      return reply.code(401).send({ fehler: 'Token fehlt, ist unbekannt oder widerrufen' });
    }
    const warten = eimer.pruefen(zeile.id, UPLOAD_GRENZE);
    if (warten > 0) return zuViele(reply, warten, 'Zu viele Anfragen für dieses Token');
    await withMandant(db, zeile.mandant_id, (trx) =>
      trx
        .updateTable('katalog_import_token')
        .set({ zuletzt_genutzt: new Date() })
        .where('id', '=', zeile.id)
        .execute(),
    );
    zugaenge.set(request, {
      mandantId: zeile.mandant_id,
      benutzerId: null,
      ausloeser: `token:${zeile.praefix}`,
    });
    return undefined;
  };

  const anmelden = async (request: FastifyRequest, reply: FastifyReply) => {
    const kopf = request.headers.authorization;
    // Mit Authorization-Kopf zählt nur das Token, nie zusätzlich eine Anmeldung per Cookie.
    if (kopf !== undefined) return tokenAnmelden(request, reply, kopf);
    await ADMIN(request, reply);
    if (reply.sent) return reply;
    const a = benutzerVon(request);
    const warten = eimer.pruefen(`mandant:${a.mandantId}`, UPLOAD_GRENZE);
    if (warten > 0) return zuViele(reply, warten, 'Zu viele Anfragen');
    zugaenge.set(request, { mandantId: a.mandantId, benutzerId: a.benutzerId, ausloeser: 'konto' });
    return undefined;
  };

  void app.register(async (kind) => {
    kind.removeAllContentTypeParsers();
    kind.addContentTypeParser(
      ['text/csv', 'text/plain'],
      { parseAs: 'buffer', bodyLimit: KATALOG_DATEI_MAX_BYTES },
      (_a, koerper, fertig) => fertig(null, koerper),
    );
    kind.post(PFAD_DATEI, { onRequest: anmelden }, async (request, reply) => {
      const zugang = zugaenge.get(request);
      if (!zugang) throw new Error('Anmeldung fehlt an dieser Route');
      const q = dateiAbfrage.safeParse(request.query);
      if (!q.success) {
        return reply.code(400).send({
          fehler: 'Unbekannter Parameter oder ungültiger Wert',
          felder: q.error.issues.slice(0, 20).map((i) => i.path.join('.')),
        });
      }
      const trenn =
        q.data.trennzeichen === undefined
          ? KATALOG_TRENNZEICHEN_STANDARD
          : katalogTrennzeichenLesen(q.data.trennzeichen);
      if (!trenn) return reply.code(400).send({ fehler: 'Trennzeichen unbekannt' });
      let spalten: KatalogSpalten | undefined;
      const zuordnung = {
        id: q.data.spalte_id,
        name: q.data.spalte_name,
        nummer: q.data.spalte_nummer,
        kunde: q.data.spalte_kunde,
        aktiv: q.data.spalte_aktiv,
        parent: q.data.spalte_parent,
      };
      if (Object.values(zuordnung).some((w) => w !== undefined)) {
        const s = katalogSpaltenSchema.safeParse(zuordnung);
        if (!s.success) {
          return reply
            .code(400)
            .send({ fehler: 'Die Spaltenzuordnung braucht spalte_id und spalte_name' });
        }
        spalten = s.data;
      }
      const koerper = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      try {
        return await katalogImportieren(
          db,
          zugang.mandantId,
          csvDateiQuelle(koerper, { trennzeichen: trenn, spalten }),
          {
            vollstaendig: q.data.vollstaendig,
            trockenlauf: q.data.trockenlauf,
            benutzerId: zugang.benutzerId,
            ausloeser: zugang.ausloeser,
          },
        );
      } catch (f) {
        if (f instanceof QuelleFehler) return reply.code(400).send({ fehler: f.message });
        throw f;
      }
    });
  });
}
