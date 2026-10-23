// Modul audit: Helfer `protokolliere` und GET /api/v1/audit (Mandanten-Admin, Betriebsrat).
import { auditAbfrageSchema, type AuditEintrag } from '@seatmeter/shared';
import { benutzerVon, requireRolle } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import type { SeatmeterPlugin } from '../plugin.js';

export * from './protokoll.js';

export const auditPlugin: SeatmeterPlugin = {
  name: 'kern-audit',
  routen(app, { db }) {
    app.get(
      '/api/v1/audit',
      { preHandler: requireRolle('mandanten_admin', 'betriebsrat') },
      async (request, reply) => {
        const abfrage = auditAbfrageSchema.safeParse(request.query);
        if (!abfrage.success) return reply.code(400).send({ fehler: 'ungültige Abfrage' });
        const { von, bis, limit, vor_id } = abfrage.data;
        const a = benutzerVon(request);
        const zeilen = await withMandant(db, a.mandantId, (trx) => {
          let q = trx
            .selectFrom('audit as a')
            .leftJoin('benutzer as b', 'b.id', 'a.benutzer_id')
            .select(['a.id', 'a.ts', 'a.benutzer_id', 'b.benutzername', 'a.aktion', 'a.objekt'])
            .orderBy('a.id', 'desc')
            .limit(limit);
          if (von) q = q.where('a.ts', '>=', new Date(`${von}T00:00:00Z`));
          if (bis) q = q.where('a.ts', '<', new Date(Date.parse(`${bis}T00:00:00Z`) + 86_400_000));
          if (vor_id) q = q.where('a.id', '<', vor_id);
          return q.execute();
        });
        const eintraege: AuditEintrag[] = zeilen.map((z) => ({
          id: Number(z.id),
          ts: new Date(z.ts).toISOString(),
          benutzer_id: z.benutzer_id,
          benutzername: z.benutzername,
          aktion: z.aktion,
          objekt: z.objekt,
        }));
        return { eintraege };
      },
    );
  },
};
