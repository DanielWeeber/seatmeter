// Ablauf der Notfall-CLI `katalog:stufe` (ohne Prozess-Umgebung, damit Tests ihn direkt aufrufen können): setzt die
// Stufe der Projektwahl ohne Anmeldung. Fällt der Identitätsanbieter aus, kommt niemand mehr auf die Auswahlseite
// und auch kein Admin ins Dashboard; dann schaltet das hier den Block ab.
import { parseArgs } from 'node:util';
import { KATALOG_HINDERUNG_TEXT, katalogStufeSchema } from '@seatmeter/shared';
import { protokolliere } from '../audit/protokoll.js';
import type { Konfiguration } from '../config.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { AUDIT_KATALOG } from './audit.js';
import { projektwahlHinderung, stufeSetzen } from './stufe.js';

export interface StufeCliUmgebung {
  db: Db;
  konfiguration: Konfiguration;
  ausgabe: (zeile: string) => void;
  fehler: (zeile: string) => void;
}

export async function stufeCli(argumente: readonly string[], u: StufeCliUmgebung): Promise<number> {
  const scheitern = (meldung: string) => {
    u.fehler(JSON.stringify({ fehler: meldung }));
    return 1;
  };
  let werte;
  try {
    werte = parseArgs({
      args: [...argumente],
      options: { mandant: { type: 'string' }, stufe: { type: 'string' } },
      strict: true,
    }).values;
  } catch (f) {
    return scheitern((f as Error).message);
  }
  if (!werte.mandant) return scheitern('--mandant <slug> fehlt');
  const stufe = katalogStufeSchema.safeParse(werte.stufe);
  if (!stufe.success) return scheitern('--stufe aus|warnen|blockieren fehlt');
  const hinderung = projektwahlHinderung(u.konfiguration);
  if (stufe.data !== 'aus' && hinderung) return scheitern(KATALOG_HINDERUNG_TEXT[hinderung]);
  try {
    const m = await u.db
      .selectFrom('mandant')
      .select('id')
      .where('slug', '=', werte.mandant)
      .executeTakeFirst();
    if (!m) return scheitern('Mandant unbekannt');
    await withMandant(u.db, m.id, async (trx) => {
      await stufeSetzen(trx, m.id, stufe.data);
      await protokolliere(trx, {
        benutzerId: null,
        aktion: AUDIT_KATALOG.einstellungGeaendert,
        objekt: `stufe:${stufe.data} ausloeser:cli`,
      });
    });
    u.ausgabe(JSON.stringify({ stufe: stufe.data }));
    return 0;
  } catch (f) {
    return scheitern((f as Error).message);
  }
}
