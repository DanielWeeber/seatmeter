// Ordner ohne Git-Remote: Der verwaltete Hook meldet für solche Ordner den Schlüssel `local-<Pfad relativ zum
// Home-Ordner>`. Daraus wird beim ersten Mal ein gewöhnliches seatmeter-Projekt (Provider `pfad`, Anzeigename
// `Ordner <Pfad>`), und `sitzung_ordner` hält, in welchem Ordner die Sitzung lief (erste Meldung gilt). Der Ingest
// rechnet spätere Anfragen ohne Repo darüber zu; frühere Anfragen derselben Sitzung trägt `ordnerNachtragen` nach.
// Nachgetragen wird nur im Fenster des nächtlichen Neuaufbaus und nie in einem abgeschlossenen Monat; die betroffenen
// Tage baut danach ein Neuaufbau im Hintergrund neu auf, damit `tag_aggregat` und `anfrage` nicht auseinanderlaufen.
import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import { AGGREGATION_TAGE, aggregiereTage } from '../aggregation/job.js';
import { aggregationSperreVersuchen } from '../aggregation/sperre.js';
import { protokolliere } from '../audit/protokoll.js';
import { heuteIn, plusTage } from '../aggregation/tage.js';
import { ordnerProjektAufloesen } from '../ingest-gemeinsam/speichern.js';
import { AUDIT_KATALOG } from './audit.js';
import type { KatalogTrx } from './daten.js';

export interface OrdnerStand {
  /** Projekt des Ordners, in dem die Sitzung zuerst gemeldet wurde. */
  projektId: string;
  /** Dessen Schlüssel (`local-…`) für den Link der Projektwahl. */
  schluessel: string;
  /** Tage (Mandanten-Zeitzone), deren Anfragen eben nachgetragen wurden. */
  tage: string[];
}

/**
 * Sitzung dem Ordner zuordnen (legt das Projekt beim ersten Mal an) und frühere Anfragen der Sitzung nachtragen.
 * Lief die Sitzung schon in einem anderen Ordner, bleibt es bei diesem. Hat die Sitzung eine Wahl je Sitzung
 * (`sitzung_katalog`, älterer Hook) und der Ordner noch keine Zuordnung, wird diese Wahl die des Ordners: Sonst verlöre
 * das gewählte Katalog-Projekt mit dem Nachtrag die Kosten der Sitzung, und der Hook fragte erneut.
 */
export async function ordnerSitzungMerken(
  trx: KatalogTrx,
  o: { mandantId: string; projektSalt: Buffer; sessionId: string; schluessel: string },
): Promise<OrdnerStand> {
  const gemeldet = await ordnerProjektAufloesen(trx, o, o.schluessel);
  await trx
    .insertInto('sitzung_ordner')
    .values({ mandant_id: o.mandantId, session_id: o.sessionId, projekt_id: gemeldet })
    .onConflict((oc) => oc.columns(['mandant_id', 'session_id']).doNothing())
    .execute();
  const z = await trx
    .selectFrom('sitzung_ordner')
    .innerJoin('projekt', 'projekt.id', 'sitzung_ordner.projekt_id')
    .select(['sitzung_ordner.projekt_id', 'projekt.url_norm'])
    .where('sitzung_ordner.mandant_id', '=', o.mandantId)
    .where('sitzung_ordner.session_id', '=', o.sessionId)
    .executeTakeFirstOrThrow();
  const wahl = await trx
    .selectFrom('sitzung_katalog')
    .innerJoin('katalog_projekt', 'katalog_projekt.id', 'sitzung_katalog.katalog_projekt_id')
    .select(['sitzung_katalog.katalog_projekt_id', 'katalog_projekt.externe_id'])
    .where('sitzung_katalog.mandant_id', '=', o.mandantId)
    .where('sitzung_katalog.session_id', '=', o.sessionId)
    .executeTakeFirst();
  if (wahl) {
    const neu = await trx
      .insertInto('projekt_katalog')
      .values({
        mandant_id: o.mandantId,
        projekt_id: z.projekt_id,
        katalog_projekt_id: wahl.katalog_projekt_id,
      })
      .onConflict((oc) => oc.column('projekt_id').doNothing())
      .returning('projekt_id')
      .executeTakeFirst();
    if (neu) {
      await protokolliere(trx, {
        benutzerId: null,
        aktion: AUDIT_KATALOG.projektGewaehlt,
        objekt: `projekt:${z.projekt_id} katalog:${wahl.externe_id} (Wahl der Sitzung übernommen)`,
      });
    }
  }
  const tage = await ordnerNachtragen(trx, o.mandantId, o.sessionId, z.projekt_id);
  return { projektId: z.projekt_id, schluessel: z.url_norm ?? o.schluessel, tage };
}

