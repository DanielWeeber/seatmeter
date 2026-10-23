// Routen des Jira-Moduls: Verbindung und Zuordnung nur Mandanten-Admin; Kosten auch für Controller
// und Projektleiter (eigene Projekte). Das Token steht nie in Antworten, Logs oder im Audit.
import { heuteIn } from '../aggregation/tage.js';
import { antwort, sende } from '../antwort.js';
import { protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle } from '../auth/kontext.js';
import { csv, text as csvText, mikro } from '../berichte/csv.js';
import { withMandant } from '../db/mandant.js';
import type { PluginKontext } from '../plugin.js';
import {
  jiraVerbindungEingabeSchema,
  jiraZuordnungEingabeSchema,
  monatSchema,
  type JiraPruefung,
  type JiraZuordnungAntwort,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  jiraMyself,
  jiraProjekte,
  JiraFehler,
  normalisiereBasisUrl,
  type JiraClientOptionen,
} from './client.js';
import {
  positivlisteAbgleichen,
  titelSpeichern,
  verbindungLaden,
  verbindungSpeichern,
  zugangLaden,
} from './daten.js';
import { kostenBerechnen, mitTiteln, nachzuladen, titelNachladen } from './kosten.js';
import { projektAnzeigename } from '../issues/routen.js';

const ADMIN = requireRolle('mandanten_admin');
const LESEN = requireRolle('mandanten_admin', 'controller', 'projektleiter');

export const AUDIT_JIRA = {
  verbindungGespeichert: 'Jira-Verbindung gespeichert',
  verbindungGeloescht: 'Jira-Verbindung gelöscht',
  zuordnungGeaendert: 'Jira-Zuordnung geändert',
  export: 'Export Jira-Kosten',
} as const;

