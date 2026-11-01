// Baum des Projektkatalogs: Reihenfolge, Robustheit gegen schlechte Daten, Filter mit Vorfahren und Nachfahren, Laufzeit am Limit.
import { describe, expect, it } from 'vitest';
import {
  KATALOG_BAUM_MAX_TIEFE,
  katalogBaumBauen,
  katalogBaumFiltern,
  katalogPfadText,
  type KatalogBaumKnoten,
} from './projektkatalog-baum.js';

const p = (
  externe_id: string,
  parent: string | null = null,
  name = externe_id,
): KatalogBaumKnoten => ({
  externe_id,
  parent_externe_id: parent,
  nummer: externe_id,
  name,
});
const form = (liste: readonly KatalogBaumKnoten[]) =>
  katalogBaumBauen(liste).map((z) => `${' '.repeat(z.tiefe)}${z.projekt.externe_id}`);

describe('Baum bauen', () => {
  it('Eltern vor Kindern, Einrückung, Pfad, mehrere Wurzeln, Geschwister natürlich sortiert', () => {
    const liste = [
      p('W', null, 'Webshop'),
      p('W-10', 'W', 'AP Bezahlen'),
      p('W-2', 'W', 'AP Login'),
      p('W-2-1', 'W-2', 'Passwort'),
      p('A', null, 'Archiv'),
    ];
    expect(form(liste)).toEqual(['A', 'W', ' W-2', '  W-2-1', ' W-10']);
    const z = katalogBaumBauen(liste).find((x) => x.projekt.externe_id === 'W-2-1');
    expect(katalogPfadText(z?.pfad ?? [])).toBe('Webshop › AP Login › Passwort');
  });

  it('Reihenfolge der Eingabe ist egal, auch wenn das Kind vor dem Elternprojekt kommt', () => {
    const liste = [p('W'), p('W-1', 'W'), p('W-1-1', 'W-1'), p('B'), p('W-2', 'W')];
    const erwartet = form(liste);
    expect(form([...liste].reverse())).toEqual(erwartet);
    expect(form([liste[2]!, liste[4]!, liste[0]!, liste[3]!, liste[1]!])).toEqual(erwartet);
  });

  it('unbekanntes Elternprojekt: oberste Ebene', () => {
    expect(form([p('K', 'fehlt'), p('A')])).toEqual(['A', 'K']);
  });

  it('Selbstbezug und Zyklen hängen nicht und verlieren nichts', () => {
    expect(form([p('S', 'S')])).toEqual(['S']);
    expect(form([p('A', 'B'), p('B', 'C'), p('C', 'A')])).toEqual(['A', 'B', 'C']);
    // Kinder eines Zyklus bleiben unter ihrem Elternprojekt.
    expect(form([p('A', 'B'), p('B', 'A'), p('K', 'A'), p('Z')])).toEqual(['A', ' K', 'B', 'Z']);
  });

  it('Tiefengrenze: nichts geht verloren, Pfade bleiben kurz, auch bei einer langen Kette', () => {
    const kette = Array.from({ length: 5000 }, (_, i) => p(`n${i}`, i === 0 ? null : `n${i - 1}`));
    const z = katalogBaumBauen([...kette].reverse());
    expect(z).toHaveLength(5000);
    expect(new Set(z.map((x) => x.projekt.externe_id)).size).toBe(5000);
    expect(Math.max(...z.map((x) => x.tiefe))).toBe(KATALOG_BAUM_MAX_TIEFE);
    expect(Math.max(...z.map((x) => x.pfad.length))).toBe(KATALOG_BAUM_MAX_TIEFE + 1);
  });

  it('doppelte IDs erscheinen einmal', () => {
    expect(form([p('A'), p('A')])).toEqual(['A']);
  });
});

