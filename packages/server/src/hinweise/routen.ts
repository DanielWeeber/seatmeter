// Routen der Projekt-Hinweise: Liste je Monat, erledigt markieren, Regeln (Admin), Neuberechnung.
import {
  hinweisRegelnEingabeSchema,
  hinweisRegelnSchema,
  monatAbfrageSchema,
  type HinweisListe,
} from '@seatmeter/shared';
import { heuteIn } from '../aggregation/tage.js';
import { protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle, type AnmeldungMitMandant } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { imJobLauf } from '../jobs/index.js';
import type { PluginKontext } from '../plugin.js';
import type { Datenbank } from '../db/schema.js';
import type { FastifyInstance } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { antwort, sende } from '../antwort.js';
import { hinweisDto, hinweiseErzeugen, ladeRegeln } from './job.js';

const LESEN = requireRolle('mandanten_admin', 'controller', 'projektleiter');
const AENDERN = requireRolle('mandanten_admin', 'projektleiter');
const ADMIN = requireRolle('mandanten_admin');
const idParam = z.object({ id: z.uuid() });

export const AUDIT_HINWEISE = {
  erledigt: 'Hinweis erledigt',
  regelnGeaendert: 'Hinweis-Regeln geändert',
} as const;

function abfrage(trx: Transaction<Datenbank>) {
  return trx
    .selectFrom('hinweis as h')
    .leftJoin('projekt as p', 'p.id', 'h.projekt_id')
    .select([
      'h.id',
      'h.monat',
      'h.projekt_id',
      sql<
        string | null
      >`coalesce(p.anzeigename, p.owner || '/' || p.repo_name, p.repo_name, p.url_norm)`.as(
        'projekt_name',
      ),
      'h.typ',
      'h.text',
      'h.wert',
      'h.erstellt',
      'h.aktualisiert',
      'h.erledigt',
    ]);
}

const sichtVon = (a: AnmeldungMitMandant) =>
  a.rollen.includes('mandanten_admin') ? null : a.projektIds;

export function hinweisRouten(app: FastifyInstance, ctx: PluginKontext) {
  const { db } = ctx;

  app.get('/api/v1/hinweise', { preHandler: LESEN }, async (request, reply) => {
    const q = monatAbfrageSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
    const a = benutzerVon(request);
    const sicht = sichtVon(a);
    return withMandant(db, a.mandantId, async (trx): Promise<HinweisListe> => {
      const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
      const monat = q.data.monat ?? heuteIn(m.zeitzone).slice(0, 7);
      let liste = abfrage(trx)
        .where('h.monat', '=', `${monat}-01`)
        .orderBy('h.erledigt', 'desc')
        .orderBy('h.typ');
      if (sicht !== null) {
        if (sicht.length === 0) return { monat, hinweise: [], regeln: await ladeRegeln(trx) };
        liste = liste.where('h.projekt_id', 'in', sicht);
      }
      const zeilen = await liste.execute();
      return { monat, hinweise: zeilen.map(hinweisDto), regeln: await ladeRegeln(trx) };
    });
  });

  app.post('/api/v1/hinweise/:id/erledigt', { preHandler: AENDERN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Hinweis unbekannt' });
    const a = benutzerVon(request);
    const sicht = sichtVon(a);
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const h = await trx
        .selectFrom('hinweis')
        .select('projekt_id')
        .where('id', '=', p.data.id)
        .executeTakeFirst();
      if (!h || (sicht !== null && (h.projekt_id === null || !sicht.includes(h.projekt_id)))) {
        return antwort(404, { fehler: 'Hinweis unbekannt' });
      }
      await trx
        .updateTable('hinweis')
        .set({ erledigt: sql<Date>`coalesce(erledigt, now())`, erledigt_von: a.benutzerId })
        .where('id', '=', p.data.id)
        .execute();
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_HINWEISE.erledigt,
        objekt: `hinweis:${p.data.id}`,
      });
      return antwort(
        200,
        hinweisDto(await abfrage(trx).where('h.id', '=', p.data.id).executeTakeFirstOrThrow()),
      );
    });
    return sende(reply, r);
  });

  app.put('/api/v1/hinweise/regeln', { preHandler: ADMIN }, async (request, reply) => {
    const e = hinweisRegelnEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'ungültige Eingabe' });
    const a = benutzerVon(request);
    return withMandant(db, a.mandantId, async (trx) => {
      const regeln = hinweisRegelnSchema.parse({ ...(await ladeRegeln(trx)), ...e.data });
      await trx
        .insertInto('ee_einstellung')
        .values({ mandant_id: a.mandantId, hinweise: JSON.stringify(regeln) })
        .onConflict((oc) =>
          oc
            .column('mandant_id')
            .doUpdateSet({ hinweise: JSON.stringify(regeln), geaendert: new Date() }),
        )
        .execute();
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_HINWEISE.regelnGeaendert,
        objekt: Object.keys(e.data).sort().join(','),
      });
      return regeln;
    });
  });

  app.post('/api/v1/jobs/hinweise/erzeugen', { preHandler: ADMIN }, async (request, reply) => {
    const q = monatAbfrageSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
    const a = benutzerVon(request);
    const lauf = await imJobLauf(ctx, 'hinweise.erzeugen', 'api', () =>
      withMandant(db, a.mandantId, async (trx) => {
        const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
        return hinweiseErzeugen(trx, q.data.monat ?? heuteIn(m.zeitzone).slice(0, 7));
      }),
    );
    if (lauf.status === 'uebersprungen') return reply.code(409).send({ fehler: 'läuft bereits' });
    if (lauf.status === 'fehler')
      return reply.code(500).send({ fehler: 'Berechnung fehlgeschlagen' });
    return lauf.ergebnis;
  });
}
