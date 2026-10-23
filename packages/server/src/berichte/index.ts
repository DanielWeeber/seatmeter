// Modul berichte: Projektabrechnung (CSV/JSON) und Betriebsrats-Bericht (HTML/CSV/JSON), Architektur §7.
// Jeder Abruf ist ein Export und steht im `audit` („Export Projektabrechnung“, „Export Betriebsrat“).
import { monatSchema, type KalkulationAntwort, type Projektabrechnung } from '@seatmeter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle, type AnmeldungMitMandant } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { ladeAbschluss } from '../kalkulation/abschluss.js';
import { PREIS_ROLLEN } from '../kalkulation/index.js';
import { laufenderMonat } from '../kalkulation/kurs.js';
import { kalkuliereMonat } from '../kalkulation/rechnen.js';
import type { SeatmeterPlugin } from '../plugin.js';
import { betriebsratCsv, betriebsratHtml, erstelleBetriebsratBericht } from './betriebsrat.js';
import { cent, csv, dezimal, mikro, text } from './csv.js';

const TOPF_TEXT = {
  projekt: 'Projekt',
  unzugeordnet: 'unzugeordnet',
  ungenutzt: 'ungenutzt',
} as const;

/** Projektabrechnung aus dem Monatsabschluss, sonst live (Stand „vorläufig“). */
export function projektabrechnungAus(k: KalkulationAntwort, jetzt = new Date()): Projektabrechnung {
  return {
    monat: k.monat,
    stand: k.quelle === 'monatsabschluss' ? 'abgeschlossen' : 'vorlaeufig',
    erstellt: jetzt.toISOString(),
    kurs: k.kurs,
    einstellungen: k.einstellungen,
    ueberschreitung_abgezogen: k.ueberschreitung_abgezogen,
    zeilen: k.zeilen,
    summe: k.summe,
  };
}

/** CSV der Projektabrechnung: je Zeile ein Projekt bzw. Topf, am Ende die Summe. Keine Personendaten. */
export function projektabrechnungCsv(p: Projektabrechnung): string {
  const kurs = p.kurs.usd_eur === null ? '' : dezimal(p.kurs.usd_eur, 6);
  const quelle =
    p.kurs.quelle === null
      ? ''
      : `${p.kurs.quelle === 'ezb' ? 'EZB' : 'manuell'}${p.kurs.vorlaeufig ? ' (vorläufig)' : ''}`;
  const stand = p.stand === 'abgeschlossen' ? 'abgeschlossen' : 'vorläufig';
  const abgezogen = p.ueberschreitung_abgezogen ? 'ja' : 'nein';
  const kopf = [
    'Monat',
    'Stand',
    'Topf',
    'Projekt',
    'Kunde',
    'Anfragen',
    'Input-Tokens',
    'Output-Tokens',
    'Cache-Lese-Tokens',
    'Cache-Schreib-Tokens',
    'davon 1h',
    'Schattenpreis USD',
    'Sitzanteil USD',
    'Überschreitung USD',
    'Überschreitung abgezogen',
    'Projektpreis USD',
    'Kurs EUR je USD',
    'Kursquelle',
    'Projektpreis EUR',
    'Preisversion',
    'Sitzkosten-Verteilung',
  ];
  const zeilen = p.zeilen.map((z) => [
    p.monat,
    stand,
    TOPF_TEXT[z.topf],
    text(z.name),
    text(z.kunde),
    z.anfragen,
    z.tokens.input,
    z.tokens.output,
    z.tokens.cache_read,
    z.tokens.cache_write,
    z.tokens.cache_write_1h,
    mikro(z.schatten_usd_micros),
    mikro(z.sitzanteil_usd_micros),
    mikro(z.ueberschreitung_usd_micros),
    abgezogen,
    cent(z.projektpreis_usd_cent),
    kurs,
    quelle,
    cent(z.projektpreis_eur_cent),
    text(z.preis_version),
    p.einstellungen.sitzkosten_verteilung,
  ]);
  const t = p.zeilen.reduce(
    (s, z) => ({
      anfragen: s.anfragen + z.anfragen,
      input: s.input + z.tokens.input,
      output: s.output + z.tokens.output,
      cache_read: s.cache_read + z.tokens.cache_read,
      cache_write: s.cache_write + z.tokens.cache_write,
      cache_write_1h: s.cache_write_1h + z.tokens.cache_write_1h,
    }),
    { anfragen: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 },
  );
  const summe = [
    p.monat,
    stand,
    'Summe',
    '',
    '',
    t.anfragen,
    t.input,
    t.output,
    t.cache_read,
    t.cache_write,
    t.cache_write_1h,
    mikro(p.summe.schatten_usd_micros),
    mikro(p.summe.sitzanteil_usd_micros),
    mikro(p.summe.ueberschreitung_usd_micros),
    abgezogen,
    cent(p.summe.projektpreis_usd_cent),
    kurs,
    quelle,
    cent(p.summe.projektpreis_eur_cent),
    '',
    p.einstellungen.sitzkosten_verteilung,
  ];
  return csv([kopf, ...zeilen, summe]);
}

