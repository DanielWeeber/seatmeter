// /api/health (DB-Ping, für Gatus) und /api/health/ingest (Werte der Module ingest-otlp/ingest-agent
// und Stand der Agenten; immer 200 mit Werten, Alarme entstehen über Bedingungen im Monitoring, z. B.
// `[BODY].agenten.aktiv_48h > 0` und `[BODY].agenten.luecke_zu_a_stunden < 4`, siehe deploy/README.md).
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { IngestAgenten, IngestRatenlimitStand } from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { ablehnungen } from '../ingest-gemeinsam/ratenlimit.js';
import {
  agentenStatusLesen,
  ingestStatusLesen,
  type IngestQuelleWerte,
} from '../ingest-gemeinsam/status.js';

export type IngestQuelleStatus = IngestQuelleWerte;

export interface IngestStatus {
  status: 'ok';
  quellen: { a: IngestQuelleStatus; b: IngestQuelleStatus };
  agenten: IngestAgenten;
  ratenlimit: IngestRatenlimitStand;
}

export function healthRouten(app: FastifyInstance, db: Db): void {
  app.get('/api/health', async (_anfrage, antwort) => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: 'ok', db: 'ok' };
    } catch {
      return antwort.code(503).send({ status: 'fehler', db: 'nicht erreichbar' });
    }
  });

  app.get('/api/health/ingest', async (_anfrage, antwort) => {
    try {
      const quellen = await ingestStatusLesen(db);
      const agenten = await agentenStatusLesen(db, quellen.b.letzte_annahme);
      const { seit, je_art } = ablehnungen.stand();
      return {
        status: 'ok',
        quellen,
        agenten,
        ratenlimit: { seit, abgelehnt_429_24h_je_art: je_art },
      } satisfies IngestStatus;
    } catch {
      return antwort.code(503).send({ status: 'fehler', db: 'nicht erreichbar' });
    }
  });
}