/**
 * Frühere Anfragen der Sitzung ohne Projekt dem Ordner-Projekt zurechnen. Nur Tage, die der nächtliche Lauf noch neu
 * aufbaut (35 Tage), und nur Monate ohne Monatsabschluss: Ein abgeschlossener Monat bleibt, wie er ist. Anfragen mit
 * Repo oder Pfad-Projekt behalten ihr Projekt; doppelt zählt nichts, denn jede Anfrage hat genau ein Projekt.
 * Läuft gerade eine Aggregation oder ein Monatsabschluss für den Mandanten (Sperre belegt), wird nicht nachgetragen:
 * Sonst könnte ein Monat geändert werden, den ein noch offener Abschluss gerade festschreibt. Die nächste Meldung der
 * Sitzung (spätestens nach Ablauf der Marke im Hook) holt es nach.
 */
export async function ordnerNachtragen(
  trx: KatalogTrx,
  mandantId: string,
  sessionId: string,
  projektId: string,
): Promise<string[]> {
  if (!(await aggregationSperreVersuchen(trx, mandantId))) return [];
  const m = await trx.selectFrom('mandant').select('zeitzone').executeTakeFirstOrThrow();
  const ab = plusTage(heuteIn(m.zeitzone), -(AGGREGATION_TAGE - 1));
  const geaendert = await sql<{ tag: string }>`
    UPDATE anfrage SET projekt_id = ${projektId}::uuid
    WHERE mandant_id = ${mandantId}::uuid
      AND session_id = ${sessionId}
      AND projekt_id IS NULL
      AND tag >= ${ab}::date
      AND ts >= ${ab}::date - interval '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM monatsabschluss ma
        WHERE ma.mandant_id = anfrage.mandant_id
          AND ma.monat = date_trunc('month', anfrage.tag)::date)
    RETURNING to_char(tag, 'YYYY-MM-DD') AS tag`.execute(trx);
  await trx
    .updateTable('sitzung')
    .set({ projekt_id: projektId })
    .where('mandant_id', '=', mandantId)
    .where('session_id', '=', sessionId)
    .where('projekt_id', 'is', null)
    .execute();
  return [...new Set(geaendert.rows.map((r) => r.tag))].sort();
}

const laufend = new Set<Promise<unknown>>();

/**
 * Baut die Tage mit nachgetragenen Anfragen im Hintergrund neu auf (nach dem Commit aufrufen). Die Prüf-Route wartet
 * nicht darauf, der Hook hat nur zwei Sekunden. Scheitert es, holt der nächtliche Lauf es nach.
 */
export function ordnerNeuaufbauStarten(
  db: Db,
  mandantId: string,
  tage: readonly string[],
  fehler: (f: unknown) => void,
): void {
  const von = tage[0];
  const bis = tage[tage.length - 1];
  if (!von || !bis) return;
  const p = aggregiereTage(db, mandantId, von, bis)
    .catch(fehler)
    .finally(() => laufend.delete(p));
  laufend.add(p);
}

/** Für Tests und das Herunterfahren: wartet, bis laufende Neuaufbauten fertig sind. */
export async function ordnerNeuaufbauAbwarten(): Promise<void> {
  while (laufend.size > 0) await Promise.allSettled([...laufend]);
}
