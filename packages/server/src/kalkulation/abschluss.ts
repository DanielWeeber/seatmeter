// Monatsabschluss (Architektur §5 „Der Monatsabschluss friert die Werte ein“, §3.1 `monatsabschluss`):
// schreibt die Live-Kalkulation eines Monats je Zeile (Projekt, „unzugeordnet“, „ungenutzt“) samt Kurs,
// Einstellungen und Preisversion fest. Idempotent: ein vorhandener Abschluss bleibt, außer `erzwingen`
// (nur Mandanten-Admin per API); beides steht im `audit`.
import type { KalkulationAntwort, ProjektpreisZeile } from '@seatmeter/shared';
import { sql, type Transaction } from 'kysely';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { heuteIn } from '../aggregation/tage.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import type { PluginKontext } from '../plugin.js';
import { katalogAbschlussSchreiben } from '../projektkatalog/kosten.js';
import { monatsTag, plusMonate } from './kurs.js';
import {
  kalkuliereMonat,
  leereTokens,
  NAME_UNGENUTZT,
  NAME_UNZUGEORDNET,
  sichtbar,
  summiere,
  type ProjektSicht,
} from './rechnen.js';

type Trx = Transaction<Datenbank>;

export type AbschlussStatus = 'angelegt' | 'vorhanden' | 'ueberschrieben';

const JE_EINFUEGEN = 500;

export interface AbschlussErgebnis {
  monat: string;
  status: AbschlussStatus;
  zeilen: number;
}

/** Friert `monat` (`JJJJ-MM`) für den Mandanten ein. */
export async function schliesseMonat(
  db: Db,
  mandantId: string,
  monat: string,
  optionen: { erzwingen?: boolean; benutzerId?: string | null; jetzt?: Date } = {},
): Promise<AbschlussErgebnis> {
  return withMandant(db, mandantId, async (trx) => {
    const tag = monatsTag(monat);
    // Vor dem ersten Lesen: Zwei gleichzeitige Abschlüsse sähen sonst beide den alten Stand und schrieben beide, und die
    // Beträge stünden doppelt da.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`monatsabschluss:${mandantId}:${tag}`}, 0))`.execute(
      trx,
    );
    const vorhanden = await trx
      .selectFrom('monatsabschluss')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('monat', '=', tag)
      .executeTakeFirstOrThrow();
    const alt = Number(vorhanden.n);
    if (alt > 0 && !optionen.erzwingen) return { monat, status: 'vorhanden', zeilen: alt };

    const k = await kalkuliereMonat(trx, monat, null, optionen.jetzt);
    // Zuordnung Repo → Katalog-Projekt und deren Kosten mit einfrieren (Modul projektkatalog).
    await katalogAbschlussSchreiben(trx, mandantId, monat);
    if (alt > 0) await trx.deleteFrom('monatsabschluss').where('monat', '=', tag).execute();
    const kursText = k.kurs.usd_eur === null ? null : k.kurs.usd_eur.toFixed(6);
    // In Teilen: Ein einziges INSERT stößt ab rund 2 400 Zeilen an die Grenze von 65 535 Parametern.
    for (let i = 0; i < k.zeilen.length; i += JE_EINFUEGEN) {
      await trx
        .insertInto('monatsabschluss')
        .values(
          k.zeilen.slice(i, i + JE_EINFUEGEN).map((z) => ({
            mandant_id: mandantId,
            monat: tag,
            projekt_id: z.projekt_id,
            topf: z.topf,
            schatten_usd_micros: z.schatten_usd_micros,
            sitzanteil_usd_micros: z.sitzanteil_usd_micros,
            ueberschreitung_usd_micros: z.ueberschreitung_usd_micros,
            projektpreis_usd_micros: z.projektpreis_usd_micros,
            projektpreis_usd_cent: z.projektpreis_usd_cent,
            projektpreis_eur_cent: z.projektpreis_eur_cent,
            input: z.tokens.input,
            output: z.tokens.output,
            cache_read: z.tokens.cache_read,
            cache_write: z.tokens.cache_write,
            cache_write_1h: z.tokens.cache_write_1h,
            web_search: z.tokens.web_search,
            anfragen: z.anfragen,
            kurs: kursText,
            kurs_quelle: k.kurs.quelle,
            kurs_vorlaeufig: k.kurs.vorlaeufig,
            preis_version: z.preis_version,
            sitzkosten_verteilung: k.einstellungen.sitzkosten_verteilung,
            code_anteil_sitz: k.einstellungen.code_anteil_sitz,
            schatten_faktor: k.einstellungen.schatten_faktor,
            cache_write_annahme: k.einstellungen.cache_write_annahme,
            ueberschreitung_abgezogen: k.ueberschreitung_abgezogen,
            erzwungen: alt > 0,
          })),
        )
        .execute();
    }
    // Leerer Monat ohne Vorgänger: nichts eingefroren, kein Audit-Eintrag.
    if (alt === 0 && k.zeilen.length === 0) return { monat, status: 'angelegt', zeilen: 0 };
    await protokolliere(trx, {
      benutzerId: optionen.benutzerId ?? null,
      aktion:
        alt > 0 ? AUDIT_AKTION.monatsabschlussUeberschrieben : AUDIT_AKTION.monatsabschlussErstellt,
      objekt: `monatsabschluss:${monat} zeilen ${k.zeilen.length}`,
    });
    return { monat, status: alt > 0 ? 'ueberschrieben' : 'angelegt', zeilen: k.zeilen.length };
  });
}

