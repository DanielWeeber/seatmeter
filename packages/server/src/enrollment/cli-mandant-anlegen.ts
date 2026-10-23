// CLI: pnpm --filter @seatmeter/server mandant:anlegen --slug pilot --name "Pilot" --org <uuid> [--org …]
//      [--plan team|enterprise|max_pilot] [--neues-token]
// Im Image: docker compose exec server node /app/server/dist/enrollment/cli-mandant-anlegen.js --slug …
// Idempotent: Ein vorhandener Mandant (z. B. aus der Einrichtung) bekommt Orgs und, falls keines aktiv
// ist, ein Token dazu. Braucht DATABASE_URL und SEATMETER_MASTER_KEY (wie der Server). Gibt das Token nur
// einmal aus.
import { parseArgs } from 'node:util';
import { ladeKonfiguration } from '../config.js';
import { erstelleDb } from '../db/db.js';
import { migriere } from '../db/migrator.js';
import { mandantAnlegen } from './mandant-anlegen.js';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    plan: { type: 'string' },
    org: { type: 'string', multiple: true },
    'neues-token': { type: 'boolean', default: false },
  },
  strict: true,
});

const konfiguration = ladeKonfiguration();
const db = erstelleDb(konfiguration.DATABASE_URL, 2);
try {
  await migriere(db);
  const e = await mandantAnlegen(db, konfiguration.SEATMETER_MASTER_KEY, {
    slug: values.slug ?? '',
    name: values.name ?? values.slug ?? '',
    // Ohne --plan: neuer Mandant „team“, vorhandener behält seinen Plan.
    plan: values.plan as 'team' | 'enterprise' | 'max_pilot' | undefined,
    orgs: values.org ?? [],
    neuesToken: values['neues-token'],
  });
  console.log(
    `Mandant ${values.slug}: ${e.mandantNeu ? 'angelegt' : 'vorhanden'} (${e.mandantId})`,
  );
  console.log(`Orgs neu in der Positivliste: ${e.orgsNeu}`);
  if (e.token) {
    console.log('Mandanten-Token (wird nur jetzt angezeigt, sicher ablegen):');
    console.log(e.token);
  } else {
    console.log(`Aktives Mandanten-Token vorhanden (${e.tokenPraefix}…); neues mit --neues-token.`);
  }
} catch (fehler) {
  console.error(`Fehler: ${(fehler as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
