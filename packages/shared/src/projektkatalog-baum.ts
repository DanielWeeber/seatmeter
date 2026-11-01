// Baum des Projektkatalogs als reine Funktionen (Server und Dashboard): Projekte dürfen verschachtelt sein. Die Eingabe
// ist eine flache Liste in beliebiger Reihenfolge. Nichts geht verloren: Unbekanntes Elternprojekt, Selbstbezug und
// Zyklen ergeben Wurzeln; ab der Tiefengrenze beginnt eine neue Wurzel. Laufzeit O(n log n), ohne Rekursion.

/** Tiefste Einrückung; darunter beginnt eine neue Wurzel, damit Pfade klein bleiben. */
export const KATALOG_BAUM_MAX_TIEFE = 20;
export const KATALOG_PFAD_TRENNER = ' › ';

export interface KatalogBaumKnoten {
  externe_id: string;
  parent_externe_id: string | null;
  nummer: string;
  name: string;
}

export interface KatalogBaumZeile<T> {
  projekt: T;
  tiefe: number;
  /** Namen von der Wurzel bis zu diesem Projekt. */
  pfad: readonly string[];
  /** Index des Elternprojekts in dieser Liste; `null` bei Wurzeln, auch nach der Tiefengrenze. */
  elternIndex: number | null;
}

export function katalogPfadText(pfad: readonly string[]): string {
  return pfad.join(KATALOG_PFAD_TRENNER);
}

const SORTIERUNG = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function vergleich(a: KatalogBaumKnoten, b: KatalogBaumKnoten): number {
  return (
    SORTIERUNG.compare(a.nummer, b.nummer) ||
    SORTIERUNG.compare(a.name, b.name) ||
    (a.externe_id < b.externe_id ? -1 : a.externe_id > b.externe_id ? 1 : 0)
  );
}

/** Eltern je ID: nur bekannte, fremde Eltern; alle Knoten eines Zyklus werden zu Wurzeln. */
function elternAufloesen<T extends KatalogBaumKnoten>(je: ReadonlyMap<string, T>) {
  const eltern = new Map<string, string | null>();
  for (const [id, p] of je) {
    const e = p.parent_externe_id;
    eltern.set(id, e !== null && e !== id && je.has(e) ? e : null);
  }
  const fertig = new Set<string>();
  const unterwegs = new Set<string>();
  for (const start of je.keys()) {
    const weg: string[] = [];
    let k: string | null = start;
    while (k !== null && !fertig.has(k) && !unterwegs.has(k)) {
      unterwegs.add(k);
      weg.push(k);
      k = eltern.get(k) ?? null;
    }
    if (k !== null && unterwegs.has(k)) {
      for (const z of weg.slice(weg.indexOf(k))) eltern.set(z, null);
    }
    for (const z of weg) {
      unterwegs.delete(z);
      fertig.add(z);
    }
  }
  return eltern;
}

/** Baumreihenfolge: Eltern vor Kindern, Geschwister stabil nach Nummer, Name und ID. */
export function katalogBaumBauen<T extends KatalogBaumKnoten>(
  projekte: readonly T[],
): KatalogBaumZeile<T>[] {
  const je = new Map<string, T>();
  for (const p of projekte) if (!je.has(p.externe_id)) je.set(p.externe_id, p);
  const eltern = elternAufloesen(je);
  const wurzeln: T[] = [];
  const kinder = new Map<string, T[]>();
  for (const [id, p] of je) {
    const e = eltern.get(id) ?? null;
    if (e === null) wurzeln.push(p);
    else {
      const liste = kinder.get(e);
      if (liste) liste.push(p);
      else kinder.set(e, [p]);
    }
  }
  wurzeln.sort(vergleich);
  const zeilen: KatalogBaumZeile<T>[] = [];
  const stapel: KatalogBaumZeile<T>[] = [];
  for (let i = wurzeln.length - 1; i >= 0; i--) {
    const p = wurzeln[i]!;
    stapel.push({ projekt: p, tiefe: 0, pfad: [p.name], elternIndex: null });
  }
  while (stapel.length > 0) {
    const z = stapel.pop()!;
    const index = zeilen.length;
    zeilen.push(z);
    const liste = kinder.get(z.projekt.externe_id);
    if (!liste) continue;
    liste.sort(vergleich);
    const zuTief = z.tiefe >= KATALOG_BAUM_MAX_TIEFE;
    for (let i = liste.length - 1; i >= 0; i--) {
      const p = liste[i]!;
      stapel.push(
        zuTief
          ? { projekt: p, tiefe: 0, pfad: [p.name], elternIndex: null }
          : { projekt: p, tiefe: z.tiefe + 1, pfad: [...z.pfad, p.name], elternIndex: index },
      );
    }
  }
  return zeilen;
}

export type KatalogBaumTreffer<T> = KatalogBaumZeile<T> & { treffer: boolean };

/** Treffer plus ihre Vorfahren als Kontext, in Baumreihenfolge; `treffer` unterscheidet beide. O(n). */
export function katalogBaumFiltern<T>(
  zeilen: readonly KatalogBaumZeile<T>[],
  trifft: (projekt: T) => boolean,
): KatalogBaumTreffer<T>[] {
  const behalten = new Uint8Array(zeilen.length);
  const treffer = new Uint8Array(zeilen.length);
  zeilen.forEach((z, i) => {
    if (!trifft(z.projekt)) return;
    treffer[i] = 1;
    // Über den echten Elternindex: Die Tiefe allein stimmte nach der Tiefengrenze nicht mehr.
    let j: number | null = i;
    while (j !== null && behalten[j] === 0) {
      behalten[j] = 1;
      j = zeilen[j]!.elternIndex;
    }
  });
  const ergebnis: KatalogBaumTreffer<T>[] = [];
  zeilen.forEach((z, i) => {
    if (behalten[i] === 1) ergebnis.push({ ...z, treffer: treffer[i] === 1 });
  });
  return ergebnis;
}
