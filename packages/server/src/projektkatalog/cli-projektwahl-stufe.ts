// Notfall-CLI: pnpm --filter @seatmeter/server katalog:stufe --mandant <slug> --stufe aus|warnen|blockieren
// Im Image: docker compose exec -T server node /app/server/dist/projektkatalog/cli-projektwahl-stufe.js
//           --mandant <slug> --stufe aus
// Für den Fall, dass der Identitätsanbieter ausfällt und auch Admins nicht mehr ins Dashboard kommen.
// Exit 0 = gesetzt, 1 = Fehler, nichts geändert. Wirkt auf den Rechnern, sobald die Marke des Hooks abläuft.
import { ladeKonfiguration } from '../config.js';
import { erstelleDb } from '../db/db.js';
import { stufeCli } from './cli-stufe.js';

const konfiguration = ladeKonfiguration();
const db = erstelleDb(konfiguration.DATABASE_URL, 2);
try {
  process.exitCode = await stufeCli(process.argv.slice(2), {
    db,
    konfiguration,
    ausgabe: (zeile) => console.log(zeile),
    fehler: (zeile) => console.error(zeile),
  });
} finally {
  await db.destroy();
}