describe('Baum filtern', () => {
  const an = (k: KatalogBaumKnoten, aktiv = true) => ({ ...k, aktiv });
  const baum = katalogBaumBauen(
    [
      p('W', null, 'Webshop'),
      p('W-1', 'W', 'AP Login'),
      p('W-1-1', 'W-1', 'Passwort'),
      p('W-2', 'W', 'AP Bezahlen'),
      p('X', null, 'Portal'),
    ].map((k) => an(k)),
  );
  const zeilen = <T extends KatalogBaumKnoten>(
    f: readonly { projekt: T; treffer: boolean }[],
  ): [string, boolean][] => f.map((z) => [z.projekt.externe_id, z.treffer]);

  it('behält die Vorfahren eines Treffers als Kontext, Geschwister nicht', () => {
    const f = katalogBaumFiltern(baum, (x) => x.name === 'Passwort');
    expect(zeilen(f)).toEqual([
      ['W', false],
      ['W-1', false],
      ['W-1-1', true],
    ]);
  });

  it('ein Treffer zeigt alle aktiven Nachfahren, auf jeder Ebene', () => {
    const f = katalogBaumFiltern(baum, (x) => x.name === 'Webshop');
    expect(zeilen(f)).toEqual([
      ['W', true],
      ['W-1', true],
      ['W-1-1', true],
      ['W-2', true],
    ]);
    expect(zeilen(katalogBaumFiltern(baum, (x) => x.name === 'AP Login'))).toEqual([
      ['W', false],
      ['W-1', true],
      ['W-1-1', true],
    ]);
  });

  it('geschlossenes Elternprojekt mit offenem Kind: Suche nach dem Elternprojekt zeigt das Kind', () => {
    const b = katalogBaumBauen([
      an(p('E', null, 'Geschlossen'), false),
      an(p('E-1', 'E', 'Offen')),
      an(p('E-2', 'E', 'Auch zu'), false),
    ]);
    expect(zeilen(katalogBaumFiltern(b, (x) => x.name === 'Geschlossen'))).toEqual([
      ['E', true],
      ['E-1', true],
    ]);
    // Standardansicht: ausgegraut dabei, das geschlossene Kind ohne Aktives darunter nicht.
    expect(zeilen(katalogBaumFiltern(b, () => true))).toEqual([
      ['E', true],
      ['E-1', true],
    ]);
  });

  it('geschlossenes Elternprojekt nur mit geschlossenen Kindern: nirgends, auch nicht in der Suche', () => {
    const b = katalogBaumBauen([
      an(p('E', null, 'Geschlossen'), false),
      an(p('E-1', 'E', 'Zu'), false),
      an(p('E-1-1', 'E-1', 'Auch zu'), false),
      an(p('O', null, 'Offen')),
    ]);
    expect(zeilen(katalogBaumFiltern(b, () => true))).toEqual([['O', true]]);
    expect(katalogBaumFiltern(b, (x) => x.name === 'Geschlossen')).toEqual([]);
    expect(katalogBaumFiltern(b, (x) => x.name === 'Auch zu')).toEqual([]);
  });

  it('mehrere Ebenen: inaktive Zwischenebene bleibt nur auf dem Weg zu Aktivem', () => {
    const b = katalogBaumBauen([
      an(p('A', null, 'Oben'), false),
      an(p('A-1', 'A', 'Mitte zu, führt weiter'), false),
      an(p('A-1-1', 'A-1', 'Unten offen')),
      an(p('A-2', 'A', 'Mitte zu, Sackgasse'), false),
      an(p('A-2-1', 'A-2', 'Unten zu'), false),
      an(p('A-3', 'A', 'Mitte offen')),
      an(p('A-3-1', 'A-3', 'Unten zu unter offen'), false),
    ]);
    expect(zeilen(katalogBaumFiltern(b, (x) => x.name === 'Oben'))).toEqual([
      ['A', true],
      ['A-1', true],
      ['A-1-1', true],
      ['A-3', true],
    ]);
    expect(zeilen(katalogBaumFiltern(b, (x) => x.name === 'Unten offen'))).toEqual([
      ['A', false],
      ['A-1', false],
      ['A-1-1', true],
    ]);
    expect(katalogBaumFiltern(b, (x) => x.name === 'Unten zu')).toEqual([]);
  });

  it('nie gesendete Eltern: Das Kind bleibt Wurzel, auch im Filter', () => {
    const b = katalogBaumBauen([
      an(p('K', 'nie-gesendet', 'Kind')),
      an(p('L', 'nie-gesendet', 'Anderes Kind'), false),
    ]);
    expect(b.map((z) => z.tiefe)).toEqual([0, 0]);
    expect(zeilen(katalogBaumFiltern(b, () => true))).toEqual([['K', true]]);
  });

  it('Wurzeln nach Name, Geschwister stabil nach Nummer; jede Eingabereihenfolge ergibt dasselbe', () => {
    const liste = [
      an(p('3', null, 'Zentrale')),
      an(p('20', null, 'Archiv')),
      an(p('1', null, 'mitte')),
      an(p('1-10', '1', 'A')),
      an(p('1-9', '1', 'Z')),
      an(p('1-2', '1', 'M')),
    ];
    const ids = (l: typeof liste) =>
      katalogBaumFiltern(katalogBaumBauen(l), () => true).map((z) => z.projekt.externe_id);
    const erwartet = ['20', '1', '1-2', '1-9', '1-10', '3'];
    expect(ids(liste)).toEqual(erwartet);
    expect(ids([...liste].reverse())).toEqual(erwartet);
    expect(
      katalogBaumFiltern(katalogBaumBauen(liste), (x) => x.name === 'mitte').map(
        (z) => z.projekt.externe_id,
      ),
    ).toEqual(['1', '1-2', '1-9', '1-10']);
  });

  it('erbt: Ein abgelehnter Nachfahre gibt nichts weiter, die Kette bleibt zusammenhängend', () => {
    const b = katalogBaumBauen([
      an(p('A', null, 'Treffer')),
      an(p('A-1', 'A', 'Abgelehnt')),
      an(p('A-1-1', 'A-1', 'Darunter')),
      an(p('A-2', 'A', 'Erlaubt')),
    ]);
    const f = katalogBaumFiltern(
      b,
      (x) => x.name === 'Treffer',
      (x) => x.name !== 'Abgelehnt',
    );
    expect(zeilen(f)).toEqual([
      ['A', true],
      ['A-2', true],
    ]);
  });

  it('nach der Tiefengrenze behält der Filter die richtigen Vorfahren', () => {
    // Inaktive Kette über die Grenze hinaus, daneben ein aktives Kind derselben Wurzel, das danach sortiert.
    const liste: (KatalogBaumKnoten & { aktiv: boolean })[] = [
      { ...p('R'), aktiv: false },
      { ...p('Z', 'R'), aktiv: true },
    ];
    let vor = 'R';
    for (let i = 1; i <= 23; i += 1) {
      const id = `A${String(i).padStart(2, '0')}`;
      liste.push({ ...p(id, vor), aktiv: false });
      vor = id;
    }
    const f = katalogBaumFiltern(katalogBaumBauen(liste), (x) => x.aktiv);
    expect(f.map((z) => z.projekt.externe_id)).toEqual(['R', 'Z']);
    expect(f[1]?.treffer).toBe(true);
    expect(f[0]?.treffer).toBe(false);
  });

  it('kein Treffer: leer; alles trifft: alles', () => {
    expect(katalogBaumFiltern(baum, () => false)).toEqual([]);
    expect(katalogBaumFiltern(baum, () => true)).toHaveLength(baum.length);
  });
});

