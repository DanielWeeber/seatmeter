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

const idVergleich = (a: KatalogBaumKnoten, b: KatalogBaumKnoten) =>
  a.externe_id < b.externe_id ? -1 : a.externe_id > b.externe_id ? 1 : 0;

function vergleich(a: KatalogBaumKnoten, b: KatalogBaumKnoten): number {
  return (
    SORTIERUNG.compare(a.nummer, b.nummer) ||
    SORTIERUNG.compare(a.name, b.name) ||
    idVergleich(a, b)
  );
}

/** Wurzeln nach Name: Bei tausenden Wurzeln sucht man den Namen, nicht die Nummer. */
function wurzelVergleich(a: KatalogBaumKnoten, b: KatalogBaumKnoten): number {
  return (
    SORTIERUNG.compare(a.name, b.name) ||
    SORTIERUNG.compare(a.nummer, b.nummer) ||
    idVergleich(a, b)
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

/** Baumreihenfolge: Eltern vor Kindern, Wurzeln nach Name, Geschwister stabil nach Nummer, Name und ID. */
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
  wurzeln.sort(wurzelVergleich);
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

export type KatalogBaumTreffer<T> = KatalogBaumZeile<T> & {
  /** Teil des Ergebnisses: passt selbst oder liegt unter einem Treffer. `false` = Vorfahre, nur Kontext. */
  treffer: boolean;
};

/**
 * Was die Auswahl zeigt, in Baumreihenfolge, O(n). Ein Treffer zeigt seine Vorfahren als Kontext und alles darunter, das
 * zu Aktivem führt: Sucht jemand ein geschlossenes Projekt, sieht er dessen offene Arbeitspakete. Ein inaktiver Eintrag
 * bleibt nur, wenn etwas Aktives darunter liegt, auch in der Suche; sonst führt er zu nichts Wählbarem.
 * `erbt`: Darf ein Nachfahre von seinem Treffer übernommen werden? Ein abgelehnter Nachfahre gibt das nicht weiter.
 */
export function katalogBaumFiltern<T extends { aktiv: boolean }>(
  zeilen: readonly KatalogBaumZeile<T>[],
  trifft: (projekt: T) => boolean,
  erbt: (projekt: T) => boolean = () => true,
): KatalogBaumTreffer<T>[] {
  const n = zeilen.length;
  const fuehrtZuAktivem = new Uint8Array(n);
  // Eltern stehen vor ihren Kindern, rückwärts ist jedes Kind schon bewertet.
  for (let i = n - 1; i >= 0; i--) {
    const z = zeilen[i]!;
    if (z.projekt.aktiv) fuehrtZuAktivem[i] = 1;
    if (fuehrtZuAktivem[i] === 1 && z.elternIndex !== null) fuehrtZuAktivem[z.elternIndex] = 1;
  }
  const behalten = new Uint8Array(n);
  const treffer = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (fuehrtZuAktivem[i] === 0) continue;
    const z = zeilen[i]!;
    const geerbt = z.elternIndex !== null && treffer[z.elternIndex] === 1 && erbt(z.projekt);
    if (!geerbt && !trifft(z.projekt)) continue;
    treffer[i] = 1;
    // Über den echten Elternindex: Die Tiefe allein stimmte nach der Tiefengrenze nicht mehr.
    let j: number | null = i;
    while (j !== null && behalten[j] === 0) {
      behalten[j] = 1;
      j = zeilen[j]!.elternIndex;
    }
  }
  const ergebnis: KatalogBaumTreffer<T>[] = [];
  zeilen.forEach((z, i) => {
    if (behalten[i] === 1) ergebnis.push({ ...z, treffer: treffer[i] === 1 });
  });
  return ergebnis;
}
