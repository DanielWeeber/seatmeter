// Listen für den Projektkatalog: `ProjektQuelle` liefert eine ganze Liste, heute aus dem JSON-Import und der CSV-Datei.
// Der Regelfall ist der Push je Projekt (`push.ts`); Listen dienen dem Erstbestand und Läufen von Hand. Probleme der ganzen Datei (Kodierung, Kopfzeile,
// Trennzeichen, Spalten, offenes Anführungszeichen, leer, zu groß) lehnen sie ganz ab. Eine schlechte Zeile lehnt nur
// diese Zeile ab, darf aber nie ein Projekt deaktivieren: Ist ihre Nummer lesbar, bleibt dieses Projekt unberührt,
// sonst wird im ganzen Lauf nichts deaktiviert. Das gilt auch, wenn ein Feld andere Zeilen verschluckt haben kann:
// abweichende Spaltenzahl, Zeilenumbruch in einer Spalte, die zählt, oder mehrzeiliger Text mit Trennzeichen in einer,
// die nicht zählt (dort lehnt das die Zeile nicht ab). Meldungen nennen Zeilennummern, nie Zellinhalte.
import {
  katalogEintragSchema,
  katalogJaNein,
  katalogTextUnsauber,
  KATALOG_ABGELEHNT_MELDUNGEN_MAX,
  KATALOG_ID_MAX,
  KATALOG_IMPORT_MAX,
  KATALOG_STATUS_MAX,
  KATALOG_TEXT_KODIERUNG,
  KATALOG_TRENNZEICHEN_STANDARD,
  type KatalogEintrag,
  type KatalogSpalten,
  type KatalogTrennzeichen,
} from '@seatmeter/shared';
import {
  CsvFormatFehler,
  normalisiere,
  parseCsvMitNummern,
  trennzeichen,
} from '../abgleich/csv.js';

/** Was eine Quelle liefert. */
export interface KatalogLadung {
  eintraege: KatalogEintrag[];
  /** Nummern abgelehnter Zeilen: Diese Projekte ändern sich in diesem Lauf nicht. */
  geschuetzt: string[];
  /** Zahl aller abgelehnten Zeilen. */
  abgelehnt: number;
  /** Höchstens 20 Meldungen mit Zeilennummer. */
  meldungen: string[];
  /** Eine abgelehnte Zeile lässt sich keinem Projekt zuordnen, oder ein Feld kann Zeilen verschluckt haben: nichts deaktivieren. */
  nummerUnlesbar: boolean;
  /** Warum nichts deaktiviert wird, obwohl die Zeile selbst gültig ist; höchstens 20, mit Zeilennummer. */
  hinweise: string[];
}

export interface ProjektQuelle {
  /** Kennung der Quelle, steht in `katalog_projekt.quelle`, z. B. `csv`. */
  readonly name: string;
  /** Liefert die Projekte oder wirft `QuelleFehler` (mit Meldung ohne Geheimnisse). */
  projekteLaden(): Promise<KatalogLadung>;
}

export class QuelleFehler extends Error {}

/** Ladung ohne abgelehnte Zeilen, z. B. aus einer schon geprüften Liste. */
export function ladungAus(eintraege: readonly KatalogEintrag[]): KatalogLadung {
  return {
    eintraege: [...eintraege],
    geschuetzt: [],
    abgelehnt: 0,
    meldungen: [],
    nummerUnlesbar: false,
    hinweise: [],
  };
}

/** Eine schon geprüfte Liste, z. B. aus `POST /api/v1/projektkatalog/import`. */
export function listenQuelle(name: string, eintraege: readonly KatalogEintrag[]): ProjektQuelle {
  return { name, projekteLaden: () => Promise.resolve(ladungAus(eintraege)) };
}

export interface KatalogCsvOptionen {
  /** Standard `;`. Es wird nie erraten. */
  trennzeichen?: KatalogTrennzeichen;
  /** Mit Zuordnung zählen nur diese Spalten; ohne gelten die üblichen Spaltennamen. */
  spalten?: KatalogSpalten;
}

