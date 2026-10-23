// Modul mandant: Einstellungen des aktiven Mandanten (Architektur §3.1 `mandant`, §5, §7).
// Lesen dürfen alle Rollen, ändern nur Mandanten-Admins; jede Änderung steht je Feld im `audit`.
import { mandantEinstellungenEingabeSchema, type MandantEinstellungen } from '@seatmeter/shared';
import type { Transaction } from 'kysely';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireBenutzer, requireRolle } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import type { SeatmeterPlugin } from '../plugin.js';

type Trx = Transaction<Datenbank>;

const FELDER = [
  'zeitzone',
  'waehrung',
  'sitzkosten_verteilung',
  'code_anteil_sitz',
  'schatten_faktor',
  'cache_write_annahme',
  'auswertungsstufe',
  'klarnamen_aktiv',
  'ratenlimit_otlp',
  'ratenlimit_agent',
] as const;

export async function ladeEinstellungen(trx: Trx): Promise<MandantEinstellungen> {
  const m = await trx.selectFrom('mandant').select(FELDER).executeTakeFirstOrThrow();
  return {
    zeitzone: m.zeitzone,
    waehrung: m.waehrung === 'USD' ? 'USD' : 'EUR',
    sitzkosten_verteilung: m.sitzkosten_verteilung,
    code_anteil_sitz: Number(m.code_anteil_sitz),
    schatten_faktor: Number(m.schatten_faktor),
    cache_write_annahme: m.cache_write_annahme,
    auswertungsstufe: Number(m.auswertungsstufe),
    klarnamen_aktiv: m.klarnamen_aktiv,
    ratenlimit_otlp: m.ratenlimit_otlp,
    ratenlimit_agent: m.ratenlimit_agent,
  };
}

/** numeric(6,4): auf 4 Nachkommastellen runden, damit Vergleich und Audit stimmen. */
const vierStellen = (w: number) => Math.round(w * 10_000) / 10_000;

export const mandantPlugin: SeatmeterPlugin = {
  name: 'kern-mandant',
  routen(app, { db }) {
    app.get('/api/v1/mandant/einstellungen', { preHandler: requireBenutzer }, async (request) => {
      const a = benutzerVon(request);
      return withMandant(db, a.mandantId, (trx) => ladeEinstellungen(trx));
    });

    app.put(
      '/api/v1/mandant/einstellungen',
      { preHandler: requireRolle('mandanten_admin') },
      async (request, reply) => {
        const eingabe = mandantEinstellungenEingabeSchema.safeParse(request.body);
        if (!eingabe.success) {
          return reply
            .code(400)
            .send({ fehler: 'ungültige Eingabe', details: eingabe.error.issues });
        }
        const neu = { ...eingabe.data };
        if (neu.code_anteil_sitz !== undefined)
          neu.code_anteil_sitz = vierStellen(neu.code_anteil_sitz);
        if (neu.schatten_faktor !== undefined)
          neu.schatten_faktor = vierStellen(neu.schatten_faktor);
        const a = benutzerVon(request);
        return withMandant(db, a.mandantId, async (trx) => {
          const alt = await ladeEinstellungen(trx);
          const geaendert = FELDER.filter((f) => neu[f] !== undefined && neu[f] !== alt[f]);
          if (geaendert.length === 0) return alt;
          const werte: Record<string, unknown> = {};
          for (const f of geaendert) werte[f] = neu[f];
          await trx.updateTable('mandant').set(werte).execute();
          for (const f of geaendert) {
            await protokolliere(trx, {
              benutzerId: a.benutzerId,
              aktion: AUDIT_AKTION.einstellungGeaendert,
              objekt: `mandant.${f}: ${String(alt[f])} → ${String(neu[f])}`,
            });
          }
          return ladeEinstellungen(trx);
        });
      },
    );
  },
};
