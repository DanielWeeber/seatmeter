// Ablauf der CLI `katalog:importieren` (ohne Prozess-Umgebung, damit Tests ihn direkt aufrufen können).
// Rückgabe ist der Exit-Code: 0 = Erfolg, 2 = Erfolg mit abgelehnten Zeilen, 1 = nichts geändert (Fehler).
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  KATALOG_DATEI_MAX_BYTES,
  KATALOG_TRENNZEICHEN_STANDARD,
  katalogSpaltenSchema,
  katalogTrennzeichenLesen,
  type KatalogSpalten,
} from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { katalogImportieren } from './importieren.js';
import { csvDateiQuelle, QuelleFehler } from './quelle.js';

export interface KatalogCliUmgebung {
  db: Db;
  /** Eingabe für `--datei -`. */
  eingabe: Readable;
  ausgabe: (zeile: string) => void;
  fehler: (zeile: string) => void;
}

async function bytesLesen(quelle: Readable): Promise<Buffer> {
  const teile: Buffer[] = [];
  let summe = 0;
  for await (const teil of quelle) {
    const b = Buffer.isBuffer(teil) ? teil : Buffer.from(teil as string);
    summe += b.length;
    if (summe > KATALOG_DATEI_MAX_BYTES) {
      quelle.destroy();
      throw new QuelleFehler(`Die Datei ist größer als ${KATALOG_DATEI_MAX_BYTES} Bytes.`);
    }
    teile.push(b);
  }
  return Buffer.concat(teile);
}

export async function katalogCli(
  argumente: readonly string[],
  u: KatalogCliUmgebung,
): Promise<number> {
  const scheitern = (meldung: string) => {
    u.fehler(JSON.stringify({ fehler: meldung }));
    return 1;
  };
  let werte;
  try {
    werte = parseArgs({
      args: [...argumente],
      options: {
        mandant: { type: 'string' },
        datei: { type: 'string' },
        trennzeichen: { type: 'string' },
        'spalte-id': { type: 'string' },
        'spalte-name': { type: 'string' },
        'spalte-nummer': { type: 'string' },
        'spalte-kunde': { type: 'string' },
        'spalte-aktiv': { type: 'string' },
        'spalte-parent': { type: 'string' },
        trockenlauf: { type: 'boolean', default: false },
        teilliste: { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch (f) {
    return scheitern((f as Error).message);
  }
  if (!werte.mandant) return scheitern('--mandant <slug> fehlt');
  if (!werte.datei) return scheitern('--datei <pfad|-> fehlt');
  const trennzeichen =
    werte.trennzeichen === undefined
      ? KATALOG_TRENNZEICHEN_STANDARD
      : katalogTrennzeichenLesen(werte.trennzeichen);
  if (!trennzeichen) return scheitern('Trennzeichen unbekannt: ; , tab oder pipe');
  let spalten: KatalogSpalten | undefined;
  const zuordnung = {
    id: werte['spalte-id'],
    name: werte['spalte-name'],
    nummer: werte['spalte-nummer'],
    kunde: werte['spalte-kunde'],
    aktiv: werte['spalte-aktiv'],
    parent: werte['spalte-parent'],
  };
  if (Object.values(zuordnung).some((w) => w !== undefined)) {
    const s = katalogSpaltenSchema.safeParse(zuordnung);
    if (!s.success) return scheitern('Die Spaltenzuordnung braucht --spalte-id und --spalte-name');
    spalten = s.data;
  }
  try {
    const m = await u.db
      .selectFrom('mandant')
      .select('id')
      .where('slug', '=', werte.mandant)
      .executeTakeFirst();
    if (!m) return scheitern('Mandant unbekannt');
    const bytes = await bytesLesen(werte.datei === '-' ? u.eingabe : createReadStream(werte.datei));
    const e = await katalogImportieren(
      u.db,
      m.id,
      csvDateiQuelle(bytes, { trennzeichen, spalten }),
      {
        vollstaendig: !werte.teilliste,
        trockenlauf: werte.trockenlauf,
        benutzerId: null,
        ausloeser: 'cli',
      },
    );
    u.ausgabe(JSON.stringify(e));
    // Exit 2 auch bei übersprungenem Deaktivieren: Der Lauf ist durch, aber die Datei gehört angeschaut.
    return e.abgelehnt > 0 || e.deaktivierung_uebersprungen ? 2 : 0;
  } catch (f) {
    return scheitern((f as Error).message);
  }
}
