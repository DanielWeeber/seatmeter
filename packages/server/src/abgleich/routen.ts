// Routen des Abgleichs: Status, Analytics-Key (nur verschlüsselt), Lauf auslösen, Läufe mit
// Abweichungsbericht, Team-CSV mit Vorschau. Admin ändert, Controller liest (ohne Personendaten).
import {
  abgleichZeitraumSchema,
  analyticsKeyEingabeSchema,
  csvEingabeSchema,
  type AbgleichStatus,
  type CsvVorschau,
} from '@seatmeter/shared';
import { plusTage } from '../aggregation/tage.js';
import { protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import type { PluginKontext } from '../plugin.js';
import type { FastifyInstance } from 'fastify';
import {
  abgleichAnalytics,
  abgleichCsv,
  laufDto,
  LAUF_SPALTEN,
  leseCsvFuerMandant,
  setzeAnalyticsKey,
  type AbgleichOptionen,
} from './abgleich.js';

const LESEN = requireRolle('mandanten_admin', 'controller');
const ADMIN = requireRolle('mandanten_admin');
const MAX_TAGE = 92;

export const AUDIT_ABGLEICH = {
  keyGesetzt: 'Analytics-Key gesetzt',
  keyGeloescht: 'Analytics-Key gelöscht',
  laufGestartet: 'Abgleich gestartet',
  csvImportiert: 'Spend-CSV importiert',
} as const;

export function abgleichRouten(app: FastifyInstance, ctx: PluginKontext, o: AbgleichOptionen = {}) {
  const { db } = ctx;
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;

  // CSV auch als text/csv bzw. text/plain annehmen (Körpergrenze der App: 4 MB).
  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) =>
    done(null, { csv: body }),
  );

  const statusLaden = (mandantId: string) =>
    withMandant(db, mandantId, async (trx): Promise<AbgleichStatus> => {
      const m = await trx.selectFrom('mandant').select('plan').executeTakeFirstOrThrow();
      const g = await trx
        .selectFrom('mandant_geheimnis')
        .select(['analytics_key', 'analytics_key_geaendert'])
        .executeTakeFirst();
      const letzter = await trx
        .selectFrom('abgleich_lauf')
        .select(LAUF_SPALTEN)
        .orderBy('gestartet', 'desc')
        .limit(1)
        .executeTakeFirst();
      return {
        plan: m.plan,
        key_gesetzt: Boolean(g?.analytics_key),
        key_geaendert: g?.analytics_key_geaendert
          ? new Date(g.analytics_key_geaendert).toISOString()
          : null,
        letzter_lauf: letzter ? laufDto(letzter) : null,
      };
    });

  app.get('/api/v1/abgleich', { preHandler: LESEN }, async (request) =>
    statusLaden(benutzerVon(request).mandantId),
  );

  app.put('/api/v1/abgleich/analytics-key', { preHandler: ADMIN }, async (request, reply) => {
    const e = analyticsKeyEingabeSchema.safeParse(request.body);
    if (!e.success)
      return reply.code(400).send({ fehler: 'Key fehlt oder hat ein unerwartetes Format' });
    const a = benutzerVon(request);
    await withMandant(db, a.mandantId, async (trx) => {
      await setzeAnalyticsKey(trx, masterKey, a.mandantId, e.data.key);
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_ABGLEICH.keyGesetzt,
        objekt: 'mandant_geheimnis',
      });
    });
    return statusLaden(a.mandantId);
  });

  app.delete('/api/v1/abgleich/analytics-key', { preHandler: ADMIN }, async (request, reply) => {
    const a = benutzerVon(request);
    await withMandant(db, a.mandantId, async (trx) => {
      await setzeAnalyticsKey(trx, masterKey, a.mandantId, null);
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_ABGLEICH.keyGeloescht,
        objekt: 'mandant_geheimnis',
      });
    });
    return reply.code(204).send();
  });

  app.post('/api/v1/abgleich/lauf', { preHandler: ADMIN }, async (request, reply) => {
    const q = abgleichZeitraumSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ fehler: 'von/bis als JJJJ-MM-TT angeben' });
    const heute = new Date().toISOString().slice(0, 10);
    const bis = q.data.bis ?? plusTage(heute, -1);
    const von = q.data.von ?? plusTage(bis, -7);
    if (von > bis) return reply.code(400).send({ fehler: 'von liegt nach bis' });
    if (plusTage(von, MAX_TAGE) < bis)
      return reply.code(400).send({ fehler: `höchstens ${MAX_TAGE} Tage je Lauf` });
    const a = benutzerVon(request);
    await withMandant(db, a.mandantId, (trx) =>
      protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_ABGLEICH.laufGestartet,
        objekt: `${von}..${bis}`,
      }),
    );
    return abgleichAnalytics(ctx, a.mandantId, von, bis, 'api', o);
  });

  app.get('/api/v1/abgleich/laeufe', { preHandler: LESEN }, async (request) => {
    const a = benutzerVon(request);
    const zeilen = await withMandant(db, a.mandantId, (trx) =>
      trx
        .selectFrom('abgleich_lauf')
        .select(LAUF_SPALTEN)
        .orderBy('gestartet', 'desc')
        .limit(50)
        .execute(),
    );
    return { laeufe: zeilen.map(laufDto) };
  });

  app.post('/api/v1/abgleich/csv/vorschau', { preHandler: ADMIN }, async (request, reply) => {
    const e = csvEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'CSV fehlt' });
    const a = benutzerVon(request);
    const { ergebnis: r, personen } = await leseCsvFuerMandant(
      ctx,
      a.mandantId,
      e.data.csv,
      e.data.zuordnung,
      e.data.betrag_einheit,
    );
    const tage = r.zeilen.map((z) => z.tag).sort();
    const zugeordnet = personen.filter((p) => p !== null).length;
    const vorschau: CsvVorschau = {
      trennzeichen: r.trennzeichen,
      spalten: r.spalten,
      zuordnung: r.zuordnung,
      betrag_einheit: r.betragEinheit,
      zeilen: r.gesamt,
      gueltig: r.zeilen.length,
      zugeordnet,
      ohne_zuordnung: r.zeilen.length - zugeordnet,
      tage: { von: tage[0] ?? null, bis: tage[tage.length - 1] ?? null },
      summe_usd: Math.round(r.zeilen.reduce((s, z) => s + z.amountUsdMicros, 0) / 10_000) / 100,
      beispiel: r.beispiel,
      fehler: r.fehler,
    };
    return vorschau;
  });

  app.post('/api/v1/abgleich/csv', { preHandler: ADMIN }, async (request, reply) => {
    const e = csvEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'CSV fehlt' });
    const a = benutzerVon(request);
    const lauf = await abgleichCsv(
      ctx,
      a.mandantId,
      e.data.csv,
      e.data.zuordnung,
      e.data.betrag_einheit,
      'api',
    );
    if ('ungueltig' in lauf) {
      return reply.code(400).send({ fehler: 'CSV nicht importierbar', details: lauf.ungueltig });
    }
    await withMandant(db, a.mandantId, (trx) =>
      protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_ABGLEICH.csvImportiert,
        objekt: `abgleich_lauf:${lauf.id}`,
      }),
    );
    return lauf;
  });
}