const abrechnungAbfrage = z.object({
  monat: monatSchema.optional(),
  format: z.enum(['csv', 'json']).default('csv'),
});
const betriebsratAbfrage = z.object({
  monat: monatSchema.optional(),
  format: z.enum(['html', 'csv', 'json']).default('html'),
});

export const berichtePlugin: SeatmeterPlugin = {
  name: 'kern-berichte',
  routen(app, { db }) {
    async function monatVon(a: AnmeldungMitMandant, monat: string | undefined): Promise<string> {
      if (monat) return monat;
      const m = await withMandant(db, a.mandantId, (trx) =>
        trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow(),
      );
      return laufenderMonat(m.zeitzone);
    }

    const herunterladen = (reply: FastifyReply, name: string, typ: string, inhalt: string) =>
      reply
        .header('content-type', typ)
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(inhalt);

    app.get(
      '/api/v1/berichte/projektabrechnung',
      { preHandler: requireRolle(...PREIS_ROLLEN) },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const q = abrechnungAbfrage.safeParse(request.query);
        if (!q.success) {
          return reply.code(400).send({ fehler: 'monat als JJJJ-MM, format csv oder json' });
        }
        const a = benutzerVon(request);
        const monat = await monatVon(a, q.data.monat);
        const bericht = await withMandant(db, a.mandantId, async (trx) => {
          const k =
            (await ladeAbschluss(trx, monat, a.projektIds)) ??
            (await kalkuliereMonat(trx, monat, a.projektIds));
          await protokolliere(trx, {
            benutzerId: a.benutzerId,
            aktion: AUDIT_AKTION.exportProjektabrechnung,
            objekt: `monat:${monat} format:${q.data.format}`,
          });
          return projektabrechnungAus(k);
        });
        if (q.data.format === 'json') return bericht;
        return herunterladen(
          reply,
          `projektabrechnung-${monat}.csv`,
          'text/csv; charset=utf-8',
          projektabrechnungCsv(bericht),
        );
      },
    );

    app.get(
      '/api/v1/berichte/betriebsrat',
      { preHandler: requireRolle('mandanten_admin', 'betriebsrat') },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const q = betriebsratAbfrage.safeParse(request.query);
        if (!q.success) {
          return reply.code(400).send({ fehler: 'monat als JJJJ-MM, format html, csv oder json' });
        }
        const a = benutzerVon(request);
        const monat = await monatVon(a, q.data.monat);
        const format = q.data.format;
        const bericht = await withMandant(db, a.mandantId, async (trx) => {
          const b = await erstelleBetriebsratBericht(trx, monat);
          // Ansehen (JSON-Ansicht im Dashboard, HTML-Seite im Browser) ist „Ansicht“, nur die
          // CSV-Datei ist ein „Export“. Objekt ohne Inhalte: Berichtsart, Zeitraum, Format.
          await protokolliere(
            trx,
            format === 'csv'
              ? {
                  benutzerId: a.benutzerId,
                  aktion: AUDIT_AKTION.exportBetriebsrat,
                  objekt: `monat:${monat} format:${format}`,
                }
              : {
                  benutzerId: a.benutzerId,
                  aktion: AUDIT_AKTION.ansichtBetriebsrat,
                  objekt: `bericht:betriebsrat monat:${monat} zeitraum:${b.zeitraum.von}..${b.zeitraum.bis} format:${format}`,
                },
          );
          return b;
        });
        if (q.data.format === 'json') return bericht;
        if (q.data.format === 'csv') {
          return herunterladen(
            reply,
            `betriebsrat-${monat}.csv`,
            'text/csv; charset=utf-8',
            betriebsratCsv(bericht),
          );
        }
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
          .header('cache-control', 'no-store')
          .send(betriebsratHtml(bericht));
      },
    );
  },
};
