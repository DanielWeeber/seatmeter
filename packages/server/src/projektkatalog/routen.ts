// Routen des Projektkatalogs: Import und Schalter nur Mandanten-Admin; Zuordnung auch Projektleiter (nur
// eigene Projekte); Kosten zusätzlich Controller. Der Katalog wird nur gelesen, nie zurückgeschrieben.
import {
  KATALOG_DATEI_MAX_BYTES,
  KATALOG_HINDERUNG_TEXT,
  KATALOG_TEXT_KODIERUNG,
  katalogCsvEingabeSchema,
  katalogEinstellungEingabeSchema,
  katalogImportEingabeSchema,
  katalogZuordnungEingabeSchema,
  kennzahlenMitWerten,
  monatSchema,
} from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { heuteIn } from '../aggregation/tage.js';
import { antwort, sende } from '../antwort.js';
import { protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle, type AnmeldungMitMandant } from '../auth/kontext.js';
import { csv, text as csvText, mikroGenau } from '../berichte/csv.js';
import { withMandant } from '../db/mandant.js';
import type { PluginKontext } from '../plugin.js';
import { einstellungLaden, projekteLaden, zuordnungLaden } from './daten.js';
import { AUDIT_KATALOG } from './audit.js';
import { katalogImportieren } from './importieren.js';
import { kostenBerechnen } from './kosten.js';
import { csvQuelle, listenQuelle, QuelleFehler } from './quelle.js';
import { einstellungSetzen, projektwahlHinderung } from './stufe.js';
import { syncPuffer } from './sync.js';

/**
 * Körpergrenze des Dashboard-Imports: Die Datei kommt als JSON-Text, Anführungszeichen und Umbrüche werden dabei länger.
 * Die Grenze der Datei selbst prüft die Route, damit im Dashboard dieselbe gilt wie beim Upload.
 */
const CSV_JSON_KOERPER_MAX = 2 * KATALOG_DATEI_MAX_BYTES + 64 * 1024;

const ADMIN = requireRolle('mandanten_admin');
const ZUORDNEN = requireRolle('mandanten_admin', 'projektleiter');
const LESEN = requireRolle('mandanten_admin', 'controller', 'projektleiter');

