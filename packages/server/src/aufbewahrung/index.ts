// Modul aufbewahrung (Architektur §3.5): nächtlicher Löschjob nach den Fristen `mandant.aufbewahrung_*`.
// Jeder Lauf schreibt je Mandant und Tabelle eine Zeile in `loeschlauf` (nur Anzahl und Grenze).
import { sql } from 'kysely';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { monatsanfang } from '../db/partitionen.js';
import { heuteIn, plusTage } from '../aggregation/tage.js';
import type { PluginKontext, SeatmeterPlugin } from '../plugin.js';

export interface LoeschPosten {
  mandant_id: string;
  tabelle: string;
  /** Gelöscht wurde alles vor diesem Tag. */
  bis: string;
  anzahl: number;
}

export interface AufbewahrungErgebnis {
  partitionen_geloescht: string[];
  posten: LoeschPosten[];
  sitzungen_abgelaufen: number;
  job_laeufe: number;
}

/** Tag minus n Monate (Tag bleibt, Überlauf wie Date.UTC). */
export function minusMonate(tag: string, n: number): string {
  const [j, m, t] = tag.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(j, m - 1 - n, t)).toISOString().slice(0, 10);
}

const isoTag = (d: Date) => d.toISOString().slice(0, 10);

/** Monatspartitionen von `anfrage` mit ihrem Monatsbeginn (Name `anfrage_JJJJ_MM`). */
async function anfragePartitionen(db: Db): Promise<{ name: string; ab: Date; bis: Date }[]> {
  const r = await sql<{ name: string }>`
    SELECT c.relname AS name FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'anfrage'`.execute(db);
  return r.rows.flatMap(({ name }) => {
    const m = /^anfrage_(\d{4})_(\d{2})$/.exec(name);
    if (!m) return [];
    const jahr = Number(m[1]);
    const monat = Number(m[2]);
    return [
      { name, ab: new Date(Date.UTC(jahr, monat - 1, 1)), bis: new Date(Date.UTC(jahr, monat, 1)) },
    ];
  });
}

/**
 * Löschlauf über alle Mandanten. `anfrage`: ganze Monatspartitionen per DROP, sobald der Monat für
 * alle Mandanten vollständig älter als ihre Frist ist; Mandanten mit kürzerer Frist löschen ihre
 * Zeilen ganzer Monate per DELETE. `tag_aggregat` mit Person: nach Frist auf „ohne Person“
 * zusammengefasst (Projektsummen bleiben), danach Zeilen ohne Person nach der Abschluss-Frist.
 */
