// Baum des Projektkatalogs: Reihenfolge, Robustheit gegen schlechte Daten, Filter mit Vorfahren und Laufzeit am Limit.
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
  const baum = katalogBaumBauen([
    p('W', null, 'Webshop'),
    p('W-1', 'W', 'AP Login'),
    p('W-1-1', 'W-1', 'Passwort'),
    p('W-2', 'W', 'AP Bezahlen'),
    p('X', null, 'Portal'),
  ]);

  it('behält die Vorfahren eines Treffers als Kontext, Geschwister nicht', () => {
    const f = katalogBaumFiltern(baum, (x) => x.name === 'Passwort');
    expect(f.map((z) => [z.projekt.externe_id, z.treffer])).toEqual([
      ['W', false],
      ['W-1', false],
      ['W-1-1', true],
    ]);
  });

  it('ein Treffer auf dem Elternprojekt bleibt Treffer, seine Kinder ohne Treffer bleiben weg', () => {
    const f = katalogBaumFiltern(baum, (x) => x.name === 'Webshop' || x.name === 'Passwort');
    expect(f.map((z) => [z.projekt.externe_id, z.treffer])).toEqual([
      ['W', true],
      ['W-1', false],
      ['W-1-1', true],
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
    const liste: (KatalogBaumKnoten & { kunde: string })[] = [];
    for (let i = 0; i < 20_000; i++) {
      const stufe = i % 4;
      liste.push({
        externe_id: `id-${i}`,
        parent_externe_id: stufe === 0 ? null : `id-${i - 1}`,
        nummer: `P-${i}`,
        name: `Projekt ${i} mit etwas längerem Namen`,
        kunde: `Kunde ${i % 50}`,
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
});
