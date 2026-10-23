// Golden-Test: reproduziert das Rechenbeispiel aus Architektur §5 auf den Cent (Pflichttest §8).
// Annahmen, die §5 offenlässt (hier festgelegt):
// - Alle Anfragen eines Postens liegen am 2026-10-14; P-Bs Überschreitung (15 $) fällt auf denselben Tag.
// - Cache-Schreibvorgänge sind vollständig 1h (cache_write_1h = cache_write), global, kein Fast Mode.
// - Sitzkosten jährlich abgerechnet: Premium 100 $/Monat, Standard 20 $/Monat; code_anteil_sitz = 1,0.
// - Rundung: Projektpreis erst auf US-Cent, dann mit dem Kurs 0,86 auf EUR-Cent (so ergibt §5 489,74 €).
// Varianten „gleich“ und „pool“ (von Hand gerechnet, gleiche Daten, Schatten nach Abzug 367 $ / 37 $):
// - gleich: P-A 100 $ / 2 Projekte = 50 $ je Projekt, P-B 100 $ an x-shop, P-C 20 $ an „ungenutzt“.
//   x-shop 367 + 150 + 15 = 532,00 $ → × 0,86 = 457,52 €; y-portal 37 + 50 = 87,00 $ → 74,82 €.
// - pool: Σ K = 220 $ (auch P-Cs ungenutzter Sitz, Formel §5), Σ S = 404 $.
//   x-shop 220 · 367/404 = 199,851485 $ → 367 + 199,851485 + 15 = 581,851485 $ ≈ 581,85 $ → 500,39 €;
//   y-portal 220 · 37/404 = 20,148515 $ → 57,148515 $ ≈ 57,15 $ → 49,149 € ≈ 49,15 €; „ungenutzt“ 0.
// - person mit code_anteil_sitz 0,5 und schatten_faktor 1,1: K = 50/50/10 $.
//   x-shop 1,1 · 367 + 50 · 258/295 + 50 + 15 = 403,7 + 43,728814 + 65 = 512,428814 $ ≈ 512,43 $ → 440,69 €;
//   y-portal 1,1 · 37 + 50 · 37/295 = 40,7 + 6,271186 = 46,971186 $ ≈ 46,97 $ → 40,39 €; ungenutzt 10 $ → 8,60 €.
import { describe, expect, it } from 'vitest';
import {
  berechneProjektpreise,
  type KalkulationEingabe,
  type SchattenPosten,
} from './kalkulation.js';
import { schattenpreis } from './schatten.js';
import { PREIS_SEED } from './seed.js';

const TAG = '2026-10-14';
const M = 1_000_000;

const posten = [
  {
    person: 'P-A',
    projekt: 'x-shop',
    model: 'claude-opus-5-5',
    t: [2 * M, 1.5 * M, 300 * M, 20 * M],
  },
  {
    person: 'P-A',
    projekt: 'y-portal',
    model: 'claude-sonnet-5-5',
    t: [1 * M, 0.5 * M, 100 * M, 5 * M],
  },
  {
    person: 'P-B',
    projekt: 'x-shop',
    model: 'claude-opus-5-5',
    t: [1 * M, 0.5 * M, 150 * M, 10 * M],
  },
] as const;

function schattenPosten(): SchattenPosten[] {
  return posten.map((p) => {
    const [input, output, cache_read, cache_write] = p.t;
    const r = schattenpreis(
      {
        model: p.model,
        ts: `${TAG}T09:00:00Z`,
        input,
        output,
        cache_read,
        cache_write,
        cache_write_1h: cache_write,
      },
      PREIS_SEED,
    );
    if (!r) throw new Error(`kein Preis für ${p.model}`);
    return { person: p.person, projekt: p.projekt, tag: TAG, usdMicros: r.usdMicros };
  });
}

describe('Golden-Test Kalkulation (Architektur §5)', () => {
  it('Schattenpreise je Zeile: 258 $, 37 $, 124 $', () => {
    expect(schattenPosten().map((p) => p.usdMicros)).toEqual([258 * M, 37 * M, 124 * M]);
  });

  it('Projektpreise x-shop 569,46 $ ≈ 489,74 €, y-portal 49,54 $ ≈ 42,60 €, ungenutzt 20 $ ≈ 17,20 €', () => {
    const e = berechneProjektpreise({
      schatten: schattenPosten(),
      ueberschreitungen: [
        { person: 'P-B', tag: TAG, amountUsdMicros: 15 * M, listAmountUsdMicros: 15 * M },
      ],
      sitzkosten: [
        { person: 'P-A', usdMicros: 100 * M },
        { person: 'P-B', usdMicros: 100 * M },
        { person: 'P-C', usdMicros: 20 * M },
      ],
      schattenFaktor: 1,
      kursUsdEur: 0.86,
    });

    const x = e.projekte.get('x-shop');
    const y = e.projekte.get('y-portal');
    // Abzug am Schatten: 258 + 124 − 15 = 367 $ bzw. 37 $.
    expect(x?.schattenUsdMicros).toBe(367 * M);
    expect(y?.schattenUsdMicros).toBe(37 * M);
    // Sitzanteil: P-A 100 $ × 258/295 = 87,46 $ an x-shop, 12,54 $ an y-portal; P-B 100 $ an x-shop.
    expect(Math.round((x?.sitzanteilUsdMicros ?? 0) / 10_000)).toBe(18_746);
    expect(Math.round((y?.sitzanteilUsdMicros ?? 0) / 10_000)).toBe(1_254);
    expect(x?.ueberschreitungUsdMicros).toBe(15 * M);
    expect(y?.ueberschreitungUsdMicros).toBe(0);

    expect(x?.projektpreisUsdCent).toBe(56_946);
    expect(x?.projektpreisEurCent).toBe(48_974);
    expect(y?.projektpreisUsdCent).toBe(4_954);
    expect(y?.projektpreisEurCent).toBe(4_260);
    expect(e.ungenutzt).toEqual({ usdMicros: 20 * M, usdCent: 2_000, eurCent: 1_720 });
  });
});

