// Ratenlimits der Ingest-Pfade je Mandant: Anfragen pro Minute je Token (OTLP) bzw. je
// Rechner (Agent); NULL = Standard aus der Umgebung (`SEATMETER_RATE_OTLP`, `SEATMETER_RATE_AGENT`).
// Der Stoß wächst im Verhältnis des Standards (ingest-gemeinsam/ratenlimit.ts). Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE mandant
    ADD COLUMN ratenlimit_otlp integer CHECK (ratenlimit_otlp BETWEEN 10 AND 1000000),
    ADD COLUMN ratenlimit_agent integer CHECK (ratenlimit_agent BETWEEN 10 AND 1000000)`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
