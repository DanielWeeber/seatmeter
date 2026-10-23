import { describe, expect, it } from 'vitest';
import { findePreis, schattenpreis } from './schatten.js';
import { PREIS_SEED } from './seed.js';
import { preisZeileSchema, type PreisZeile } from './typen.js';

const zeile = (praefix: string, gueltigAb: string, input: number, mandant: string | null = null) =>
  preisZeileSchema.parse({
    mandant_id: mandant,
    modell_praefix: praefix,
    gueltig_ab: gueltigAb,
    saetze: { input, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
    quelle_url: 'https://example.org/preise',
    geprueft_am: '2026-10-22',
  });

describe('findePreis (Architektur §2.5)', () => {
  it('längster Präfix gewinnt (claude-opus-5 trifft nicht claude-opus-5-5)', () => {
    expect(findePreis(PREIS_SEED, 'claude-opus-5-5', '2026-10-22')?.modell_praefix).toBe(
      'claude-opus-5-5',
    );
    expect(findePreis(PREIS_SEED, 'claude-opus-5-20261001', '2026-10-22')?.modell_praefix).toBe(
      'claude-opus-5',
    );
    expect(findePreis(PREIS_SEED, 'claude-sonnet-4-5-20250929', '2026-10-22')?.modell_praefix).toBe(
      'claude-sonnet-4-5',
    );
    expect(findePreis(PREIS_SEED, 'CLAUDE-HAIKU-5-5', '2026-10-22')?.modell_praefix).toBe(
      'claude-haiku-5-5',
    );
  });

  it('beachtet gueltig_ab und nimmt die jüngste gültige Zeile', () => {
    const tabelle: PreisZeile[] = [zeile('m-a', '2026-01-01', 1), zeile('m-a', '2026-11-01', 2)];
    expect(findePreis(tabelle, 'm-a', '2026-10-31')?.saetze.input).toBe(1);
    expect(findePreis(tabelle, 'm-a', new Date('2026-11-01T00:00:00Z'))?.saetze.input).toBe(2);
    expect(findePreis(tabelle, 'm-a', '2025-12-31')).toBeNull();
  });

  it('Mandanten-Zeile geht der globalen bei gleichem Präfix und Datum vor', () => {
    const tabelle = [
      zeile('m-a', '2026-01-01', 1),
      zeile('m-a', '2026-01-01', 3, '01900000-0000-7000-8000-000000000001'),
    ];
    expect(findePreis(tabelle, 'm-a', '2026-10-22')?.saetze.input).toBe(3);
  });

  it('unbekanntes Modell hat keinen Preis', () => {
    expect(findePreis(PREIS_SEED, 'gpt-irgendwas', '2026-10-22')).toBeNull();
  });

  it('Startwerte laut offizieller Preisseite (Stand 2026-10-22)', () => {
    const opus = findePreis(PREIS_SEED, 'claude-opus-5-5', '2026-10-22');
    expect(opus?.saetze).toEqual({
      input: 4,
      output: 20,
      cache_read: 0.2,
      cache_write_5m: 5,
      cache_write_1h: 8,
    });
    const sonnet = findePreis(PREIS_SEED, 'claude-sonnet-5-5', '2026-10-22');
    expect(sonnet?.saetze).toEqual({
      input: 2,
      output: 10,
      cache_read: 0.1,
      cache_write_5m: 2.5,
      cache_write_1h: 4,
    });
    for (const z of PREIS_SEED) {
      expect(z.quelle_url).toMatch(/^https:\/\//);
      expect(z.geprueft_am).toBe('2026-10-22');
    }
  });
});

describe('schattenpreis (Architektur §5)', () => {
  const basis = { ts: '2026-10-22T10:00:00Z', input: 0, output: 0, cache_read: 0, cache_write: 0 };

  it('rechnet je Tokentyp mit den Sätzen der Tabelle', () => {
    const r = schattenpreis(
      {
        ...basis,
        model: 'claude-opus-5-5',
        input: 2_000_000,
        output: 1_500_000,
        cache_read: 300_000_000,
        cache_write: 20_000_000,
      },
      PREIS_SEED,
    );
    expect(r?.usdMicros).toBe(258_000_000);
  });

  it('nutzt 1h als Annahme, wenn die Aufteilung fehlt, sonst die Aufteilung', () => {
    const anfrage = { ...basis, model: 'claude-sonnet-5-5', cache_write: 1_000_000 };
    expect(schattenpreis(anfrage, PREIS_SEED)?.usdMicros).toBe(4_000_000);
    expect(schattenpreis(anfrage, PREIS_SEED, '5m')?.usdMicros).toBe(2_500_000);
    expect(schattenpreis({ ...anfrage, cache_write_1h: 400_000 }, PREIS_SEED)?.usdMicros).toBe(
      1_600_000 + 1_500_000,
    );
  });

  it('inference_geo = us kostet das 1,1-Fache (ab Claude 4.6)', () => {
    const a = { ...basis, model: 'claude-opus-5-5', input: 1_000_000, output: 1_000_000 };
    expect(schattenpreis({ ...a, inference_geo: 'us' }, PREIS_SEED)?.usdMicros).toBe(26_400_000);
    expect(schattenpreis({ ...a, inference_geo: 'global' }, PREIS_SEED)?.usdMicros).toBe(
      24_000_000,
    );
    const alt = { ...a, model: 'claude-opus-4-5-20251101', inference_geo: 'us' };
    expect(schattenpreis(alt, PREIS_SEED)?.usdMicros).toBe(30_000_000);
  });

  it('Fast Mode nutzt die Fast-Sätze, Cache-Multiplikatoren darauf', () => {
    const r = schattenpreis(
      {
        ...basis,
        model: 'claude-opus-5-5',
        speed: 'fast',
        input: 1_000_000,
        output: 1_000_000,
        cache_read: 1_000_000,
        cache_write: 1_000_000,
      },
      PREIS_SEED,
    );
    // 8 + 40 + 0,40 (0,05 × 8) + 16 (2 × 8, 1h) = 64,40 USD
    expect(r?.fast).toBe(true);
    expect(r?.usdMicros).toBe(64_400_000);
  });

  it('Fast Mode und US-Inferenz stapeln sich', () => {
    const r = schattenpreis(
      { ...basis, model: 'claude-opus-5-5', speed: 'fast', inference_geo: 'us', output: 1_000_000 },
      PREIS_SEED,
    );
    expect(r?.usdMicros).toBe(44_000_000);
  });

  it('Haiku 5.5: über 100.000 Prompt-Tokens gelten die Langkontext-Preise', () => {
    const kurz = schattenpreis(
      { ...basis, model: 'claude-haiku-5-5', input: 50_000, cache_read: 50_000, output: 1_000 },
      PREIS_SEED,
    );
    expect(kurz?.langkontext).toBe(false);
    expect(kurz?.usdMicros).toBe(5_000 + 500 + 500);
    const lang = schattenpreis(
      { ...basis, model: 'claude-haiku-5-5', input: 50_000, cache_read: 50_001, output: 1_000 },
      PREIS_SEED,
    );
    expect(lang?.langkontext).toBe(true);
    // 50.000 × 0,50 + 50.001 × 0,05 + 1.000 × 2,50 (Mikro-USD) = 25.000 + 2.500,05 + 2.500
    expect(lang?.usdMicros).toBe(30_000);
  });

  it('ohne Preis kein Schattenpreis', () => {
    expect(schattenpreis({ ...basis, model: 'unbekannt', input: 1 }, PREIS_SEED)).toBeNull();
  });
});
