// Werte für `/api/health/ingest` je Quelle (a = OTLP, b = Agent) und Stand der Agenten,
// mandantenübergreifend als Eigentümer gelesen (nur Zähler und Zeitpunkte, keine Personen- oder Projektdaten).
import { sql } from 'kysely';
import {
  AGENT_AKTIV_STUNDEN,
  HEARTBEAT_FRISCH_STUNDEN,
  type IngestAgenten,
} from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { ablehnungen } from './ratenlimit.js';

export interface IngestHeute {
  angenommen: number;
  verworfen_inhalt: number;
  verworfen_api: number;
  verworfen_fremd_org: number;
  unzugeordnet: number;
}

export interface IngestQuelleWerte {
  /** Letzte Annahme (ISO) laut `ingest_statistik.zuletzt` oder `null`. */
  letzte_annahme: string | null;
  /**
   * Stunden seit der letzten Annahme (eine Nachkommastelle), `null`, wenn die Quelle noch nie
   * geliefert hat. Für Monitoring-Bedingungen wie `[BODY].quellen.a.stille_stunden < 24`.
   */
  stille_stunden: number | null;
  /** Anfragen mit Zeitstempel in den letzten 24 h, an denen die Quelle beteiligt ist. */
  anfragen_24h: number;
  /**
   * Vom Ratenlimit abgelehnte Anfragen (429) der letzten 24 h (a = `/otlp/v1/*`, b = `/api/ingest/v1/*`
   * und `/api/agent/v1/*`), im Speicher des Prozesses gezählt; nach einem Neustart ab `ratenlimit.seit`.
   */
  abgelehnt_429_24h: number;
  /** Zähler des heutigen Tages (Annahmetag in der Zeitzone des jeweiligen Mandanten). */
  heute: IngestHeute;
}

const leer = (): IngestQuelleWerte => ({
  letzte_annahme: null,
  stille_stunden: null,
  anfragen_24h: 0,
  abgelehnt_429_24h: 0,
  heute: {
    angenommen: 0,
    verworfen_inhalt: 0,
    verworfen_api: 0,
    verworfen_fremd_org: 0,
    unzugeordnet: 0,
  },
});

/** Stunden zwischen `letzte` und `jetzt`, abgerundet auf eine Nachkommastelle, nie negativ. */
export function stilleStunden(letzte: Date, jetzt: Date): number {
  return Math.max(0, Math.floor((jetzt.getTime() - letzte.getTime()) / 360_000) / 10);
}

export async function ingestStatusLesen(
  db: Db,
): Promise<{ a: IngestQuelleWerte; b: IngestQuelleWerte }> {
  const werte = { a: leer(), b: leer() };
  const jetzt = new Date();
  const statistik = await sql<{
    quelle: string;
    letzte: Date | null;
    angenommen: number | null;
    verworfen_inhalt: number | null;
    verworfen_api: number | null;
    verworfen_fremd_org: number | null;
    unzugeordnet: number | null;
  }>`
    SELECT s.quelle, max(s.zuletzt) AS letzte,
      sum(s.angenommen) FILTER (WHERE s.tag = (now() AT TIME ZONE m.zeitzone)::date)::bigint AS angenommen,
      sum(s.verworfen_inhalt) FILTER (WHERE s.tag = (now() AT TIME ZONE m.zeitzone)::date)::bigint AS verworfen_inhalt,
      sum(s.verworfen_api) FILTER (WHERE s.tag = (now() AT TIME ZONE m.zeitzone)::date)::bigint AS verworfen_api,
      sum(s.verworfen_fremd_org) FILTER (WHERE s.tag = (now() AT TIME ZONE m.zeitzone)::date)::bigint AS verworfen_fremd_org,
      sum(s.unzugeordnet) FILTER (WHERE s.tag = (now() AT TIME ZONE m.zeitzone)::date)::bigint AS unzugeordnet
    FROM ingest_statistik s JOIN mandant m ON m.id = s.mandant_id
    WHERE s.quelle IN ('a', 'b')
    GROUP BY s.quelle`.execute(db);
  for (const z of statistik.rows) {
    const w = z.quelle === 'a' ? werte.a : werte.b;
    w.letzte_annahme = z.letzte ? new Date(z.letzte).toISOString() : null;
    w.stille_stunden = z.letzte ? stilleStunden(new Date(z.letzte), jetzt) : null;
    w.heute = {
      angenommen: Number(z.angenommen ?? 0),
      verworfen_inhalt: Number(z.verworfen_inhalt ?? 0),
      verworfen_api: Number(z.verworfen_api ?? 0),
      verworfen_fremd_org: Number(z.verworfen_fremd_org ?? 0),
      unzugeordnet: Number(z.unzugeordnet ?? 0),
    };
  }
  const anzahl = await sql<{ a: number; b: number }>`
    SELECT count(*) FILTER (WHERE quellen & 1 = 1)::bigint AS a,
           count(*) FILTER (WHERE quellen & 2 = 2)::bigint AS b
    FROM anfrage WHERE ts > now() - interval '24 hours'`.execute(db);
  werte.a.anfragen_24h = Number(anzahl.rows[0]?.a ?? 0);
  werte.b.anfragen_24h = Number(anzahl.rows[0]?.b ?? 0);
  const rl = ablehnungen.stand();
  werte.a.abgelehnt_429_24h = rl.quellen.a;
  werte.b.abgelehnt_429_24h = rl.quellen.b;
  return werte;
}

