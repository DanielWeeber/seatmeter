// Startpunkt des Servers: Konfiguration, Migrationen (Advisory-Lock), Partitionen, HTTP, Job-Planer.
// Betrieb: `node dist/main.js --einmal <job>` führt einen Job einmal aus und beendet sich
// (Exit 0 = ok oder übersprungen, 1 = Fehler), z. B. `--einmal aggregation.tag`.
import { erstelleApp } from './app.js';
import { ladeKonfiguration } from './config.js';
import { erstelleDb } from './db/db.js';
import { migriere, migrierePlugins } from './db/migrator.js';
import { anfragePartitionenAnlegen } from './db/partitionen.js';
import { fuehreJobAus, JobPlaner } from './jobs/index.js';
import { ladePluginModule } from './plugin.js';

const konfiguration = ladeKonfiguration();
const db = erstelleDb(konfiguration.DATABASE_URL);
await migriere(db);
await anfragePartitionenAnlegen(db);
const plugins = await ladePluginModule(konfiguration.SEATMETER_PLUGINS);
await migrierePlugins(db, plugins);
const app = await erstelleApp({ konfiguration, db, plugins });
const jobs = [...app.seatmeterKernJobs, ...app.seatmeter.jobs];

const einmal = process.argv.indexOf('--einmal');
if (einmal >= 0) {
  const name = process.argv[einmal + 1];
  if (!name) throw new Error(`--einmal braucht einen Job: ${jobs.map((j) => j.name).join(', ')}`);
  const ergebnis = await fuehreJobAus(jobs, name, { db, konfiguration }, 'einmal');
  app.log.info({ job: name, ...ergebnis }, 'Job einmal ausgeführt');
  await app.close();
  await db.destroy();
  process.exit(ergebnis.status === 'fehler' ? 1 : 0);
}

const planer =
  konfiguration.SEATMETER_JOBS === 'an'
    ? new JobPlaner(jobs, { db, konfiguration }, app.log)
    : null;

const beenden = async () => {
  await planer?.stop();
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.once('SIGTERM', beenden);
process.once('SIGINT', beenden);

await app.listen({ host: '0.0.0.0', port: konfiguration.PORT });
planer?.start();