function beispiel(extra: Partial<KalkulationEingabe> = {}) {
  return berechneProjektpreise({
    schatten: schattenPosten(),
    ueberschreitungen: [
      { person: 'P-B', tag: TAG, amountUsdMicros: 15 * M, listAmountUsdMicros: 15 * M },
    ],
    sitzkosten: [
      { person: 'P-A', usdMicros: 100 * M },
      { person: 'P-B', usdMicros: 100 * M },
      { person: 'P-C', usdMicros: 20 * M },
    ],
    schattenFaktor: 1,
    kursUsdEur: 0.86,
    ...extra,
  });
}

describe('Golden-Test Sitzkosten-Varianten (Architektur §5)', () => {
  it('gleich: x-shop 532,00 $ ≈ 457,52 €, y-portal 87,00 $ ≈ 74,82 €, ungenutzt 20 $', () => {
    const e = beispiel({ verteilung: 'gleich' });
    const x = e.projekte.get('x-shop');
    const y = e.projekte.get('y-portal');
    expect(e.verteilung).toBe('gleich');
    expect(x?.sitzanteilUsdMicros).toBe(150 * M);
    expect(y?.sitzanteilUsdMicros).toBe(50 * M);
    expect(x?.projektpreisUsdCent).toBe(53_200);
    expect(x?.projektpreisEurCent).toBe(45_752);
    expect(y?.projektpreisUsdCent).toBe(8_700);
    expect(y?.projektpreisEurCent).toBe(7_482);
    expect(e.ungenutzt).toEqual({ usdMicros: 20 * M, usdCent: 2_000, eurCent: 1_720 });
    expect(e.sitzkostenUsdMicros).toBe(220 * M);
  });

  it('pool: x-shop 581,85 $ ≈ 500,39 €, y-portal 57,15 $ ≈ 49,15 €, ungenutzt 0', () => {
    const e = beispiel({ verteilung: 'pool' });
    const x = e.projekte.get('x-shop');
    const y = e.projekte.get('y-portal');
    expect(x?.sitzanteilUsdMicros).toBe(199_851_485);
    expect(y?.sitzanteilUsdMicros).toBe(20_148_515);
    expect(x?.projektpreisUsdCent).toBe(58_185);
    expect(x?.projektpreisEurCent).toBe(50_039);
    expect(y?.projektpreisUsdCent).toBe(5_715);
    expect(y?.projektpreisEurCent).toBe(4_915);
    expect(e.ungenutzt).toEqual({ usdMicros: 0, usdCent: 0, eurCent: 0 });
  });

  it('pool ohne Schatten im Monat: alle Sitzkosten in „ungenutzt“', () => {
    const e = berechneProjektpreise({
      schatten: [],
      sitzkosten: [{ person: 'P-C', usdMicros: 20 * M }],
      verteilung: 'pool',
      schattenFaktor: 1,
      kursUsdEur: 0.86,
    });
    expect(e.projekte.size).toBe(0);
    expect(e.ungenutzt.usdCent).toBe(2_000);
  });

  it('person mit code_anteil_sitz 0,5 und schatten_faktor 1,1', () => {
    const e = beispiel({ codeAnteilSitz: 0.5, schattenFaktor: 1.1 });
    const x = e.projekte.get('x-shop');
    const y = e.projekte.get('y-portal');
    expect(x?.projektpreisUsdCent).toBe(51_243);
    expect(x?.projektpreisEurCent).toBe(44_069);
    expect(y?.projektpreisUsdCent).toBe(4_697);
    expect(y?.projektpreisEurCent).toBe(4_039);
    expect(e.ungenutzt).toEqual({ usdMicros: 10 * M, usdCent: 1_000, eurCent: 860 });
    expect(e.sitzkostenUsdMicros).toBe(110 * M);
  });

  it('ohne Überschreitungsdaten: kein Abzug, Kennzeichen „nicht abgezogen“', () => {
    const e = beispiel({ ueberschreitungen: null });
    expect(e.ueberschreitungAbgezogen).toBe(false);
    expect(e.projekte.get('x-shop')?.schattenUsdMicros).toBe(382 * M);
    expect(e.projekte.get('x-shop')?.ueberschreitungUsdMicros).toBe(0);
    expect(beispiel().ueberschreitungAbgezogen).toBe(true);
  });

  it('ohne Kurs: EUR-Werte null, USD unverändert', () => {
    const e = beispiel({ kursUsdEur: null });
    expect(e.projekte.get('x-shop')?.projektpreisUsdCent).toBe(56_946);
    expect(e.projekte.get('x-shop')?.projektpreisEurCent).toBeNull();
    expect(e.ungenutzt.eurCent).toBeNull();
  });
});
