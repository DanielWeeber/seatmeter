// Modul kalkulation: Projektpreise live (`/api/v1/kalkulation`), Monatsabschluss, Wechselkurs (EZB,
// manuell) und die Jobs `kalkulation.monatsabschluss` und `kurs.ezb` (Architektur §5).
import {
  kursEingabeSchema,
  monatAbfrageSchema,
  monatSchema,
  type Kurs,
  type Monatsabschluss,
} from '@seatmeter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import {
  benutzerVon,
  requireBenutzer,
  requireRolle,
  type AnmeldungMitMandant,
} from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { imJobLauf } from '../jobs/index.js';
import type { SeatmeterPlugin } from '../plugin.js';
import { ladeAbschluss, monatsabschlussJob, schliesseMonat } from './abschluss.js';
import { kursEzbAktualisieren, ladeKurs, ladeKurse, laufenderMonat, monatsTag } from './kurs.js';
import { kalkuliereMonat } from './rechnen.js';

export * from './abschluss.js';
export * from './kurs.js';
export * from './rechnen.js';

/** Rollen mit Projektpreisen (Betriebsrat: nur Aggregate ohne Preise, Architektur §6). */
export const PREIS_ROLLEN = ['mandanten_admin', 'controller', 'projektleiter'] as const;

const nurAdmin = requireRolle('mandanten_admin');
const abschlussAbfrage = z.object({
  monat: monatSchema.optional(),
  erzwingen: z.enum(['0', '1', 'true', 'false']).optional(),
});

