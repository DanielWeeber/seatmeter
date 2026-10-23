// Routen des Moduls Budgets: Budgets (CRUD), Alarme (Liste, Quittieren), Alarmkanäle (nur Admin),
// Job-Auslöser. Rollen wie Kalkulation (Architektur §6): Admin alles; Projektleiter nur eigene Projekte
// (keine mandantenweiten Budgets); Controller lesen. Personendaten kommen hier nicht vor.
import {
  alarmAbfrageSchema,
  budgetEingabeSchema,
  kanalEingabeSchema,
  monatAbfrageSchema,
  type Alarm,
  type BudgetListe,
  type KanalTestErgebnis,
} from '@seatmeter/shared';
import { heuteIn } from '../aggregation/tage.js';
import { protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle, type AnmeldungMitMandant } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { imJobLauf } from '../jobs/index.js';
import type { PluginKontext } from '../plugin.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { antwort, sende } from '../antwort.js';
import {
  kanalDaten,
  kanalDto,
  verschluesseleGeheimnis,
  zustellen,
  ZustellFehler,
  type ZustellOptionen,
} from './kanal.js';
import { alarmAbfrage, alarmDto, pruefeBudgets } from './pruefen.js';
import { berechneStaende, budgetDto, ladeBudgets } from './stand.js';

const LESEN = requireRolle('mandanten_admin', 'controller', 'projektleiter');
const AENDERN = requireRolle('mandanten_admin', 'projektleiter');
const ADMIN = requireRolle('mandanten_admin');
const idParam = z.object({ id: z.uuid() });

export const AUDIT_BUDGETS = {
  budgetAngelegt: 'Budget angelegt',
  budgetGeaendert: 'Budget geändert',
  budgetGeloescht: 'Budget gelöscht',
  alarmQuittiert: 'Alarm quittiert',
  kanalAngelegt: 'Alarmkanal angelegt',
  kanalGeaendert: 'Alarmkanal geändert',
  kanalGeloescht: 'Alarmkanal gelöscht',
  kanalGetestet: 'Alarmkanal getestet',
} as const;

function fehlerAus(reply: FastifyReply, ergebnis: z.ZodSafeParseError<unknown>) {
  return reply.code(400).send({
    fehler: 'ungültige Eingabe',
    felder: ergebnis.error.issues.map((i) => ({ feld: i.path.join('.'), meldung: i.message })),
  });
}

/** Projektleiter dürfen nur Budgets ihrer Projekte sehen und ändern. */
function darfProjekt(a: AnmeldungMitMandant, projektId: string | null): boolean {
  if (a.rollen.includes('mandanten_admin')) return true;
  if (a.projektIds === null) return a.rollen.includes('mandanten_admin');
  return projektId !== null && a.projektIds.includes(projektId);
}