const kostenAbfrage = z.object({
  monat: monatSchema.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

const projekteAbfrage = z.object({ aktiv: z.enum(['0', '1']).default('1') });
/** In der Spalte Repo der Zeile je Projekt, die keine Nutzung trägt. */
const CSV_PROJEKTZEILE = 'Projektzeile';

/**
 * Welche Repos die Anmeldung zuordnen darf; `null` = alle. Nur Mandanten-Admins dürfen alle: `projektIds` ist auch
 * bei Mischrollen `null` (z. B. Projektleitung plus Controlling), das heißt hier nicht „alle“.
 */
function zuordnungsSicht(a: AnmeldungMitMandant): readonly string[] | null {
  return a.rollen.includes('mandanten_admin') ? null : (a.projektIds ?? []);
}

export function katalogRouten(app: FastifyInstance, ctx: PluginKontext) {
  const { db } = ctx;

  app.get('/api/v1/projektkatalog/einstellung', { preHandler: ADMIN }, async (request) => {
    await syncPuffer(db).leeren();
    return withMandant(db, benutzerVon(request).mandantId, (t) =>
      einstellungLaden(t, ctx.konfiguration),
    );
  });

  app.put('/api/v1/projektkatalog/einstellung', { preHandler: ADMIN }, async (request, reply) => {
    const e = katalogEinstellungEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'Einstellung ungültig' });
    const hinderung = projektwahlHinderung(ctx.konfiguration);
    if (e.data.stufe !== undefined && e.data.stufe !== 'aus' && hinderung) {
      return reply.code(409).send({ fehler: KATALOG_HINDERUNG_TEXT[hinderung], hinderung });
    }
    const a = benutzerVon(request);
    return withMandant(db, a.mandantId, async (trx) => {
      await einstellungSetzen(trx, a.mandantId, e.data);
      const teile = [
        ...(e.data.stufe ? [`stufe:${e.data.stufe}`] : []),
        ...(e.data.sync_warnung_stunden !== undefined
          ? [`sync_warnung_stunden:${e.data.sync_warnung_stunden ?? 'aus'}`]
          : []),
        ...(e.data.sync_deaktivieren_tage !== undefined
          ? [`sync_deaktivieren_tage:${e.data.sync_deaktivieren_tage ?? 'aus'}`]
          : []),
        ...(e.data.sync_deaktivieren_max_prozent !== undefined
          ? [`sync_deaktivieren_max_prozent:${e.data.sync_deaktivieren_max_prozent}`]
          : []),
        ...(e.data.inaktiv_status !== undefined ? ['inaktiv_status'] : []),
        // Nur dass er sich geändert hat, nicht der Wert.
        ...(e.data.kontakt !== undefined ? ['kontakt'] : []),
      ];
      if (teile.length > 0) {
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_KATALOG.einstellungGeaendert,
          objekt: teile.join(' '),
        });
      }
      return einstellungLaden(trx, ctx.konfiguration);
    });
  });

  app.post('/api/v1/projektkatalog/import', { preHandler: ADMIN }, async (request, reply) => {
    const e = katalogImportEingabeSchema.safeParse(request.body);
    if (!e.success) {
      return reply.code(400).send({
        fehler: 'Projektliste ungültig',
        felder: e.error.issues.slice(0, 20).map((i) => i.path.join('.')),
      });
    }
    const a = benutzerVon(request);
    return katalogImportieren(db, a.mandantId, listenQuelle('json', e.data.projekte), {
      vollstaendig: e.data.vollstaendig,
      trockenlauf: e.data.trockenlauf,
      benutzerId: a.benutzerId,
      ausloeser: 'konto',
    });
  });

  app.post(
    '/api/v1/projektkatalog/import/csv',
    { preHandler: ADMIN, bodyLimit: CSV_JSON_KOERPER_MAX },
    async (request, reply) => {
      const e = katalogCsvEingabeSchema.safeParse(request.body);
      if (!e.success) {
        const kodierung = e.error.issues.some((i) => i.message === KATALOG_TEXT_KODIERUNG);
        return reply
          .code(400)
          .send({ fehler: kodierung ? KATALOG_TEXT_KODIERUNG : 'CSV fehlt oder Angaben ungültig' });
      }
      if (Buffer.byteLength(e.data.csv) > KATALOG_DATEI_MAX_BYTES) {
        return reply.code(413).send({
          fehler: `Die Datei ist größer als ${KATALOG_DATEI_MAX_BYTES / (1024 * 1024)} MB.`,
        });
      }
      const a = benutzerVon(request);
      try {
        return await katalogImportieren(
          db,
          a.mandantId,
          csvQuelle(e.data.csv, { trennzeichen: e.data.trennzeichen, spalten: e.data.spalten }),
          {
            vollstaendig: e.data.vollstaendig,
            trockenlauf: e.data.trockenlauf,
            benutzerId: a.benutzerId,
            ausloeser: 'konto',
          },
        );
      } catch (f) {
        if (f instanceof QuelleFehler) return reply.code(400).send({ fehler: f.message });
        throw f;
      }
    },
  );

  app.get('/api/v1/projektkatalog/projekte', { preHandler: ZUORDNEN }, async (request, reply) => {
    const q = projekteAbfrage.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ fehler: 'aktiv als 0 oder 1' });
    return withMandant(db, benutzerVon(request).mandantId, async (t) => ({
      projekte: await projekteLaden(t, q.data.aktiv === '1'),
    }));
  });

  app.get('/api/v1/projektkatalog/zuordnung', { preHandler: ZUORDNEN }, async (request) => {
    const a = benutzerVon(request);
    return withMandant(db, a.mandantId, (t) => zuordnungLaden(t, zuordnungsSicht(a)));
  });

  app.put('/api/v1/projektkatalog/zuordnung', { preHandler: ZUORDNEN }, async (request, reply) => {
    const e = katalogZuordnungEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'Zuordnung ungültig' });
    const a = benutzerVon(request);
    const sicht = zuordnungsSicht(a);
    if (sicht !== null) {
      const eigene = new Set(sicht);
      if (e.data.zuordnung.some((z) => !eigene.has(z.projekt_id))) {
        return reply.code(403).send({ fehler: 'Nur eigene Projekte' });
      }
    }
    const r = await withMandant(db, a.mandantId, async (trx) => {
      const ids = e.data.zuordnung.map((z) => z.projekt_id);
      const bekannt = new Set(
        (await trx.selectFrom('projekt').select('id').where('id', 'in', ids).execute()).map(
          (p) => p.id,
        ),
      );
      const fremd = ids.filter((id) => !bekannt.has(id));
      if (fremd.length > 0) {
        return antwort(400, { fehler: 'Unbekanntes Projekt', projekt_ids: fremd });
      }
      const ziele = e.data.zuordnung.flatMap((z) =>
        z.katalog_projekt_id ? [z.katalog_projekt_id] : [],
      );
      const katalog = ziele.length
        ? await trx
            .selectFrom('katalog_projekt')
            .select(['id', 'aktiv'])
            .where('id', 'in', ziele)
            .execute()
        : [];
      const aktiv = new Map(katalog.map((k) => [k.id, k.aktiv]));
      const vorher = new Map(
        (
          await trx
            .selectFrom('projekt_katalog')
            .select(['projekt_id', 'katalog_projekt_id'])
            .where('projekt_id', 'in', ids)
            .execute()
        ).map((z) => [z.projekt_id, z.katalog_projekt_id]),
      );
      for (const z of e.data.zuordnung) {
        if (!z.katalog_projekt_id) continue;
        if (!aktiv.has(z.katalog_projekt_id)) {
          return antwort(400, { fehler: 'Unbekanntes Katalog-Projekt' });
        }
        // Inaktive Projekte lassen sich nicht neu wählen; eine bestehende Zuordnung darf bleiben.
        if (!aktiv.get(z.katalog_projekt_id) && vorher.get(z.projekt_id) !== z.katalog_projekt_id) {
          return antwort(400, { fehler: 'Katalog-Projekt ist inaktiv' });
        }
      }
      let geaendert = 0;
      for (const z of e.data.zuordnung) {
        if ((vorher.get(z.projekt_id) ?? null) === z.katalog_projekt_id) continue;
        if (z.katalog_projekt_id === null) {
          await trx.deleteFrom('projekt_katalog').where('projekt_id', '=', z.projekt_id).execute();
        } else {
          const werte = { katalog_projekt_id: z.katalog_projekt_id, geaendert: new Date() };
          await trx
            .insertInto('projekt_katalog')
            .values({ mandant_id: a.mandantId, projekt_id: z.projekt_id, ...werte })
            .onConflict((oc) => oc.column('projekt_id').doUpdateSet(werte))
            .execute();
        }
        geaendert += 1;
      }
      if (geaendert > 0) {
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_KATALOG.zuordnungGeaendert,
          objekt: `projekt_katalog zeilen:${geaendert}`,
        });
      }
      return antwort(200, { geaendert });
    });
    return sende(reply, r);
  });

  app.get('/api/v1/projektkatalog/kosten', { preHandler: LESEN }, async (request, reply) => {
    const q = kostenAbfrage.safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({ fehler: 'monat als JJJJ-MM, format json oder csv' });
    }
    const a = benutzerVon(request);
    const ergebnis = await withMandant(db, a.mandantId, async (trx) => {
      const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
      const monat = q.data.monat ?? heuteIn(m.zeitzone).slice(0, 7);
      const k = await kostenBerechnen(trx, a.projektIds, monat);
      if (q.data.format === 'csv') {
        await protokolliere(trx, {
          benutzerId: a.benutzerId,
          aktion: AUDIT_KATALOG.export,
          objekt: `katalog-kosten monat:${k.monat} format:csv`,
        });
      }
      return k;
    });
    if (q.data.format === 'json') return ergebnis;
    const kopf = [
      'Monat',
      'Projektnummer',
      'Externe ID',
      'Projektname',
      'Kunde',
      'Repo',
      'Sitzungen ohne Repo',
      'Anfragen',
      'Tokens gesamt',
      'Schattenpreis USD',
      'Eltern-ID',
      'Summe mit Unterprojekten USD (nicht addieren)',
    ];
    const zeilen = ergebnis.projekte.flatMap((p) => {
      // Der Pfad als Bezeichnung: `Webshop › AP Login`. Die Betragsspalten zählen nur das Eigene und ergeben die Summe der
      // Seite. Die Projektzeile trägt Hierarchie und Summe und lässt die Betragsspalten leer.
      const anfang = [
        ergebnis.monat,
        csvText(p.nummer),
        csvText(p.externe_id),
        csvText(p.pfad),
        csvText(p.kunde),
      ];
      return [
        [
          ...anfang,
          csvText(CSV_PROJEKTZEILE),
          '',
          '',
          '',
          '',
          csvText(p.eltern_externe_id),
          mikroGenau(p.summe.schatten_usd_micros),
        ],
        ...p.repos.map((r) => [
          ...anfang,
          csvText(r.name),
          '',
          r.anfragen,
          r.tokens.gesamt,
          mikroGenau(r.schatten_usd_micros),
          '',
          '',
        ]),
        ...(p.sitzungen_ohne_repo > 0
          ? [
              [
                ...anfang,
                csvText('ohne Repo'),
                p.sitzungen_ohne_repo,
                p.ohne_repo.anfragen,
                p.ohne_repo.tokens.gesamt,
                mikroGenau(p.ohne_repo.schatten_usd_micros),
                '',
                '',
              ],
            ]
          : []),
      ];
    });
    // Ohne Projektnummer: was noch keinem Projekt zugeordnet ist, damit die Datei die Summe der Seite ergibt.
    const offenAnfang = [ergebnis.monat, csvText(''), csvText(''), csvText(''), csvText('')];
    zeilen.push(
      ...ergebnis.offen.repos.map((r) => [
        ...offenAnfang,
        csvText(r.name),
        '',
        r.anfragen,
        r.tokens.gesamt,
        mikroGenau(r.schatten_usd_micros),
        '',
        '',
      ]),
    );
    // Auch ein Betrag ohne Anfragen, sonst stimmt die Datei nicht mehr mit der Summe der Seite überein.
    if (kennzahlenMitWerten(ergebnis.offen.ohne_repo)) {
      const o = ergebnis.offen.ohne_repo;
      zeilen.push([
        ...offenAnfang,
        csvText('ohne Repo'),
        '',
        o.anfragen,
        o.tokens.gesamt,
        mikroGenau(o.schatten_usd_micros),
        '',
        '',
      ]);
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="projektkatalog-kosten-${ergebnis.monat}.csv"`,
      )
      .header('cache-control', 'no-store')
      .send(csv([kopf, ...zeilen]));
  });
}