export async function aufbewahrungJob(
  ctx: PluginKontext,
  jetzt: Date = new Date(),
): Promise<AufbewahrungErgebnis> {
  const { db } = ctx;
  const mandanten = await db.selectFrom('mandant').selectAll().execute();
  const posten: LoeschPosten[] = [];
  const ergebnis: AufbewahrungErgebnis = {
    partitionen_geloescht: [],
    posten,
    sitzungen_abgelaufen: 0,
    job_laeufe: 0,
  };

  // 1. anfrage: Grenze je Mandant = Beginn des Monats, in dem die Frist endet.
  const grenzen = new Map(
    mandanten.map((m) => [
      m.id,
      monatsanfang(new Date(jetzt.getTime() - m.aufbewahrung_anfrage_tage * 86_400_000)),
    ]),
  );
  const geloescht = new Map<string, number>();
  if (mandanten.length > 0) {
    const dropGrenze = Math.min(...[...grenzen.values()].map((d) => d.getTime()));
    for (const p of await anfragePartitionen(db)) {
      if (p.bis.getTime() > dropGrenze) continue;
      // Als Eigentümer: zählen je Mandant, dann die ganze Partition entfernen.
      const zaehlung = await sql<{ mandant_id: string; n: number }>`
        SELECT mandant_id, count(*) AS n FROM ${sql.table(p.name)} GROUP BY mandant_id`.execute(db);
      for (const z of zaehlung.rows) {
        geloescht.set(z.mandant_id, (geloescht.get(z.mandant_id) ?? 0) + Number(z.n));
      }
      await sql`DROP TABLE ${sql.table(p.name)}`.execute(db);
      ergebnis.partitionen_geloescht.push(p.name);
    }
  }

  for (const m of mandanten) {
    const heute = heuteIn(m.zeitzone, jetzt);
    const grenzeAnfrage = grenzen.get(m.id) as Date;
    await withMandant(db, m.id, async (trx) => {
      const neu = (tabelle: string, bis: string, anzahl: bigint | number) =>
        posten.push({ mandant_id: m.id, tabelle, bis, anzahl: Number(anzahl) });

      const anfrage = await trx
        .deleteFrom('anfrage')
        .where('ts', '<', grenzeAnfrage)
        .executeTakeFirst();
      neu(
        'anfrage',
        isoTag(grenzeAnfrage),
        (geloescht.get(m.id) ?? 0) + Number(anfrage.numDeletedRows),
      );

      // tag_aggregat mit Person: Personenbezug entfernen, Summen bleiben ohne Person erhalten.
      const grenzePerson = minusMonate(heute, m.aufbewahrung_aggregat_monate);
      await sql`
        INSERT INTO tag_aggregat (mandant_id, tag, person_id, projekt_id, model, speed, auth_klasse,
          input, output, cache_read, cache_write, cache_write_1h, web_search, anfragen,
          schatten_usd_micros, preis_version, abo_anteil)
        SELECT mandant_id, tag, NULL, projekt_id, model, speed, auth_klasse,
          sum(input), sum(output), sum(cache_read), sum(cache_write), sum(cache_write_1h),
          sum(web_search), sum(anfragen), sum(schatten_usd_micros), max(preis_version), 1
        FROM tag_aggregat WHERE person_id IS NOT NULL AND tag < ${grenzePerson}::date
        GROUP BY mandant_id, tag, projekt_id, model, speed, auth_klasse
        ON CONFLICT (mandant_id, tag, person_id, projekt_id, model, speed, auth_klasse) DO UPDATE SET
          input = tag_aggregat.input + excluded.input,
          output = tag_aggregat.output + excluded.output,
          cache_read = tag_aggregat.cache_read + excluded.cache_read,
          cache_write = tag_aggregat.cache_write + excluded.cache_write,
          cache_write_1h = tag_aggregat.cache_write_1h + excluded.cache_write_1h,
          web_search = tag_aggregat.web_search + excluded.web_search,
          anfragen = tag_aggregat.anfragen + excluded.anfragen,
          schatten_usd_micros = tag_aggregat.schatten_usd_micros + excluded.schatten_usd_micros,
          preis_version = coalesce(tag_aggregat.preis_version, excluded.preis_version)`.execute(
        trx,
      );
      const mitPerson = await trx
        .deleteFrom('tag_aggregat')
        .where('person_id', 'is not', null)
        .where('tag', '<', grenzePerson)
        .executeTakeFirst();
      neu('tag_aggregat (Person)', grenzePerson, mitPerson.numDeletedRows);

      const grenzeAbschluss = minusMonate(heute, m.aufbewahrung_abschluss_monate);
      const ohnePerson = await trx
        .deleteFrom('tag_aggregat')
        .where('tag', '<', grenzeAbschluss)
        .executeTakeFirst();
      neu('tag_aggregat', grenzeAbschluss, ohnePerson.numDeletedRows);
      const abschluss = await trx
        .deleteFrom('monatsabschluss')
        .where('monat', '<', grenzeAbschluss)
        .executeTakeFirst();
      neu('monatsabschluss', grenzeAbschluss, abschluss.numDeletedRows);
      // Issue-Aggregat (ohne Personenbezug): Frist wie der Monatsabschluss.
      const issues = await trx
        .deleteFrom('issue_aggregat')
        .where('monat', '<', grenzeAbschluss)
        .executeTakeFirst();
      neu('issue_aggregat', grenzeAbschluss, issues.numDeletedRows);

      const grenzeKontrolle = plusTage(heute, -m.aufbewahrung_kontrollsumme_tage);
      const kontrolle = await trx
        .deleteFrom('otel_kontrollsumme')
        .where('tag', '<', grenzeKontrolle)
        .executeTakeFirst();
      neu('otel_kontrollsumme', grenzeKontrolle, kontrolle.numDeletedRows);

      const grenzeStatistik = minusMonate(heute, m.aufbewahrung_statistik_monate);
      const statistik = await trx
        .deleteFrom('ingest_statistik')
        .where('tag', '<', grenzeStatistik)
        .executeTakeFirst();
      neu('ingest_statistik', grenzeStatistik, statistik.numDeletedRows);

      const grenzeAudit = minusMonate(heute, m.aufbewahrung_audit_monate);
      const audit = await trx
        .deleteFrom('audit')
        .where('ts', '<', new Date(`${grenzeAudit}T00:00:00Z`))
        .executeTakeFirst();
      neu('audit', grenzeAudit, audit.numDeletedRows);

      await trx
        .insertInto('loeschlauf')
        .values(
          posten
            .filter((p) => p.mandant_id === m.id)
            .map((p) => ({ mandant_id: m.id, tabelle: p.tabelle, bis: p.bis, anzahl: p.anzahl })),
        )
        .execute();
    });
  }

  // Mandantenfreie Tabellen: abgelaufene Dashboard-Sitzungen, Job-Protokoll älter als 90 Tage.
  const sitzungen = await db
    .deleteFrom('benutzer_sitzung')
    .where('laeuft_ab', '<', jetzt)
    .executeTakeFirst();
  ergebnis.sitzungen_abgelaufen = Number(sitzungen.numDeletedRows);
  const laeufe = await db
    .deleteFrom('job_lauf')
    .where('gestartet', '<', new Date(jetzt.getTime() - 90 * 86_400_000))
    .executeTakeFirst();
  ergebnis.job_laeufe = Number(laeufe.numDeletedRows);
  return ergebnis;
}

export const aufbewahrungPlugin: SeatmeterPlugin = {
  name: 'kern-aufbewahrung',
  jobs: [
    {
      name: 'aufbewahrung.loeschen',
      zeitplan: '45 2 * * *',
      ausfuehren: async (ctx) => {
        const e = await aufbewahrungJob(ctx);
        // Im job_lauf nur Summen je Tabelle, keine Mandanten-IDs.
        const jeTabelle: Record<string, number> = {};
        for (const p of e.posten) jeTabelle[p.tabelle] = (jeTabelle[p.tabelle] ?? 0) + p.anzahl;
        return {
          partitionen_geloescht: e.partitionen_geloescht,
          zeilen: jeTabelle,
          sitzungen_abgelaufen: e.sitzungen_abgelaufen,
          job_laeufe: e.job_laeufe,
        };
      },
    },
  ],
};
