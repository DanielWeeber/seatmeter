// Modul preise: Preistabelle (global + Mandant), Sitzkosten und Sitzliste (Architektur §2.5, §5).
import {
  personSitzEingabeSchema,
  preisEingabeSchema,
  sitzkostenEingabeSchema,
  type PreisDto,
} from '@seatmeter/shared';
import { z } from 'zod';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireBenutzer, requireRolle } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import type { SeatmeterPlugin } from '../plugin.js';
import {
  dbWerte,
  effektivePreistabelle,
  ladePreiszeilen,
  preiseSeedEinspielen,
  zeileAusDb,
  type PreisDbZeile,
} from './tabelle.js';

export * from './tabelle.js';

const idSchema = z.object({ id: z.uuid() });
const nurAdmin = requireRolle('mandanten_admin');

function alsDto(z: PreisDbZeile, aktiv: boolean): PreisDto {
  const { mandant_id: _m, ...rest } = zeileAusDb(z);
  return {
    ...rest,
    id: z.id,
    mandant_id: z.mandant_id,
    herkunft: z.mandant_id === null ? 'global' : 'mandant',
    aktiv,
  };
}

function istEindeutigkeitsFehler(fehler: unknown): boolean {
  return (
    typeof fehler === 'object' && fehler !== null && (fehler as { code?: string }).code === '23505'
  );
}

