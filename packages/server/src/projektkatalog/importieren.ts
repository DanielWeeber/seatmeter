// Gemeinsamer Import-Ablauf von Routen und CLI: Quelle lesen (Fehler der ganzen Datei werfen `QuelleFehler`, bevor
// etwas geschrieben wird), abgleichen, protokollieren. Ein Trockenlauf schreibt weder Katalog noch Protokoll.
import type { KatalogImportErgebnis } from '@seatmeter/shared';
import { protokolliere } from '../audit/protokoll.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { AUDIT_KATALOG } from './audit.js';
import { katalogAbgleichen } from './daten.js';
import type { ProjektQuelle } from './quelle.js';
import { syncZeitSetzen } from './sync.js';

export interface KatalogImportOptionen {
  vollstaendig: boolean;
  trockenlauf: boolean;
  /** Konto bei Anmeldung im Dashboard; Token und CLI haben keines. */
  benutzerId: string | null;
  /** Im Protokoll: `konto`, `cli` oder `token:<Präfix>`, nie das Token selbst. */
  ausloeser: string;
}

export async function katalogImportieren(
  db: Db,
  mandantId: string,
  quelle: ProjektQuelle,
  o: KatalogImportOptionen,
): Promise<KatalogImportErgebnis> {
  const ladung = await quelle.projekteLaden();
  return withMandant(db, mandantId, async (trx) => {
    const e = await katalogAbgleichen(trx, mandantId, quelle.name, ladung, {
      vollstaendig: o.vollstaendig,
      trockenlauf: o.trockenlauf,
    });
    if (!o.trockenlauf) {
      // Geplante Läufe zählen als Synchronisation, Importe von Hand im Dashboard nicht: Wer nur von Hand importiert,
      // bekäme sonst die Warnung über eine ausbleibende Synchronisation.
      if (o.ausloeser !== 'konto') await syncZeitSetzen(trx, mandantId, new Date());
      await protokolliere(trx, {
        benutzerId: o.benutzerId,
        aktion: AUDIT_KATALOG.importiert,
        objekt:
          `quelle:${quelle.name} ausloeser:${o.ausloeser} neu:${e.neu} aktualisiert:${e.aktualisiert} ` +
          `unveraendert:${e.unveraendert} deaktiviert:${e.deaktiviert} abgelehnt:${e.abgelehnt}`,
      });
    }
    return e;
  });
}