export const kalkulationPlugin: SeatmeterPlugin = {
  name: 'kern-kalkulation',
  jobs: [
    {
      // Am 1. um 03:30 UTC den Vormonat einfrieren (nach `kurs.ezb` um 03:00).
      name: 'kalkulation.monatsabschluss',
      zeitplan: '30 3 1 * *',
      ausfuehren: (ctx) => monatsabschlussJob(ctx),
    },
    {
      // Täglich (also auch am 1.): laufender Monat vorläufig, Vormonat endgültig, sobald veröffentlicht.
      name: 'kurs.ezb',
      zeitplan: '0 3 * * *',
      ausfuehren: (ctx) => kursEzbAktualisieren(ctx.db),
    },
  ],
  routen(app, ctx) {
    const { db } = ctx;

    /** `monat` aus der Abfrage, sonst der laufende Monat des Mandanten; 400 bei falschem Format. */
    const monatOderLaufend = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<{ a: AnmeldungMitMandant; monat: string } | null> => {
      const a = benutzerVon(request);
      const q = monatAbfrageSchema.safeParse(request.query);
      if (!q.success) {
        await reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
        return null;
      }
      if (q.data.monat) return { a, monat: q.data.monat };
      const m = await withMandant(db, a.mandantId, (trx) =>
        trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow(),
      );
      return { a, monat: laufenderMonat(m.zeitzone) };
    };

    app.get(
      '/api/v1/kalkulation',
      { preHandler: requireRolle(...PREIS_ROLLEN) },
      async (request, reply) => {
        const r = await monatOderLaufend(request, reply);
        if (!r) return reply;
        return withMandant(db, r.a.mandantId, (trx) =>
          kalkuliereMonat(trx, r.monat, r.a.projektIds),
        );
      },
    );

    app.get(
      '/api/v1/monatsabschluss',
      { preHandler: requireRolle(...PREIS_ROLLEN) },
      async (request, reply) => {
        const r = await monatOderLaufend(request, reply);
        if (!r) return reply;
        const abschluss = await withMandant(db, r.a.mandantId, (trx) =>
          ladeAbschluss(trx, r.monat, r.a.projektIds),
        );
        const antwort: Monatsabschluss = {
          monat: r.monat,
          abgeschlossen: abschluss !== null,
          abschluss,
        };
        return antwort;
      },
    );

    app.post(
      '/api/v1/jobs/kalkulation/monatsabschluss',
      { preHandler: nurAdmin },
      async (request, reply) => {
        const q = abschlussAbfrage.safeParse(request.query);
        if (!q.success || !q.data.monat) {
          return reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
        }
        const monat = q.data.monat;
        const erzwingen = q.data.erzwingen === '1' || q.data.erzwingen === 'true';
        const a = benutzerVon(request);
        const lauf = await imJobLauf(ctx, 'kalkulation.monatsabschluss', 'api', () =>
          schliesseMonat(db, a.mandantId, monat, { erzwingen, benutzerId: a.benutzerId }),
        );
        if (lauf.status === 'uebersprungen') {
          return reply.code(409).send({ fehler: 'Monatsabschluss läuft gerade' });
        }
        if (lauf.status === 'fehler') {
          return reply.code(500).send({ fehler: 'Monatsabschluss fehlgeschlagen' });
        }
        return lauf.ergebnis;
      },
    );

    app.get('/api/v1/kurse', { preHandler: requireBenutzer }, async (request) => {
      const a = benutzerVon(request);
      return { zeilen: await withMandant(db, a.mandantId, (trx) => ladeKurse(trx)) };
    });

    app.get('/api/v1/kurs', { preHandler: requireBenutzer }, async (request, reply) => {
      const r = await monatOderLaufend(request, reply);
      if (!r) return reply;
      return withMandant(db, r.a.mandantId, (trx) => ladeKurs(trx, r.monat));
    });

    app.put('/api/v1/kurs', { preHandler: nurAdmin }, async (request, reply) => {
      const q = monatAbfrageSchema.safeParse(request.query);
      if (!q.success || !q.data.monat) {
        return reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
      }
      const eingabe = kursEingabeSchema.safeParse(request.body);
      if (!eingabe.success) {
        return reply.code(400).send({ fehler: 'ungültige Eingabe', details: eingabe.error.issues });
      }
      const monat = q.data.monat;
      const wert = eingabe.data.usd_eur.toFixed(6);
      const a = benutzerVon(request);
      const kurs: Kurs = await withMandant(db, a.mandantId, async (trx) => {
        await trx
          .insertInto('kurs')
          .values({
            mandant_id: a.mandantId,
            monat: monatsTag(monat),
            usd_eur: wert,
            quelle: 'manuell',
            vorlaeufig: false,
            aktualisiert: new Date(),
          })
          .onConflict((oc) =>
            oc.columns(['mandant_id', 'monat']).doUpdateSet({
              usd_eur: wert,
              quelle: 'manuell',
              vorlaeufig: false,
              aktualisiert: new Date(),
            }),
          )
          .execute();
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_AKTION.kursGesetzt,
          objekt: `kurs:${monat} ${wert} manuell`,
        });
        return ladeKurs(trx, monat);
      });
      return kurs;
    });

    // Manuellen Kurs entfernen: der nächste EZB-Abruf füllt den Monat wieder.
    app.delete('/api/v1/kurs', { preHandler: nurAdmin }, async (request, reply) => {
      const q = monatAbfrageSchema.safeParse(request.query);
      if (!q.success || !q.data.monat) {
        return reply.code(400).send({ fehler: 'Monat als JJJJ-MM angeben' });
      }
      const monat = q.data.monat;
      const a = benutzerVon(request);
      await withMandant(db, a.mandantId, async (trx) => {
        const r = await trx
          .deleteFrom('kurs')
          .where('monat', '=', monatsTag(monat))
          .where('quelle', '=', 'manuell')
          .executeTakeFirst();
        if (Number(r.numDeletedRows) > 0) {
          await protokolliere(trx, {
            benutzerId: a.benutzerId,
            aktion: AUDIT_AKTION.kursGeloescht,
            objekt: `kurs:${monat} manuell`,
          });
        }
      });
      return reply.code(204).send();
    });

    app.post('/api/v1/jobs/kurs/ezb', { preHandler: nurAdmin }, async (request, reply) => {
      const a = benutzerVon(request);
      const lauf = await imJobLauf(ctx, 'kurs.ezb', 'api', () =>
        kursEzbAktualisieren(db, { mandanten: [a.mandantId] }),
      );
      if (lauf.status === 'uebersprungen') {
        return reply.code(409).send({ fehler: 'EZB-Abruf läuft gerade' });
      }
      if (lauf.status === 'fehler') {
        return reply.code(502).send({ fehler: 'EZB-Abruf fehlgeschlagen' });
      }
      return lauf.ergebnis;
    });
  },
};