describe('Laufzeit am Limit von 20 000 Projekten', () => {
  it('bleibt deutlich unter einer Sekunde', () => {
    const liste: (KatalogBaumKnoten & { kunde: string; aktiv: boolean })[] = [];
    for (let i = 0; i < 20_000; i++) {
      const stufe = i % 4;
      liste.push({
        externe_id: `id-${i}`,
        parent_externe_id: stufe === 0 ? null : `id-${i - 1}`,
        nummer: `P-${i}`,
        name: `Projekt ${i} mit etwas längerem Namen`,
        kunde: `Kunde ${i % 50}`,
        aktiv: true,
      });
    }
    const a = performance.now();
    const baum = katalogBaumBauen(liste);
    const b = performance.now();
    const f = katalogBaumFiltern(baum, (x) =>
      `${x.nummer} ${x.name} ${x.kunde}`.toLowerCase().includes('19999'),
    );
    const c = performance.now();
    console.log(
      `Baum 20000: bauen ${(b - a).toFixed(1)} ms, filtern ${(c - b).toFixed(1)} ms, Treffer ${f.length}`,
    );
    expect(baum).toHaveLength(20_000);
    expect(f.some((z) => z.treffer)).toBe(true);
    expect(b - a).toBeLessThan(1000);
    expect(c - b).toBeLessThan(200);
  });

  it('10 000 Einträge, drei Viertel inaktiv: Bauen und Filtern bleiben klein', () => {
    const liste: (KatalogBaumKnoten & { aktiv: boolean })[] = [];
    for (let i = 0; i < 10_000; i++) {
      liste.push({
        externe_id: `id-${i}`,
        parent_externe_id: i % 4 === 0 ? `nie-${i}` : `id-${i - (i % 4)}`,
        nummer: `P-${i}`,
        name: `Projekt ${i} mit etwas längerem Namen`,
        aktiv: i % 4 === 3,
      });
    }
    const a = performance.now();
    const baum = katalogBaumBauen(liste);
    const b = performance.now();
    const alle = katalogBaumFiltern(baum, () => true);
    const c = performance.now();
    const suche = katalogBaumFiltern(baum, (x) => x.name.includes('Projekt 99'));
    const d = performance.now();
    console.log(
      `Baum 10000 (75 % inaktiv): bauen ${(b - a).toFixed(1)} ms, filtern ${(c - b).toFixed(1)} ms, ` +
        `suchen ${(d - c).toFixed(1)} ms, Zeilen ${alle.length}, Treffer Suche ${suche.length}`,
    );
    // Wurzel plus aktives Kind je Gruppe; die zwei inaktiven Geschwister bleiben weg.
    expect(alle).toHaveLength(5_000);
    expect(c - b).toBeLessThan(200);
    expect(d - c).toBeLessThan(200);
  });
});