export const preisePlugin: SeatmeterPlugin = {
  name: 'kern-preise',
  async routen(app, { db }) {
    try {
      await preiseSeedEinspielen(db);
    } catch (fehler) {
      app.log.error({ fehler: String(fehler) }, 'Preis-Seed nicht eingespielt (DB?)');
    }

    app.get('/api/v1/preise', { preHandler: requireBenutzer }, async (request) => {
      const a = benutzerVon(request);
      const zeilen = await withMandant(db, a.mandantId, (trx) => ladePreiszeilen(trx));
      const aktiv = new Set(effektivePreistabelle(zeilen).map((z) => z.id));
      return { zeilen: zeilen.map((z) => alsDto(z, aktiv.has(z.id))) };
    });

    app.post('/api/v1/preise', { preHandler: nurAdmin }, async (request, reply) => {
      const eingabe = preisEingabeSchema.safeParse(request.body);
      if (!eingabe.success) {
        return reply.code(400).send({ fehler: 'ungültige Eingabe', details: eingabe.error.issues });
      }
      const a = benutzerVon(request);
      try {
        const zeile = await withMandant(db, a.mandantId, async (trx) => {
          const neu = await trx
            .insertInto('preis')
            .values(dbWerte({ ...eingabe.data, mandant_id: a.mandantId }))
            .returningAll()
            .executeTakeFirstOrThrow();
          await protokolliere(trx, {
            benutzerId: a.benutzerId,
            aktion: AUDIT_AKTION.preisAngelegt,
            objekt: `preis:${neu.id} ${neu.modell_praefix} ab ${neu.gueltig_ab}`,
          });
          return neu;
        });
        return reply.code(201).send(alsDto(zeile, true));
      } catch (fehler) {
        if (istEindeutigkeitsFehler(fehler)) {
          return reply.code(409).send({ fehler: 'Präfix mit diesem gueltig_ab existiert schon' });
        }
        throw fehler;
      }
    });

    app.put('/api/v1/preise/:id', { preHandler: nurAdmin }, async (request, reply) => {
      const param = idSchema.safeParse(request.params);
      const eingabe = preisEingabeSchema.safeParse(request.body);
      if (!param.success) return reply.code(404).send({ fehler: 'nicht gefunden' });
      if (!eingabe.success) {
        return reply.code(400).send({ fehler: 'ungültige Eingabe', details: eingabe.error.issues });
      }
      const a = benutzerVon(request);
      try {
        const zeile = await withMandant(db, a.mandantId, async (trx) => {
          // Nur Mandanten-Zeilen; globale Zeilen schützt zusätzlich die RLS-Policy preis_schreiben.
          const geaendert = await trx
            .updateTable('preis')
            .set(dbWerte({ ...eingabe.data, mandant_id: a.mandantId }))
            .where('id', '=', param.data.id)
            .where('mandant_id', '=', a.mandantId)
            .returningAll()
            .executeTakeFirst();
          if (geaendert) {
            await protokolliere(trx, {
              benutzerId: a.benutzerId,
              aktion: AUDIT_AKTION.preisGeaendert,
              objekt: `preis:${geaendert.id} ${geaendert.modell_praefix} ab ${geaendert.gueltig_ab}`,
            });
          }
          return geaendert;
        });
        if (!zeile) return reply.code(404).send({ fehler: 'keine Mandanten-Zeile mit dieser ID' });
        return alsDto(zeile, true);
      } catch (fehler) {
        if (istEindeutigkeitsFehler(fehler)) {
          return reply.code(409).send({ fehler: 'Präfix mit diesem gueltig_ab existiert schon' });
        }
        throw fehler;
      }
    });

    app.get('/api/v1/sitzkosten', { preHandler: requireBenutzer }, async (request) => {
      const a = benutzerVon(request);
      const zeilen = await withMandant(db, a.mandantId, (trx) =>
        trx
          .selectFrom('sitzkosten')
          .select(['sitz_typ', 'gueltig_ab', 'preis_monat', 'waehrung', 'abrechnung'])
          .orderBy('sitz_typ')
          .orderBy('gueltig_ab')
          .execute(),
      );
      return { zeilen: zeilen.map((z) => ({ ...z, preis_monat: Number(z.preis_monat) })) };
    });

    app.put('/api/v1/sitzkosten', { preHandler: nurAdmin }, async (request, reply) => {
      const eingabe = z
        .union([sitzkostenEingabeSchema, z.array(sitzkostenEingabeSchema).min(1).max(100)])
        .safeParse(request.body);
      if (!eingabe.success) {
        return reply.code(400).send({ fehler: 'ungültige Eingabe', details: eingabe.error.issues });
      }
      const liste = Array.isArray(eingabe.data) ? eingabe.data : [eingabe.data];
      const a = benutzerVon(request);
      await withMandant(db, a.mandantId, async (trx) => {
        for (const s of liste) {
          await trx
            .insertInto('sitzkosten')
            .values({ ...s, mandant_id: a.mandantId })
            .onConflict((oc) =>
              oc.columns(['mandant_id', 'sitz_typ', 'gueltig_ab']).doUpdateSet({
                preis_monat: s.preis_monat,
                waehrung: s.waehrung,
                abrechnung: s.abrechnung,
              }),
            )
            .execute();
          await protokolliere(trx, {
            benutzerId: a.benutzerId,
            aktion: AUDIT_AKTION.sitzkostenGeaendert,
            objekt: `sitzkosten:${s.sitz_typ} ab ${s.gueltig_ab}`,
          });
        }
      });
      return { geaendert: liste.length };
    });

    app.get('/api/v1/personen/:id/sitz', { preHandler: nurAdmin }, async (request, reply) => {
      const param = idSchema.safeParse(request.params);
      if (!param.success) return reply.code(404).send({ fehler: 'nicht gefunden' });
      const a = benutzerVon(request);
      const ergebnis = await withMandant(db, a.mandantId, async (trx) => {
        const person = await trx
          .selectFrom('person')
          .select(['id', 'pseudonym'])
          .where('id', '=', param.data.id)
          .executeTakeFirst();
        if (!person) return null;
        const sitze = await trx
          .selectFrom('person_sitz')
          .select(['sitz_typ', 'gueltig_ab', 'gueltig_bis'])
          .where('person_id', '=', person.id)
          .orderBy('gueltig_ab')
          .execute();
        return { person, sitze };
      });
      if (!ergebnis) return reply.code(404).send({ fehler: 'nicht gefunden' });
      return ergebnis;
    });

    app.put('/api/v1/personen/:id/sitz', { preHandler: nurAdmin }, async (request, reply) => {
      const param = idSchema.safeParse(request.params);
      if (!param.success) return reply.code(404).send({ fehler: 'nicht gefunden' });
      const eingabe = personSitzEingabeSchema.safeParse(request.body);
      if (!eingabe.success) {
        return reply.code(400).send({ fehler: 'ungültige Eingabe', details: eingabe.error.issues });
      }
      const s = eingabe.data;
      if (s.gueltig_bis !== null && s.gueltig_bis < s.gueltig_ab) {
        return reply.code(400).send({ fehler: 'gueltig_bis liegt vor gueltig_ab' });
      }
      const a = benutzerVon(request);
      const ok = await withMandant(db, a.mandantId, async (trx) => {
        const person = await trx
          .selectFrom('person')
          .select('id')
          .where('id', '=', param.data.id)
          .executeTakeFirst();
        if (!person) return false;
        // Offenen Vorgänger zum Vortag schließen, damit je Tag genau ein Sitz gilt.
        const vortag = new Date(Date.parse(`${s.gueltig_ab}T00:00:00Z`) - 86_400_000)
          .toISOString()
          .slice(0, 10);
        await trx
          .updateTable('person_sitz')
          .set({ gueltig_bis: vortag })
          .where('person_id', '=', person.id)
          .where('gueltig_ab', '<', s.gueltig_ab)
          .where('gueltig_bis', 'is', null)
          .execute();
        await trx
          .insertInto('person_sitz')
          .values({ ...s, person_id: person.id, mandant_id: a.mandantId })
          .onConflict((oc) =>
            oc
              .columns(['person_id', 'gueltig_ab'])
              .doUpdateSet({ sitz_typ: s.sitz_typ, gueltig_bis: s.gueltig_bis }),
          )
          .execute();
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_AKTION.sitzGeaendert,
          objekt: `person:${person.id} ${s.sitz_typ} ab ${s.gueltig_ab}`,
        });
        return true;
      });
      if (!ok) return reply.code(404).send({ fehler: 'nicht gefunden' });
      return { ok: true };
    });
  },
};
