// Modul aggregation: Jobs `aggregation.tag` und `partitionen.anlegen`, Neuaufbau auf Anforderung und
// die Dashboard-Lesezugriffe (Übersicht, Projekte, Personen, Datenqualität).
import { zeitraumAbfrageSchema } from '@seatmeter/shared';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { anfragePartitionenAnlegen } from '../db/partitionen.js';
import { imJobLauf } from '../jobs/index.js';
import type { SeatmeterPlugin } from '../plugin.js';
import {
  aeltesterNeuaufbauTag,
  aggregationTagJob,
  aggregiereTage,
  AGGREGATION_TAGE,
} from './job.js';
import { dashboardRouten } from './routen.js';
import { plusTage } from './tage.js';

export * from './job.js';
export { dashboardRouten, MINDESTGRUPPE } from './routen.js';

/** Höchstens so viele Tage je Neuaufbau auf Anforderung. */
const MAX_TAGE_ANFORDERUNG = 400;

export const aggregationPlugin: SeatmeterPlugin = {
  name: 'kern-aggregation',
  jobs: [
    {
      name: 'aggregation.tag',
      zeitplan: '15 2 * * *',
      ausfuehren: (ctx) => aggregationTagJob(ctx),
    },
    {
      name: 'partitionen.anlegen',
      zeitplan: '5 0 * * *',
      ausfuehren: async (ctx) => ({ partitionen: await anfragePartitionenAnlegen(ctx.db) }),
    },
  ],
  routen(app, ctx) {
    dashboardRouten(app, ctx);

    // Neuaufbau für den eigenen Mandanten, z. B. nach Preisänderungen (Standard: letzte 35 Tage).
    app.post(
      '/api/v1/jobs/aggregation/tag',
      { preHandler: requireRolle('mandanten_admin') },
      async (request, reply) => {
        const q = zeitraumAbfrageSchema.safeParse(request.query);
        if (!q.success) return reply.code(400).send({ fehler: 'von/bis als JJJJ-MM-TT angeben' });
        const a = benutzerVon(request);
        const { heute, ab } = await aeltesterNeuaufbauTag(ctx.db, a.mandantId);
        const bis = q.data.bis && q.data.bis < heute ? q.data.bis : heute;
        let von = q.data.von ?? plusTage(bis, -(AGGREGATION_TAGE - 1));
        // Vor der Anfrage-Aufbewahrung fehlen Einzelanfragen: dort nicht neu aufbauen (sonst Verlust).
        if (von < ab) von = ab;
        if (von > bis) return reply.code(400).send({ fehler: 'von liegt nach bis', von, bis });
        if (von < plusTage(bis, -(MAX_TAGE_ANFORDERUNG - 1))) {
          return reply.code(400).send({ fehler: `höchstens ${MAX_TAGE_ANFORDERUNG} Tage` });
        }
        const lauf = await imJobLauf(ctx, 'aggregation.tag', 'api', () =>
          aggregiereTage(ctx.db, a.mandantId, von, bis),
        );
        if (lauf.status === 'uebersprungen') {
          return reply.code(409).send({ fehler: 'Aggregation läuft gerade' });
        }
        if (lauf.status === 'fehler')
          return reply.code(500).send({ fehler: 'Aggregation fehlgeschlagen' });
        await withMandant(ctx.db, a.mandantId, (trx) =>
          protokolliere(trx, {
            benutzerId: a.benutzerId,
            aktion: AUDIT_AKTION.aggregationAngestossen,
            objekt: `tag_aggregat ${von}..${bis}`,
          }),
        );
        return { von, bis, ...(lauf.ergebnis as object) };
      },
    );
  },
};
