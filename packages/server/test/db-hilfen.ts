// Hilfen für Tests gegen echte Postgres (compose.dev.yml bzw. CI-Dienst `postgres`).
import pg from 'pg';

export const BASIS_URL =
  process.env.DATABASE_URL ?? 'postgres://seatmeter:seatmeter-dev@localhost:5432/seatmeter';

/** Ersetzt den Datenbanknamen in einer postgres://-URL. */
export function urlMitDatenbank(url: string, datenbank: string): string {
  const u = new URL(url);
  u.pathname = `/${datenbank}`;
  return u.toString();
}

/** Wartet, bis Postgres Verbindungen annimmt (höchstens `sekunden`). */
export async function warteAufPostgres(url: string, sekunden = 60): Promise<void> {
  const ende = Date.now() + sekunden * 1000;
  let letzterFehler: unknown;
  while (Date.now() < ende) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (fehler) {
      letzterFehler = fehler;
      await client.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Postgres nicht erreichbar nach ${sekunden} s: ${String(letzterFehler)}`);
}

/** Legt eine leere Datenbank an (vorhandene gleichen Namens wird verworfen). */
export async function frischeDatenbank(name: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Ungültiger Datenbankname: ${name}`);
  const admin = new pg.Client({ connectionString: urlMitDatenbank(BASIS_URL, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return urlMitDatenbank(BASIS_URL, name);
}
