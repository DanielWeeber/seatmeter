// Speichern der ausgewerteten OTLP-Daten (Quelle A): Abo-Filter, Person, Projekt, Sitzung, Anfrage,
// Kontrollsummen und Statistik in einer Mandanten-Transaktion.
import { sql } from 'kysely';
import { QUELLE_A, schluesselFiltern } from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import {
  imAnnahmefenster,
  mandantKontextLaden,
  partitionenSicherstellen,
  tagIn,
  verwerfZaehler,
  type MandantKontext,
} from '../ingest-gemeinsam/kontext.js';
import {
  anfrageSpeichern,
  leereStatistik,
  nutzungVermerken,
  personAufloesen,
  projektAufloesen,
  sitzungenBuendeln,
  sitzungSpeichern,
  statistikErhoehen,
  type SitzungEingang,
} from '../ingest-gemeinsam/speichern.js';
import type { IngestZugang } from '../ingest-gemeinsam/zugang.js';
import {
  klassifizieren,
  logsAuswerten,
  metrikenAuswerten,
  type ApiAnfrageA,
} from './auswertung.js';

export interface VerarbeitungsErgebnis {
  abgelehnt: number;
  meldung: string;
}

function meldungAus(meldungen: Set<string>, abgelehnt: number): string {
  return abgelehnt > 0 ? `${abgelehnt} Datensätze abgelehnt: ${[...meldungen].join('; ')}` : '';
}

async function kontextLaden(db: Db, masterKey: Buffer, zugang: IngestZugang) {
  return withMandant(db, zugang.mandantId, (trx) =>
    mandantKontextLaden(trx, masterKey, zugang.mandantId),
  );
}

export async function logsVerarbeiten(
  db: Db,
  masterKey: Buffer,
  zugang: IngestZugang,
  koerper: Record<string, unknown>,
): Promise<VerarbeitungsErgebnis> {
  const ctx = await kontextLaden(db, masterKey, zugang);
  const auswertung = logsAuswerten(koerper, ctx.personSalt);
  const jetzt = new Date();
  const heute = tagIn(ctx.zeitzone, jetzt);
  const statistik = leereStatistik();
  statistik.verworfen_inhalt = auswertung.verworfenInhalt;
  let abgelehnt = auswertung.abgelehnt;

  const abo: ApiAnfrageA[] = [];
  for (const a of auswertung.anfragen) {
    const klasse = klassifizieren(a, ctx.orgs);
    const zaehler = verwerfZaehler(klasse);
    if (zaehler) {
      statistik[zaehler]++;
      continue;
    }
    if (!imAnnahmefenster(a.ts, ctx.aufbewahrungTage, jetzt)) {
      abgelehnt++;
      auswertung.meldungen.add('Zeitstempel außerhalb des Annahmefensters');
      continue;
    }
    abo.push(a);
  }
  const auths = auswertung.auths.filter(
    (e) => e.sessionId && e.erfolgreich && klassifizieren(e, ctx.orgs) === 'abo',
  );

  await partitionenSicherstellen(
    db,
    abo.map((a) => a.ts),
  );

  await withMandant(db, ctx.mandantId, async (trx) => {
    const personen = new Map<string, string>();
    const projekte = new Map<string, string | null>();
    const sitzungen: SitzungEingang[] = [];
    const vorbereitet = [];
    for (const a of abo) {
      const tag = tagIn(ctx.zeitzone, a.ts);
      const personId = await personAufloesen(trx, ctx, a.person, tag, personen);
      const projektId = await projektAufloesen(trx, ctx, a.projekt, projekte);
      if (!projektId) statistik.unzugeordnet++;
      if (a.sessionId) {
        sitzungen.push({
          quelle: QUELLE_A,
          sessionId: a.sessionId,
          personId,
          rechnerId: zugang.rechnerId,
          projektId,
          orgUuid: a.orgUuid,
          authKlasse: 'abo',
          ccVersion: a.ccVersion,
          start: a.ts,
          ende: a.ts,
        });
      }
      vorbereitet.push({ a, tag, personId, projektId });
    }
    for (const e of auths) {
      const personId = await personAufloesen(
        trx,
        ctx,
        e.person,
        tagIn(ctx.zeitzone, e.ts),
        personen,
      );
      sitzungen.push({
        quelle: QUELLE_A,
        sessionId: e.sessionId as string,
        personId,
        rechnerId: zugang.rechnerId,
        projektId: null,
        orgUuid: e.orgUuid,
        authKlasse: 'abo',
        ccVersion: e.ccVersion,
        start: e.ts,
        ende: e.ts,
      });
    }
    for (const s of sitzungenBuendeln(sitzungen)) await sitzungSpeichern(trx, ctx.mandantId, s);

    // Feste Reihenfolge der Schlüssel vermeidet Verklemmungen zwischen parallelen Pushes.
    vorbereitet.sort((x, y) => x.a.anfrageKey.localeCompare(y.a.anfrageKey));
    for (const { a, tag, personId, projektId } of vorbereitet) {
      const ergebnis = await anfrageSpeichern(trx, ctx.mandantId, {
        quelle: QUELLE_A,
        anfrageKey: a.anfrageKey,
        ts: a.ts,
        tag,
        sessionId: a.sessionId,
        personId,
        projektId,
        model: a.model,
        speed: a.speed,
        inferenceGeo: null,
        serviceTier: null,
        querySource: a.querySource,
        istSubagent: null,
        input: a.input,
        output: a.output,
        cacheRead: a.cacheRead,
        cacheWrite: a.cacheCreation,
        cacheWrite1h: null,
        webSearch: 0,
        authKlasse: 'abo',
        zaehltAlsAbo: true,
        ccKostenUsdMicros: a.kostenMicros,
        issueSchluessel: a.issueSchluessel
          ? schluesselFiltern(a.issueSchluessel, ctx.issuePraefixe)
          : null,
      });
      if (ergebnis !== 'wiederholt') statistik.angenommen++;
    }

    await statistikErhoehen(trx, ctx.mandantId, heute, 'a', statistik);
    await nutzungVermerken(trx, zugang.tokenId, zugang.rechnerId);
  });

  return { abgelehnt, meldung: meldungAus(auswertung.meldungen, abgelehnt) };
}