/** Ganze Stunden zwischen zwei Zeitpunkten, abgerundet, nie negativ (für Monitoring-Bedingungen). */
export function ganzeStunden(von: Date, bis: Date): number {
  return Math.max(0, Math.floor((bis.getTime() - von.getTime()) / 3_600_000));
}

/**
 * Agenten-Stand für `/api/health/ingest` (`agenten`), mandantenübergreifend als Eigentümer gelesen:
 * Lebenszeichen aus `rechner.zuletzt_gesehen` (Push oder Heartbeat), dazu zwei abgeleitete Werte für
 * Alarme ohne Fehlalarm nachts und am Wochenende (Bedeutung siehe `ingestAgentenSchema`).
 */
export async function agentenStatusLesen(
  db: Db,
  letzteAnnahmeB: string | null,
  jetzt = new Date(),
): Promise<IngestAgenten> {
  const r = (
    await sql<{
      gesamt: number;
      aktiv: number;
      aeltester: Date | null;
      juengster: Date | null;
      frisch_registriert: Date | null;
    }>`
      SELECT count(*)::int AS gesamt,
        count(*) FILTER (WHERE zuletzt_gesehen > ${jetzt}::timestamptz - make_interval(hours => ${AGENT_AKTIV_STUNDEN}))::int AS aktiv,
        min(zuletzt_gesehen) AS aeltester,
        max(zuletzt_gesehen) AS juengster,
        min(registriert) FILTER (WHERE zuletzt_gesehen > ${jetzt}::timestamptz - make_interval(hours => ${HEARTBEAT_FRISCH_STUNDEN})) AS frisch_registriert
      FROM rechner WHERE widerrufen IS NULL`.execute(db)
  ).rows[0];
  const juengster = r?.juengster ? new Date(r.juengster) : null;
  const aeltester = r?.aeltester ? new Date(r.aeltester) : null;
  const frisch =
    juengster !== null &&
    jetzt.getTime() - juengster.getTime() < HEARTBEAT_FRISCH_STUNDEN * 3_600_000;
  let stille = 0;
  if (frisch) {
    const seit = letzteAnnahmeB
      ? new Date(letzteAnnahmeB)
      : r?.frisch_registriert
        ? new Date(r.frisch_registriert)
        : null;
    stille = seit ? ganzeStunden(seit, jetzt) : 0;
  }
  // Je Person mit B-Daten: A-Anfragen ohne B-Bit nach der jüngsten B-Anfrage dieser Person.
  const luecke = (
    await sql<{ sekunden: number | null }>`
      WITH b AS (
        SELECT mandant_id, person_id, max(ts) AS t FROM anfrage
        WHERE quellen & 2 = 2 AND person_id IS NOT NULL
          AND ts > ${jetzt}::timestamptz - interval '30 days'
        GROUP BY mandant_id, person_id
      )
      SELECT max(extract(epoch FROM l.letzte - l.erste))::float8 AS sekunden FROM (
        SELECT min(a.ts) AS erste, max(a.ts) AS letzte
        FROM anfrage a JOIN b ON a.mandant_id = b.mandant_id AND a.person_id = b.person_id
        WHERE a.quellen = 1 AND a.ts > b.t AND a.ts > ${jetzt}::timestamptz - interval '30 days'
        GROUP BY a.mandant_id, a.person_id
      ) l`.execute(db)
  ).rows[0];
  return {
    gesamt: Number(r?.gesamt ?? 0),
    aktiv_48h: Number(r?.aktiv ?? 0),
    aeltester_heartbeat_stunden: aeltester ? stilleStunden(aeltester, jetzt) : null,
    juengster_heartbeat_stunden: juengster ? stilleStunden(juengster, jetzt) : null,
    stille_trotz_heartbeat_stunden: stille,
    luecke_zu_a_stunden: Math.max(0, Math.floor(Number(luecke?.sekunden ?? 0) / 3600)),
  };
}
