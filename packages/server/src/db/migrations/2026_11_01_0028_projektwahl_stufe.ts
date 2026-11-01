// Modul projektkatalog: Der Schalter `erzwingen` wird zu drei Stufen (aus, warnen, blockieren), damit ein Rollout
// erst warnt, bevor er blockiert. Bisher „an“ wird zu `blockieren`. Dazu ein Kontakt für Personen ohne Zugang
// zur Auswahlseite. Nur vorwärts.
import { sql, type Kysely } from 'kysely';

const SCHEMA = `
ALTER TABLE mandant_projektkatalog
  ADD COLUMN stufe text NOT NULL DEFAULT 'aus' CHECK (stufe IN ('aus', 'warnen', 'blockieren')),
  ADD COLUMN kontakt text CHECK (kontakt IS NULL OR length(kontakt) <= 200);
UPDATE mandant_projektkatalog SET stufe = 'blockieren' WHERE erzwingen;
ALTER TABLE mandant_projektkatalog DROP COLUMN erzwingen;
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEMA).execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