const SPALTEN: Record<'id' | 'nummer' | 'name' | 'kunde' | 'aktiv' | 'parent', readonly string[]> =
  {
    id: ['externe id', 'external id', 'externalid', 'id', 'kennung'],
    nummer: ['nummer', 'projektnummer', 'projekt nr', 'projektnr', 'nr', 'number'],
    name: ['name', 'projektname', 'projekt', 'titel', 'bezeichnung', 'title'],
    kunde: ['kunde', 'kundenname', 'auftraggeber', 'customer', 'client'],
    aktiv: ['aktiv', 'status', 'active'],
    parent: ['parent', 'parent id', 'parentid', 'elternprojekt', 'übergeordnet', 'uebergeordnet'],
  };

const TRENNZEICHEN_NAME: Record<KatalogTrennzeichen, string> = {
  ';': 'Semikolon',
  ',': 'Komma',
  '\t': 'Tabulator',
  '|': 'Senkrechter Strich',
};

function spalteFinden(kopf: readonly string[], kandidaten: readonly string[]): number {
  for (const k of kandidaten) {
    const i = kopf.indexOf(k);
    if (i >= 0) return i;
  }
  return -1;
}

/** Zugeordnete Spalte: zuerst wörtlich, sonst normalisiert; mehrere Treffer sind ein Fehler. */
function zugeordneteSpalte(kopfRoh: readonly string[], name: string): number {
  const woertlich = kopfRoh.map((k) => k.trim()).indexOf(name.trim());
  if (woertlich >= 0) return woertlich;
  const ziel = normalisiere(name);
  const treffer = kopfRoh.flatMap((k, i) => (normalisiere(k) === ziel ? [i] : []));
  if (treffer.length > 1) throw new QuelleFehler(`Die Spalte „${name}“ ist nicht eindeutig.`);
  const [i] = treffer;
  if (i === undefined) throw new QuelleFehler(`Die Spalte „${name}“ fehlt in der Kopfzeile.`);
  return i;
}

function trennzeichenHinweis(csv: string, trenn: KatalogTrennzeichen): string {
  const vermutet = trennzeichen(csv) as KatalogTrennzeichen;
  return vermutet === trenn
    ? ''
    : ` Eingestellt ist ${TRENNZEICHEN_NAME[trenn]}, die Kopfzeile sieht nach ${TRENNZEICHEN_NAME[vermutet]} aus.`;
}

interface Indizes {
  id: number;
  nummer: number;
  name: number;
  kunde: number;
  aktiv: number;
  parent: number;
}

function spaltenFinden(
  kopfRoh: readonly string[],
  csv: string,
  trenn: KatalogTrennzeichen,
  spalten: KatalogSpalten | undefined,
): Indizes {
  if (spalten) {
    const optional = (name: string | undefined) => (name ? zugeordneteSpalte(kopfRoh, name) : -1);
    try {
      return {
        id: zugeordneteSpalte(kopfRoh, spalten.id),
        nummer: optional(spalten.nummer),
        name: zugeordneteSpalte(kopfRoh, spalten.name),
        kunde: optional(spalten.kunde),
        aktiv: optional(spalten.aktiv),
        parent: optional(spalten.parent),
      };
    } catch (f) {
      if (f instanceof QuelleFehler) {
        throw new QuelleFehler(f.message + trennzeichenHinweis(csv, trenn));
      }
      throw f;
    }
  }
  const kopf = kopfRoh.map(normalisiere);
  const nummer = spalteFinden(kopf, SPALTEN.nummer);
  const idSpalte = spalteFinden(kopf, SPALTEN.id);
  // Nur eine Nummer: Sie ist auch die externe ID.
  const id = idSpalte >= 0 ? idSpalte : nummer;
  const name = spalteFinden(kopf, SPALTEN.name);
  if (id < 0 || name < 0) {
    throw new QuelleFehler(
      `Die Kopfzeile braucht die Spalten „Nummer“ oder „ID“ und „Name“.${trennzeichenHinweis(csv, trenn)}`,
    );
  }
  return {
    id,
    nummer,
    name,
    kunde: spalteFinden(kopf, SPALTEN.kunde),
    aktiv: spalteFinden(kopf, SPALTEN.aktiv),
    parent: spalteFinden(kopf, SPALTEN.parent),
  };
}

