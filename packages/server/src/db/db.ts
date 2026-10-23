// Kysely-Verbindung über `pg`. Typabbildung zentral, damit alle Module gleich rechnen:
// int8 → number (Token- und Mikro-USD-Summen bleiben weit unter 2^53), date → 'YYYY-MM-DD' (keine
// Zeitzonen-Verschiebung), numeric bleibt string (exakte Preise und Faktoren).
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Datenbank } from './schema.js';

pg.types.setTypeParser(pg.types.builtins.INT8, (wert: string) => Number(wert));
pg.types.setTypeParser(pg.types.builtins.DATE, (wert: string) => wert);

export type Db = Kysely<Datenbank>;

export function erstelleDb(databaseUrl: string, poolGroesse = 10): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: poolGroesse });
  return new Kysely<Datenbank>({ dialect: new PostgresDialect({ pool }) });
}
