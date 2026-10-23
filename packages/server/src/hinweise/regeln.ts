// Regeln der Projekt-Hinweise als reine Funktion: Eingabe sind Monatssummen je Projekt aus dem
// Tagesaggregat, der Topf „ungenutzt“ der Kalkulation und die Budget-Prognosen. Datenqualitäts-Hinweise
// bleiben im Kern (Seite Datenqualität); hier geht es um Kosten und Arbeitsweise je Projekt.
import type { HinweisRegeln, HinweisTyp } from '@seatmeter/shared';

/** Monatssummen eines Projekts (`null` = Topf „unzugeordnet“), Beträge in Mikro-USD. */
export interface ProjektSummen {
  projektId: string | null;
  schattenUsdMicros: number;
  /** Kosten der Cache-Schreibvorgänge (Näherung: Schattenpreis nur der cache_write-Tokens). */
  cacheWriteUsdMicros: number;
  fastUsdMicros: number;
  opusUsdMicros: number;
  /** Modelle ohne Preis (Tagesaggregat ohne `preis_version`). */
  modelleOhnePreis: string[];
}

export interface BudgetPrognose {
  projektId: string | null;
  name: string;
  betrag: number;
  prognose: number;
  einheit: string;
}

export interface HinweisEingabe {
  projekte: readonly ProjektSummen[];
  ungenutztUsdMicros: number;
  budgets: readonly BudgetPrognose[];
  regeln: HinweisRegeln;
}

export interface NeuerHinweis {
  projektId: string | null;
  typ: HinweisTyp;
  text: string;
  wert: number | null;
}

const prozent = (teil: number, ganz: number) =>
  ganz > 0 ? Math.round((teil / ganz) * 1000) / 10 : 0;
const de = (x: number, stellen = 1) =>
  x.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
const usd = (mikro: number) => `${de(mikro / 1_000_000, 2)} $`;

export function erzeugeHinweise(e: HinweisEingabe): NeuerHinweis[] {
  const r = e.regeln;
  const aus: NeuerHinweis[] = [];
  const mindest = r.mindest_usd * 1_000_000;
  const gesamt = e.projekte.reduce((s, p) => s + p.schattenUsdMicros, 0);

  for (const p of e.projekte) {
    if (p.modelleOhnePreis.length > 0) {
      aus.push({
        projektId: p.projektId,
        typ: 'modell_ohne_preis',
        text: `Modell ohne Preis: ${p.modelleOhnePreis.join(', ')}. Schattenpreis zählt 0; Preistabelle ergänzen.`,
        wert: p.modelleOhnePreis.length,
      });
    }
    if (p.projektId === null || p.schattenUsdMicros < mindest || p.schattenUsdMicros <= 0) continue;
    const cw = prozent(p.cacheWriteUsdMicros, p.schattenUsdMicros);
    if (cw > r.cache_write_prozent) {
      aus.push({
        projektId: p.projektId,
        typ: 'cache_write',
        text: `Prompt-Caching prüfen: ${de(cw)} % des Schattenpreises sind Cache-Schreibvorgänge (Schwelle ${de(r.cache_write_prozent, 0)} %). Häufig wechselnde Kontexte oder kurze Sitzungen schreiben den Cache immer neu.`,
        wert: cw,
      });
    }
    const fast = prozent(p.fastUsdMicros, p.schattenUsdMicros);
    if (fast > r.fast_prozent) {
      aus.push({
        projektId: p.projektId,
        typ: 'fast_mode',
        text: `Fast-Mode-Anteil ${de(fast)} % des Schattenpreises (Schwelle ${de(r.fast_prozent, 0)} %). Fast Mode kostet ein Vielfaches; nur bei Bedarf nutzen.`,
        wert: fast,
      });
    }
    const opus = prozent(p.opusUsdMicros, p.schattenUsdMicros);
    if (opus > r.opus_prozent) {
      aus.push({
        projektId: p.projektId,
        typ: 'opus_anteil',
        text: `Opus-Anteil ${de(opus)} % des Schattenpreises (Schwelle ${de(r.opus_prozent, 0)} %). Prüfen, ob Sonnet für Routineaufgaben reicht.`,
        wert: opus,
      });
    }
  }

  const unzugeordnet = e.projekte.find((p) => p.projektId === null);
  if (unzugeordnet && gesamt > 0) {
    const anteil = prozent(unzugeordnet.schattenUsdMicros, gesamt);
    if (anteil > r.unzugeordnet_prozent) {
      aus.push({
        projektId: null,
        typ: 'unzugeordnet',
        text: `Sitzungen ohne Git-Remote: ${de(anteil)} % des Schattenpreises sind keinem Projekt zugeordnet (Schwelle ${de(r.unzugeordnet_prozent, 0)} %). Repos mit origin-Remote anlegen bzw. dort arbeiten.`,
        wert: anteil,
      });
    }
  }

  if (e.ungenutztUsdMicros > 0) {
    aus.push({
      projektId: null,
      typ: 'sitze_ungenutzt',
      text: `Ungenutzte Sitze: ${usd(e.ungenutztUsdMicros)} Sitzkosten ohne Nutzung im Monat. Sitze prüfen oder neu zuteilen.`,
      wert: Math.round(e.ungenutztUsdMicros / 10_000) / 100,
    });
  }

  const gesehen = new Set<string>();
  for (const b of e.budgets) {
    if (b.prognose <= b.betrag) continue;
    const schluessel = b.projektId ?? '';
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    const p = prozent(b.prognose, b.betrag);
    const stellen = b.einheit === 'Tokens' ? 0 : 2;
    const zeichen = b.einheit === 'EUR' ? '€' : b.einheit === 'USD' ? '$' : 'Tokens';
    aus.push({
      projektId: b.projektId,
      typ: 'prognose_ueber_budget',
      text: `Prognose über Budget „${b.name}“: ${de(b.prognose, stellen)} ${zeichen} zum Monatsende (${de(p)} % von ${de(b.betrag, stellen)} ${zeichen}).`,
      wert: p,
    });
  }
  return aus;
}
