// CLI: pnpm --filter @seatmeter/server katalog:importieren --mandant <slug> --datei <pfad|->
//      [--trennzeichen ";"|,|tab|pipe] [--spalte-id <Spalte> --spalte-name <Spalte> [--spalte-nummer <Spalte>]
//      [--spalte-kunde <Spalte>] [--spalte-aktiv <Spalte>] [--spalte-parent <Spalte>]] [--trockenlauf] [--teilliste]
// Im Image: docker compose exec -T server node /app/server/dist/projektkatalog/cli-katalog-importieren.js
//           --mandant <slug> --datei - < projekte.csv
// Gibt die Zähler als JSON aus. Exit 0 = Erfolg, 2 = Erfolg mit abgelehnten Zeilen, 1 = Fehler, nichts geändert.
// Führt keine Migrationen aus; das macht der Server beim Start. Braucht DATABASE_URL (wie der Server).
import { ladeKonfiguration } from '../config.js';
import { erstelleDb } from '../db/db.js';
import { katalogCli } from './cli-import.js';

const db = erstelleDb(ladeKonfiguration().DATABASE_URL, 2);
try {
  process.exitCode = await katalogCli(process.argv.slice(2), {
    db,
    eingabe: process.stdin,
    ausgabe: (zeile) => console.log(zeile),
    fehler: (zeile) => console.error(zeile),
  });
} finally {
  await db.destroy();
}