export function budgetRouten(app: FastifyInstance, ctx: PluginKontext, o: ZustellOptionen = {}) {
  const { db } = ctx;
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;
  const sichtVon = (a: AnmeldungMitMandant) =>
    a.rollen.includes('mandanten_admin') ? null : a.projektIds;

  app.get('/api/v1/budgets', { preHandler: LESEN }, async (request, reply) => {
    const q = monatAbfrageSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
    const a = benutzerVon(request);
    return withMandant(db, a.mandantId, async (trx): Promise<BudgetListe> => {
      const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
      const monat = q.data.monat ?? heuteIn(m.zeitzone).slice(0, 7);
      const budgets = await ladeBudgets(trx, sichtVon(a));
      const staende = await berechneStaende(trx, monat, budgets);
      return { monat, budgets: budgets.map((b) => budgetDto(b, staende.get(b.id)!)) };
    });
  });

  const speichern = async (
    a: AnmeldungMitMandant,
    eingabe: z.output<typeof budgetEingabeSchema>,
    id: string | null,
    reply: FastifyReply,
  ) => {
    if (!darfProjekt(a, eingabe.projekt_id))
      return reply.code(403).send({ fehler: 'Projekt nicht freigegeben' });
    const r = await withMandant(db, a.mandantId, async (trx) => {
      if (eingabe.projekt_id) {
        const p = await trx
          .selectFrom('projekt')
          .select('id')
          .where('id', '=', eingabe.projekt_id)
          .executeTakeFirst();
        if (!p) return antwort(400, { fehler: 'Projekt unbekannt' });
      }
      const werte = {
        projekt_id: eingabe.projekt_id,
        bezeichnung: eingabe.bezeichnung ?? null,
        betrag: eingabe.betrag,
        waehrung: eingabe.waehrung,
        basis: eingabe.basis,
        schwellen: eingabe.schwellen,
        ausloeser: eingabe.ausloeser,
        aktiv: eingabe.aktiv,
        geaendert: new Date(),
      };
      let budgetId: string;
      if (id === null) {
        const neu = await trx
          .insertInto('budget')
          .values({ mandant_id: sql<string>`app_mandant_id()`, ...werte })
          .returning('id')
          .executeTakeFirstOrThrow();
        budgetId = neu.id;
      } else {
        const alt = await trx
          .selectFrom('budget')
          .select('projekt_id')
          .where('id', '=', id)
          .executeTakeFirst();
        if (!alt || !darfProjekt(a, alt.projekt_id))
          return antwort(404, { fehler: 'Budget unbekannt' });
        await trx.updateTable('budget').set(werte).where('id', '=', id).execute();
        budgetId = id;
      }
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: id === null ? AUDIT_BUDGETS.budgetAngelegt : AUDIT_BUDGETS.budgetGeaendert,
        objekt: `budget:${budgetId}`,
      });
      const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
      const monat = heuteIn(m.zeitzone).slice(0, 7);
      const [b] = (await ladeBudgets(trx)).filter((x) => x.id === budgetId);
      const staende = await berechneStaende(trx, monat, [b!]);
      return antwort(id === null ? 201 : 200, budgetDto(b!, staende.get(budgetId)!));
    });
    return sende(reply, r);
  };

  app.post('/api/v1/budgets', { preHandler: AENDERN }, async (request, reply) => {
    const e = budgetEingabeSchema.safeParse(request.body);
    if (!e.success) return fehlerAus(reply, e);
    return speichern(benutzerVon(request), e.data, null, reply);
  });

  app.put('/api/v1/budgets/:id', { preHandler: AENDERN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Budget unbekannt' });
    const e = budgetEingabeSchema.safeParse(request.body);
    if (!e.success) return fehlerAus(reply, e);
    return speichern(benutzerVon(request), e.data, p.data.id, reply);
  });

  app.delete('/api/v1/budgets/:id', { preHandler: AENDERN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Budget unbekannt' });
    const a = benutzerVon(request);
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const alt = await trx
        .selectFrom('budget')
        .select('projekt_id')
        .where('id', '=', p.data.id)
        .executeTakeFirst();
      if (!alt || !darfProjekt(a, alt.projekt_id))
        return antwort(404, { fehler: 'Budget unbekannt' });
      await trx.deleteFrom('budget').where('id', '=', p.data.id).execute();
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_BUDGETS.budgetGeloescht,
        objekt: `budget:${p.data.id}`,
      });
      return antwort(204);
    });
    return sende(reply, r);
  });

  // ------------------------------------------------------------------------------------------
  // Alarme

  app.get('/api/v1/alarme', { preHandler: LESEN }, async (request, reply) => {
    const q = alarmAbfrageSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ fehler: 'ungültige Abfrage' });
    const a = benutzerVon(request);
    const sicht = sichtVon(a);
    const zeilen = await withMandant(db, a.mandantId, (trx) => {
      let abfrage = alarmAbfrage(trx).orderBy('a.ausgeloest', 'desc').limit(500);
      if (q.data.monat) abfrage = abfrage.where('a.periode', '=', `${q.data.monat}-01`);
      if (q.data.offen === '1') abfrage = abfrage.where('a.quittiert', 'is', null);
      if (sicht !== null) {
        if (sicht.length === 0) return Promise.resolve([]);
        abfrage = abfrage.where('b.projekt_id', 'in', sicht);
      }
      return abfrage.execute();
    });
    return { alarme: zeilen.map(alarmDto) };
  });

  app.post('/api/v1/alarme/:id/quittieren', { preHandler: AENDERN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Alarm unbekannt' });
    const a = benutzerVon(request);
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const vorher = await alarmAbfrage(trx).where('a.id', '=', p.data.id).executeTakeFirst();
      if (!vorher || !darfProjekt(a, vorher.projekt_id))
        return antwort(404, { fehler: 'Alarm unbekannt' });
      await trx
        .updateTable('alarm')
        .set({ quittiert: sql<Date>`coalesce(quittiert, now())`, quittiert_von: a.benutzerId })
        .where('id', '=', p.data.id)
        .execute();
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_BUDGETS.alarmQuittiert,
        objekt: `alarm:${p.data.id}`,
      });
      const z = await alarmAbfrage(trx).where('a.id', '=', p.data.id).executeTakeFirstOrThrow();
      const dto: Alarm = alarmDto(z);
      return antwort(200, dto);
    });
    return sende(reply, r);
  });

  app.post('/api/v1/jobs/budgets/pruefen', { preHandler: ADMIN }, async (request) => {
    const a = benutzerVon(request);
    return imJobLauf(ctx, 'budgets.pruefen', 'api', () =>
      pruefeBudgets(ctx, o, new Date(), a.mandantId),
    );
  });

  // ------------------------------------------------------------------------------------------
  // Alarmkanäle (nur Mandanten-Admin; Geheimnisse nur verschlüsselt, nie in Antworten)

  app.get('/api/v1/alarmkanal', { preHandler: ADMIN }, async (request) => {
    const a = benutzerVon(request);
    const zeilen = await withMandant(db, a.mandantId, (trx) =>
      trx
        .selectFrom('alarm_kanal')
        .select([
          'id',
          'typ',
          'bezeichnung',
          'aktiv',
          'konfig',
          'geheimnis',
          'erstellt',
          'geaendert',
        ])
        .orderBy('erstellt')
        .execute(),
    );
    return { kanaele: zeilen.map(kanalDto) };
  });

  const kanalSpeichern = async (
    a: AnmeldungMitMandant,
    roh: unknown,
    id: string | null,
    reply: FastifyReply,
  ) => {
    const e = kanalEingabeSchema.safeParse(roh);
    if (!e.success) return fehlerAus(reply, e);
    const k = e.data;
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const geheimnis =
        k.geheimnis === undefined
          ? undefined
          : k.geheimnis === null
            ? null
            : verschluesseleGeheimnis(masterKey, k.geheimnis);
      const werte = {
        typ: k.typ,
        bezeichnung: k.bezeichnung,
        aktiv: k.aktiv,
        konfig: JSON.stringify(k.konfig),
        geaendert: new Date(),
        ...(geheimnis !== undefined ? { geheimnis } : {}),
      };
      let kanalId: string;
      if (id === null) {
        const neu = await trx
          .insertInto('alarm_kanal')
          .values({ mandant_id: sql<string>`app_mandant_id()`, ...werte })
          .returning('id')
          .executeTakeFirstOrThrow();
        kanalId = neu.id;
      } else {
        const r = await trx
          .updateTable('alarm_kanal')
          .set(werte)
          .where('id', '=', id)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) === 0) return antwort(404, { fehler: 'Kanal unbekannt' });
        kanalId = id;
      }
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: id === null ? AUDIT_BUDGETS.kanalAngelegt : AUDIT_BUDGETS.kanalGeaendert,
        objekt: `alarm_kanal:${kanalId}`,
      });
      const z = await trx
        .selectFrom('alarm_kanal')
        .select([
          'id',
          'typ',
          'bezeichnung',
          'aktiv',
          'konfig',
          'geheimnis',
          'erstellt',
          'geaendert',
        ])
        .where('id', '=', kanalId)
        .executeTakeFirstOrThrow();
      return antwort(id === null ? 201 : 200, kanalDto(z));
    });
    return sende(reply, r);
  };

  app.post('/api/v1/alarmkanal', { preHandler: ADMIN }, async (request, reply) =>
    kanalSpeichern(benutzerVon(request), request.body, null, reply),
  );

  app.put('/api/v1/alarmkanal/:id', { preHandler: ADMIN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Kanal unbekannt' });
    return kanalSpeichern(benutzerVon(request), request.body, p.data.id, reply);
  });

  app.delete('/api/v1/alarmkanal/:id', { preHandler: ADMIN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Kanal unbekannt' });
    const a = benutzerVon(request);
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const r = await trx.deleteFrom('alarm_kanal').where('id', '=', p.data.id).executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) return antwort(404, { fehler: 'Kanal unbekannt' });
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_BUDGETS.kanalGeloescht,
        objekt: `alarm_kanal:${p.data.id}`,
      });
      return antwort(204);
    });
    return sende(reply, r);
  });

  app.post('/api/v1/alarmkanal/:id/test', { preHandler: ADMIN }, async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ fehler: 'Kanal unbekannt' });
    const a = benutzerVon(request);
    const zeile = await withMandant(db, a.mandantId, async (trx) => {
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_BUDGETS.kanalGetestet,
        objekt: `alarm_kanal:${p.data.id}`,
      });
      return trx
        .selectFrom('alarm_kanal')
        .select([
          'id',
          'typ',
          'bezeichnung',
          'aktiv',
          'konfig',
          'geheimnis',
          'erstellt',
          'geaendert',
        ])
        .where('id', '=', p.data.id)
        .executeTakeFirst();
    });
    if (!zeile) return reply.code(404).send({ fehler: 'Kanal unbekannt' });
    let ergebnis: KanalTestErgebnis;
    try {
      const meldung = await zustellen(
        kanalDaten(masterKey, zeile),
        {
          schluessel: `seatmeter|test|${zeile.id}`,
          titel: 'Testnachricht',
          zeilen: ['Alarmkanal eingerichtet', `Kanal: ${zeile.bezeichnung}`],
          link: ctx.konfiguration.SEATMETER_PUBLIC_URL ?? null,
          daten: {},
          test: true,
        },
        o,
      );
      ergebnis = { ok: true, meldung };
    } catch (e) {
      ergebnis = {
        ok: false,
        meldung: e instanceof ZustellFehler ? e.message : 'Fehler beim Zustellen',
      };
    }
    return ergebnis;
  });
}