export async function metrikenVerarbeiten(
  db: Db,
  masterKey: Buffer,
  zugang: IngestZugang,
  koerper: Record<string, unknown>,
): Promise<VerarbeitungsErgebnis> {
  const ctx: MandantKontext = await kontextLaden(db, masterKey, zugang);
  const auswertung = metrikenAuswerten(koerper, ctx.personSalt);
  const summen = new Map<
    string,
    {
      tag: string;
      sessionId: string;
      model: string;
      typ: string;
      qs: string;
      wert: number;
      kumulativ: boolean;
    }
  >();
  for (const p of auswertung.punkte) {
    // Nur Abo-Nutzung zählt; alles andere bleibt ohne Spur (die Ereignisse zählen die Verwerfungen).
    if (klassifizieren(p, ctx.orgs) !== 'abo') continue;
    const tag = tagIn(ctx.zeitzone, p.ts);
    const sessionId = p.sessionId ?? '';
    const k = [tag, sessionId, p.model, p.typ, p.querySource].join('\u0000');
    const v = summen.get(k);
    if (!v) {
      summen.set(k, {
        tag,
        sessionId,
        model: p.model,
        typ: p.typ,
        qs: p.querySource,
        wert: p.wert,
        kumulativ: p.kumulativ,
      });
    } else {
      v.wert = p.kumulativ ? Math.max(v.wert, p.wert) : v.wert + p.wert;
    }
  }
  await withMandant(db, ctx.mandantId, async (trx) => {
    const sortiert = [...summen.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [, s] of sortiert) {
      // delta: aufaddieren; kumulativ: höchsten Stand halten (Näherung, Claude Code sendet standardmäßig delta).
      await sql`
        INSERT INTO otel_kontrollsumme AS k (mandant_id, tag, session_id, model, typ, query_source, wert)
        VALUES (${ctx.mandantId}::uuid, ${s.tag}::date, ${s.sessionId}, ${s.model}, ${s.typ}, ${s.qs}, ${s.wert})
        ON CONFLICT (mandant_id, tag, session_id, model, typ, query_source) DO UPDATE SET
          wert = ${s.kumulativ ? sql`GREATEST(k.wert, EXCLUDED.wert)` : sql`k.wert + EXCLUDED.wert`}`.execute(
        trx,
      );
    }
    await nutzungVermerken(trx, zugang.tokenId, zugang.rechnerId);
  });
  return {
    abgelehnt: auswertung.abgelehnt,
    meldung: meldungAus(auswertung.meldungen, auswertung.abgelehnt),
  };
}