const kostenAbfrage = z.object({
  monat: monatSchema.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

export function jiraRouten(app: FastifyInstance, ctx: PluginKontext, o: JiraClientOptionen = {}) {
  const { db } = ctx;
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;

  app.get('/api/v1/jira/verbindung', { preHandler: ADMIN }, async (request) =>
    withMandant(db, benutzerVon(request).mandantId, (t) => verbindungLaden(t)),
  );

  app.put('/api/v1/jira/verbindung', { preHandler: ADMIN }, async (request, reply) => {
    const e = jiraVerbindungEingabeSchema.safeParse(request.body);
    if (!e.success) {
      return reply.code(400).send({
        fehler: e.error.issues[0]?.message ?? 'Eingabe ungültig',
        felder: e.error.issues.map((i) => i.path.join('.')),
      });
    }
    let basisUrl: string;
    try {
      basisUrl = normalisiereBasisUrl(e.data.basis_url, o.internErlaubt ?? false);
    } catch (f) {
      return reply
        .code(400)
        .send({ fehler: f instanceof JiraFehler ? f.message : 'Basis-URL ungültig' });
    }
    const a = benutzerVon(request);
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const ok = await verbindungSpeichern(trx, masterKey, a.mandantId, {
        basisUrl,
        art: e.data.art,
        email: e.data.benutzer_email,
        token: e.data.token,
        aktiv: e.data.aktiv,
        nurZugeordnete: e.data.nur_zugeordnete,
      });
      if (!ok) return antwort(400, { fehler: 'Token fehlt', felder: ['token'] });
      await positivlisteAbgleichen(trx);
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_JIRA.verbindungGespeichert,
        objekt: `mandant_jira art:${e.data.art}${e.data.token !== undefined ? ' token:neu' : ''}`,
      });
      return antwort(200, await verbindungLaden(trx));
    });
    return sende(reply, r);
  });

  app.delete('/api/v1/jira/verbindung', { preHandler: ADMIN }, async (request, reply) => {
    const a = benutzerVon(request);
    await withMandant(db, a.mandantId, async (trx) => {
      await trx.deleteFrom('mandant_jira').execute();
      await trx.deleteFrom('jira_issue_cache').execute();
      await positivlisteAbgleichen(trx);
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_JIRA.verbindungGeloescht,
        objekt: 'mandant_jira',
      });
    });
    return reply.code(204).send();
  });

  app.post('/api/v1/jira/verbindung/pruefen', { preHandler: ADMIN }, async (request, reply) => {
    const a = benutzerVon(request);
    const zugang = await withMandant(db, a.mandantId, (t) => zugangLaden(t, masterKey, true));
    if (!zugang) return reply.code(404).send({ fehler: 'Keine Jira-Verbindung eingerichtet' });
    let ergebnis: JiraPruefung;
    const jetzt = new Date();
    try {
      const m = await jiraMyself(zugang, o);
      ergebnis = { ok: true, konto: m.konto, fehler: null, zuletzt_geprueft: jetzt.toISOString() };
    } catch (f) {
      const fehler = f instanceof JiraFehler ? f.message : 'Prüfung fehlgeschlagen';
      request.log.warn(
        { art: f instanceof JiraFehler ? f.art : 'unbekannt' },
        'Jira-Prüfung fehlgeschlagen',
      );
      ergebnis = { ok: false, konto: null, fehler, zuletzt_geprueft: jetzt.toISOString() };
    }
    await withMandant(db, a.mandantId, (t) =>
      t
        .updateTable('mandant_jira')
        .set({ zuletzt_geprueft: jetzt, fehler: ergebnis.fehler })
        .execute(),
    );
    return ergebnis;
  });

  app.get('/api/v1/jira/projekte', { preHandler: ADMIN }, async (request, reply) => {
    const a = benutzerVon(request);
    const zugang = await withMandant(db, a.mandantId, (t) => zugangLaden(t, masterKey));
    if (!zugang) return reply.code(404).send({ fehler: 'Keine aktive Jira-Verbindung' });
    try {
      return { projekte: await jiraProjekte(zugang, o) };
    } catch (f) {
      request.log.warn(
        { art: f instanceof JiraFehler ? f.art : 'unbekannt' },
        'Jira-Projekte nicht geladen',
      );
      return reply
        .code(502)
        .send({ fehler: f instanceof JiraFehler ? f.message : 'Jira-Projekte nicht geladen' });
    }
  });

  app.get('/api/v1/jira/zuordnung', { preHandler: ADMIN }, async (request) => {
    const a = benutzerVon(request);
    return withMandant(db, a.mandantId, async (trx): Promise<JiraZuordnungAntwort> => {
      const zeilen = await trx
        .selectFrom('projekt')
        .leftJoin('projekt_jira', 'projekt_jira.projekt_id', 'projekt.id')
        .select([
          'projekt.id',
          'projekt.anzeigename',
          'projekt.repo_name',
          'projekt.owner',
          'projekt.url_norm',
          'projekt_jira.jira_projekt_schluessel',
          'projekt_jira.jira_projekt_name',
        ])
        .execute();
      const m = await trx.selectFrom('mandant').select('issue_praefixe').executeTakeFirstOrThrow();
      return {
        zuordnung: zeilen
          .map((z) => ({
            projekt_id: z.id,
            projekt_name: projektAnzeigename(z),
            jira_projekt_schluessel: z.jira_projekt_schluessel,
            jira_projekt_name: z.jira_projekt_name,
          }))
          .sort((x, y) => x.projekt_name.localeCompare(y.projekt_name)),
        issue_praefixe: m.issue_praefixe,
      };
    });
  });

  app.put('/api/v1/jira/zuordnung', { preHandler: ADMIN }, async (request, reply) => {
    const e = jiraZuordnungEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'Zuordnung ungültig' });
    const a = benutzerVon(request);
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const ids = e.data.zuordnung.map((z) => z.projekt_id);
      const bekannt = ids.length
        ? new Set(
            (await trx.selectFrom('projekt').select('id').where('id', 'in', ids).execute()).map(
              (p) => p.id,
            ),
          )
        : new Set<string>();
      const fremd = ids.filter((id) => !bekannt.has(id));
      if (fremd.length > 0)
        return antwort(400, { fehler: 'Unbekanntes Projekt', projekt_ids: fremd });
      let geaendert = 0;
      for (const z of e.data.zuordnung) {
        if (z.jira_projekt_schluessel === null) {
          const d = await trx
            .deleteFrom('projekt_jira')
            .where('projekt_id', '=', z.projekt_id)
            .executeTakeFirst();
          geaendert += Number(d.numDeletedRows);
          continue;
        }
        const werte = {
          jira_projekt_schluessel: z.jira_projekt_schluessel,
          jira_projekt_name: z.jira_projekt_name,
          geaendert: new Date(),
        };
        await trx
          .insertInto('projekt_jira')
          .values({ mandant_id: a.mandantId, projekt_id: z.projekt_id, ...werte })
          .onConflict((oc) => oc.column('projekt_id').doUpdateSet(werte))
          .execute();
        geaendert += 1;
      }
      const liste = await positivlisteAbgleichen(trx);
      await protokolliere(trx, {
        benutzerId: a.benutzerId,
        aktion: AUDIT_JIRA.zuordnungGeaendert,
        objekt: `projekt_jira zeilen:${geaendert} positivliste:${liste ? liste.join(',') : 'alle'}`,
      });
      return antwort(200, { geaendert, issue_praefixe: liste });
    });
    return sende(reply, r);
  });

  app.get('/api/v1/jira/kosten', { preHandler: LESEN }, async (request, reply) => {
    const q = kostenAbfrage.safeParse(request.query);
    if (!q.success)
      return reply.code(400).send({ fehler: 'monat als JJJJ-MM, format json oder csv' });
    const a = benutzerVon(request);
    const { roh, zugang } = await withMandant(db, a.mandantId, async (trx) => {
      const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
      const monat = q.data.monat ?? heuteIn(m.zeitzone).slice(0, 7);
      return {
        roh: await kostenBerechnen(trx, a, monat),
        zugang: await zugangLaden(trx, masterKey),
      };
    });
    // Titel außerhalb der Transaktion nachladen; Fehler blockieren die Kostenansicht nicht.
    const fehlend = nachzuladen(roh);
    let frisch: Awaited<ReturnType<typeof titelNachladen>> = { eintraege: [], fehler: null };
    if (zugang && fehlend.length > 0) {
      frisch = await titelNachladen(zugang, fehlend, o);
      if (frisch.fehler) request.log.warn('Jira-Titel nicht vollständig geladen');
    }
    const ergebnis = mitTiteln(roh, frisch.eintraege, frisch.fehler);
    await withMandant(db, a.mandantId, async (trx) => {
      if (frisch.eintraege.length > 0) await titelSpeichern(trx, a.mandantId, frisch.eintraege);
      if (q.data.format === 'csv') {
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_JIRA.export,
          objekt: `jira-kosten monat:${ergebnis.monat} format:csv`,
        });
      }
    });
    if (q.data.format === 'json') return ergebnis;
    const kopf = [
      'Monat',
      'Jira-Projekt',
      'Jira-Projektname',
      'Issue',
      'Titel',
      'Status',
      'Sitzungen',
      'Anfragen',
      'Tokens gesamt',
      'Schattenpreis USD',
    ];
    const zeilen = ergebnis.jira_projekte.flatMap((p) => [
      ...p.issues.map((i) => [
        ergebnis.monat,
        csvText(p.schluessel),
        csvText(p.name),
        csvText(i.schluessel),
        csvText(i.titel),
        csvText(i.status),
        i.sitzungen,
        i.anfragen,
        i.tokens.gesamt,
        mikro(i.schatten_usd_micros),
      ]),
      [
        ergebnis.monat,
        csvText(p.schluessel),
        csvText(p.name),
        csvText('ohne Issue'),
        '',
        '',
        '',
        p.ohne_issue.anfragen,
        p.ohne_issue.tokens.gesamt,
        mikro(p.ohne_issue.schatten_usd_micros),
      ],
    ]);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="jira-kosten-${ergebnis.monat}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv([kopf, ...zeilen]));
  });
}