/** Eingefrorene Werte eines Monats als `KalkulationAntwort` (`quelle = monatsabschluss`), sonst `null`. */
export async function ladeAbschluss(
  trx: Trx,
  monat: string,
  sicht: ProjektSicht = null,
): Promise<KalkulationAntwort | null> {
  const zeilen = await trx
    .selectFrom('monatsabschluss as m')
    .leftJoin('projekt as p', 'p.id', 'm.projekt_id')
    .selectAll('m')
    .select(['p.anzeigename', 'p.repo_name', 'p.owner', 'p.url_norm', 'p.kunde'])
    .where('m.monat', '=', monatsTag(monat))
    .execute();
  const erste = zeilen[0];
  if (!erste) return null;

  const kursWert = erste.kurs === null ? null : Number(erste.kurs);
  const ausgabe: ProjektpreisZeile[] = zeilen.map((z) => {
    const tokens = {
      ...leereTokens(),
      input: Number(z.input),
      output: Number(z.output),
      cache_read: Number(z.cache_read),
      cache_write: Number(z.cache_write),
      cache_write_1h: Number(z.cache_write_1h),
      web_search: Number(z.web_search),
    };
    tokens.gesamt = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
    return {
      topf: z.topf,
      projekt_id: z.projekt_id,
      name:
        z.topf === 'ungenutzt'
          ? NAME_UNGENUTZT
          : z.topf === 'unzugeordnet'
            ? NAME_UNZUGEORDNET
            : (z.anzeigename ??
              (z.owner && z.repo_name ? `${z.owner}/${z.repo_name}` : null) ??
              z.repo_name ??
              z.url_norm ??
              z.projekt_id ??
              ''),
      kunde: z.kunde ?? null,
      tokens,
      anfragen: Number(z.anfragen),
      schatten_usd_micros: Number(z.schatten_usd_micros),
      sitzanteil_usd_micros: Number(z.sitzanteil_usd_micros),
      ueberschreitung_usd_micros: Number(z.ueberschreitung_usd_micros),
      projektpreis_usd_micros: Number(z.projektpreis_usd_micros),
      projektpreis_usd_cent: Number(z.projektpreis_usd_cent),
      projektpreis_eur_cent:
        z.projektpreis_eur_cent === null ? null : Number(z.projektpreis_eur_cent),
      preis_version: z.preis_version,
    };
  });
  const hinweise: string[] = [];
  if (kursWert === null) hinweise.push('Abschluss ohne Kurs: EUR-Werte fehlen.');
  else if (erste.kurs_vorlaeufig) hinweise.push('Abschluss mit vorläufigem Kurs (EZB-Tageskurse).');
  if (!erste.ueberschreitung_abgezogen) {
    hinweise.push('Überschreitung nicht abgezogen (keine Abgleichsdaten für den Monat).');
  }
  if (zeilen.some((z) => z.erzwungen)) hinweise.push('Abschluss wurde erzwungen neu erstellt.');
  const sicht_zeilen = sichtbar(ausgabe, sicht);
  return {
    monat,
    quelle: 'monatsabschluss',
    eingefroren_am: new Date(erste.eingefroren_am).toISOString(),
    abgeschlossen: true,
    einstellungen: {
      sitzkosten_verteilung: erste.sitzkosten_verteilung ?? 'person',
      code_anteil_sitz: Number(erste.code_anteil_sitz ?? 1),
      schatten_faktor: Number(erste.schatten_faktor ?? 1),
      cache_write_annahme: erste.cache_write_annahme ?? '1h',
    },
    kurs: {
      monat,
      usd_eur: kursWert,
      quelle: erste.kurs_quelle,
      vorlaeufig: erste.kurs_vorlaeufig,
      aktualisiert: null,
    },
    ueberschreitung_abgezogen: erste.ueberschreitung_abgezogen,
    sitzkosten_usd_micros: null,
    zeilen: sicht_zeilen,
    summe: summiere(sicht_zeilen),
    hinweise,
  };
}

/** Job `kalkulation.monatsabschluss`: schließt je Mandant den Vormonat (Mandanten-Zeitzone). */
export async function monatsabschlussJob(
  ctx: PluginKontext,
  jetzt: Date = new Date(),
): Promise<{ mandanten: number; angelegt: number; vorhanden: number; zeilen: number }> {
  const mandanten = await ctx.db.selectFrom('mandant').select(['id', 'zeitzone']).execute();
  const summe = { mandanten: 0, angelegt: 0, vorhanden: 0, zeilen: 0 };
  for (const m of mandanten) {
    const vormonat = plusMonate(heuteIn(m.zeitzone, jetzt).slice(0, 7), -1);
    const e = await schliesseMonat(ctx.db, m.id, vormonat, { jetzt });
    summe.mandanten += 1;
    if (e.status === 'vorhanden') summe.vorhanden += 1;
    else summe.angelegt += 1;
    summe.zeilen += e.zeilen;
  }
  return summe;
}