/** Rohdaten als UTF-8 lesen (BOM wird entfernt); alles andere lehnt die Datei ab, statt Zeichen zu verfälschen. */
export function katalogCsvDekodieren(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new QuelleFehler(KATALOG_TEXT_KODIERUNG);
  }
}

const ZEILENUMBRUCH = /[\r\n]/;

/**
 * Mehrzeiliger Text, von dem eine Zeile wie eine CSV-Zeile aussieht (mindestens so viele Trennzeichen wie Spalten minus
 * eins): Das kann eine verschluckte Zeile sein, auch die erste, wenn das Anführungszeichen am Anfang des Feldes steht. Eine
 * Beschreibung mit ein paar Trennzeichen fällt so nicht auf.
 */
function verschlucktWomoeglich(feld: string, trenn: string, spalten: number): boolean {
  if (!ZEILENUMBRUCH.test(feld)) return false;
  return feld.split(/\r\n|\r|\n/).some((zeile) => zeile.split(trenn).length >= spalten);
}

function zeilenLesen(csv: string, trenn: string) {
  try {
    return parseCsvMitNummern(csv, trenn);
  } catch (f) {
    if (f instanceof CsvFormatFehler) throw new QuelleFehler(f.message);
    throw f;
  }
}

/** Liest die CSV: Kopfzeile Pflicht, Spalten Nummer und Name Pflicht, andere Spalten zählen nicht. */
export function leseKatalogCsv(csv: string, optionen: KatalogCsvOptionen = {}): KatalogLadung {
  const trenn = optionen.trennzeichen ?? KATALOG_TRENNZEICHEN_STANDARD;
  // Ersetzungszeichen stammen aus falsch dekodierten Dateien, Nullbytes aus UTF-16.
  if (csv.includes('�') || csv.includes('\0')) throw new QuelleFehler(KATALOG_TEXT_KODIERUNG);
  const [kopfZeile, ...daten] = zeilenLesen(csv, trenn);
  if (!kopfZeile) throw new QuelleFehler('Die Datei ist leer.');
  const kopfRoh = kopfZeile.felder;
  // Ein Zeilenumbruch in der Kopfzeile heißt: Ein Anführungszeichen hat Datenzeilen verschluckt, die sonst als fehlend gälten.
  if (kopfRoh.some((f) => ZEILENUMBRUCH.test(f))) {
    throw new QuelleFehler(
      'Die Kopfzeile enthält einen Zeilenumbruch: Vermutlich hat ein Anführungszeichen Zeilen verschluckt.',
    );
  }
  const s = spaltenFinden(kopfRoh, csv, trenn, optionen.spalten);
  if (daten.length === 0) throw new QuelleFehler('Die Datei enthält keine Projekte.');
  if (daten.length > KATALOG_IMPORT_MAX) {
    throw new QuelleFehler(`Höchstens ${KATALOG_IMPORT_MAX} Projekte je Import.`);
  }

  const eintraege: KatalogEintrag[] = [];
  const gesehen = new Set<string>();
  const geschuetzt = new Set<string>();
  const meldungen: string[] = [];
  const hinweise: string[] = [];
  const zugeordnet = new Set([s.id, s.nummer, s.name, s.kunde, s.aktiv, s.parent]);
  let abgelehnt = 0;
  let nummerUnlesbar = false;
  const ablehnen = (zeile: number, grund: string) => {
    abgelehnt += 1;
    if (meldungen.length < KATALOG_ABGELEHNT_MELDUNGEN_MAX) {
      meldungen.push(`Zeile ${zeile}: ${grund}`);
    }
  };

  for (const { felder, nummer: zeile } of daten) {
    // Abweichende Spaltenzahl: Ein Trennzeichen oder Anführungszeichen im Feld verschiebt die Werte, auch die Nummer.
    if (felder.length !== kopfRoh.length) {
      nummerUnlesbar = true;
      ablehnen(zeile, 'Spaltenzahl weicht von der Kopfzeile ab.');
      continue;
    }
    // In einer Spalte, die nicht zählt, ist mehrzeiliger Text erlaubt. Sieht aber eine Zeile darin wie eine CSV-Zeile aus,
    // kann ein verirrtes Anführungszeichen ganze Zeilen verschluckt haben.
    if (
      felder.some((f, i) => !zugeordnet.has(i) && verschlucktWomoeglich(f, trenn, felder.length))
    ) {
      nummerUnlesbar = true;
      if (hinweise.length < KATALOG_ABGELEHNT_MELDUNGEN_MAX) {
        hinweise.push(
          `Zeile ${zeile}: Mehrzeiliger Text mit Trennzeichen, womöglich sind Zeilen verschluckt.`,
        );
      }
    }
    const idRoh = felder[s.id] ?? '';
    const id = idRoh.trim();
    if (
      id.length === 0 ||
      id.length > KATALOG_ID_MAX ||
      ZEILENUMBRUCH.test(idRoh) ||
      katalogTextUnsauber(id)
    ) {
      nummerUnlesbar = true;
      ablehnen(zeile, 'Externe ID fehlt, ist zu lang oder enthält Steuerzeichen.');
      continue;
    }
    const doppelt = gesehen.has(id);
    gesehen.add(id);
    // Zeilenumbruch in einer Spalte, die zählt: Ein Anführungszeichen hat vermutlich Zeilen verschluckt, deren
    // Projekte sonst als fehlend gälten. Geprüft vor dem Kürzen, ein Umbruch am Feldende zählt mit. Vor der Dublettenprüfung:
    // Auch eine doppelte Zeile kann Zeilen verschluckt haben.
    if (
      [s.nummer, s.name, s.kunde, s.aktiv, s.parent].some(
        (i) => i >= 0 && ZEILENUMBRUCH.test(felder[i] ?? ''),
      )
    ) {
      geschuetzt.add(id);
      nummerUnlesbar = true;
      ablehnen(zeile, 'Zeilenumbruch in einer Spalte, die zählt.');
      continue;
    }
    // Die erste Zeile einer ID entscheidet, auch wenn sie selbst abgelehnt wird.
    if (doppelt) {
      ablehnen(zeile, 'Externe ID kommt doppelt vor, die erste Zeile gilt.');
      continue;
    }
    // Eine fehlende Spalte heißt: Der gespeicherte Wert bleibt. Ein leeres Feld leert ihn.
    const zelle = (i: number) => (i >= 0 ? (felder[i] ?? '').trim() : undefined);
    const name = zelle(s.name) ?? '';
    const nummer = zelle(s.nummer);
    const kunde = zelle(s.kunde);
    const parent = zelle(s.parent);
    if ([name, nummer, kunde, parent].some((w) => w !== undefined && katalogTextUnsauber(w))) {
      geschuetzt.add(id);
      nummerUnlesbar = true;
      ablehnen(zeile, 'Steuerzeichen in Name, Nummer, Kunde oder Parent.');
      continue;
    }
    const aktivZelle = zelle(s.aktiv);
    // Leer heißt aktiv, sonst dieselben Wörter wie beim Push.
    const aktiv = aktivZelle ? katalogJaNein(aktivZelle) : true;
    if (aktiv === undefined) {
      geschuetzt.add(id);
      ablehnen(zeile, 'Wert in „Aktiv/Status“ nicht erkannt.');
      continue;
    }
    const e = katalogEintragSchema.safeParse({
      externe_id: id,
      nummer,
      name,
      kunde,
      parent,
      aktiv,
      status: aktivZelle?.slice(0, KATALOG_STATUS_MAX),
    });
    if (!e.success) {
      geschuetzt.add(id);
      ablehnen(zeile, 'Name fehlt oder ein Feld ist zu lang.');
      continue;
    }
    eintraege.push(e.data);
  }
  return {
    eintraege,
    geschuetzt: [...geschuetzt],
    abgelehnt,
    meldungen,
    nummerUnlesbar,
    hinweise,
  };
}

export function csvQuelle(csv: string, optionen: KatalogCsvOptionen = {}): ProjektQuelle {
  return { name: 'csv', projekteLaden: () => Promise.resolve(leseKatalogCsv(csv, optionen)) };
}

/** Rohdaten aus Upload oder Datei. */
export function csvDateiQuelle(
  bytes: Uint8Array,
  optionen: KatalogCsvOptionen = {},
): ProjektQuelle {
  return {
    name: 'csv',
    projekteLaden: () =>
      Promise.resolve().then(() => leseKatalogCsv(katalogCsvDekodieren(bytes), optionen)),
  };
}
