// Projektpreis eines Monats (Architektur §4 Abzug der Überschreitung, §5 Formeln), reine Funktion.
// Sitzkosten-Verteilung „person“ (Standard laut Festlegung 2026-10-22), „gleich“ und „pool“; Sitze ohne
// Nutzung landen im Topf „ungenutzt“. Rundung: Projektpreis erst auf US-Cent, dann mit dem Kurs auf
// EUR-Cent. Monatsabschluss und Persistenz baut das Server-Modul `kalkulation`.
import { teileGerundet } from './schatten.js';

/** Schattenpreis der Abo-Anfragen je Person, Projekt und Tag (Σ S(r)). */
export interface SchattenPosten {
  person: string;
  /** `null` = Topf „unzugeordnet“. */
  projekt: string | null;
  tag: string;
  usdMicros: number;
}

/** Überschreitung je Person und Tag (Quelle C: Analytics API oder Team-CSV). */
export interface UeberschreitungPosten {
  person: string;
  tag: string;
  /** Echte Kosten `amount`. */
  amountUsdMicros: number;
  /** Listenpreis `list_amount`; fehlt er, gilt `amount`. */
  listAmountUsdMicros?: number | null;
}

/** Sitzkosten je Person im Monat (Preis des Sitzes, vor `code_anteil_sitz`). */
export interface SitzkostenPosten {
  person: string;
  usdMicros: number;
}

/** Sitzkosten-Verteilung (Tabelle `mandant.sitzkosten_verteilung`). */
export type Verteilung = 'person' | 'gleich' | 'pool';

export interface KalkulationEingabe {
  schatten: readonly SchattenPosten[];
  /**
   * Überschreitung je Person und Tag (Quelle C). Fehlt sie (`null`/nicht angegeben), wird nichts
   * abgezogen und das Ergebnis trägt `ueberschreitungAbgezogen = false` („nicht abgezogen“).
   */
  ueberschreitungen?: readonly UeberschreitungPosten[] | null;
  sitzkosten: readonly SitzkostenPosten[];
  /**
   * „person“ (Standard): A_P = Σ_p K_p · S_{p,P} / S_p, Personen ohne Nutzung → „ungenutzt“.
   * „gleich“: A_P = Σ_p K_p / |Projekte von p| (Projekte mit Nutzung von p im Monat).
   * „pool“: A_P = (Σ_p K_p) · S_P / Σ S über alle Sitze, auch ungenutzte (Formel §5);
   * „ungenutzt“ nur, wenn im Monat gar kein Schatten anfällt.
   */
  verteilung?: Verteilung;
  /** K_p = Sitzpreis · code_anteil_sitz (Standard 1,0). */
  codeAnteilSitz?: number;
  /** Standard 1,0 (Entscheidung Daniel). */
  schattenFaktor: number;
  /** EUR je USD für den Monat (EZB-Monatsmittel oder Mandantenwert); `null` = kein Kurs. */
  kursUsdEur: number | null;
}

export interface Projektpreis {
  schattenUsdMicros: number;
  sitzanteilUsdMicros: number;
  ueberschreitungUsdMicros: number;
  projektpreisUsdMicros: number;
  /** Auf Cent gerundet; Grundlage der EUR-Umrechnung. */
  projektpreisUsdCent: number;
  /** `null` ohne Kurs. */
  projektpreisEurCent: number | null;
}

export interface KalkulationErgebnis {
  /** Schlüssel = Projekt-ID; `UNZUGEORDNET` für Anfragen ohne Projekt. */
  projekte: Map<string, Projektpreis>;
  /** Sitzkosten ohne Nutzung im Monat (Topf „ungenutzt“) plus Überschreitung an Tagen ohne Abo-Nutzung. */
  ungenutzt: { usdMicros: number; usdCent: number; eurCent: number | null };
  verteilung: Verteilung;
  /** `false`, wenn keine Überschreitungsdaten vorlagen (Hinweis „Überschreitung nicht abgezogen“). */
  ueberschreitungAbgezogen: boolean;
  /** Σ K_p (nach `code_anteil_sitz`). */
  sitzkostenUsdMicros: number;
}

export const UNZUGEORDNET = 'unzugeordnet';

function summe<T>(liste: readonly T[], wert: (t: T) => number): number {
  return liste.reduce((s, t) => s + wert(t), 0);
}

/** USD-Mikro → Cent, kaufmännisch gerundet. */
export function mikroZuCent(usdMicros: number): number {
  return Math.round(usdMicros / 10_000);
}

/** USD-Cent → EUR-Cent mit Kurs, kaufmännisch gerundet (Kurs auf 6 Nachkommastellen); ohne Kurs `null`. */
export function usdCentZuEurCent(usdCent: number, kursUsdEur: number): number;
export function usdCentZuEurCent(usdCent: number, kursUsdEur: number | null): number | null;
export function usdCentZuEurCent(usdCent: number, kursUsdEur: number | null): number | null {
  if (kursUsdEur === null) return null;
  const kursMikro = BigInt(Math.round(kursUsdEur * 1_000_000));
  return Number(teileGerundet(BigInt(Math.round(usdCent)) * kursMikro, 1_000_000n));
}

export function berechneProjektpreise(e: KalkulationEingabe): KalkulationErgebnis {
  const pdKey = (p: string, d: string) => `${p}\u0000${d}`;

  // S(p,d) je Person und Tag.
  const sPersonTag = new Map<string, number>();
  for (const s of e.schatten) {
    const k = pdKey(s.person, s.tag);
    sPersonTag.set(k, (sPersonTag.get(k) ?? 0) + s.usdMicros);
  }

  // Überschreitungsanteil u(p,d) = min(1, ü_list / S(p,d)) und echte Kosten ü(p,d).
  const uPersonTag = new Map<string, number>();
  const uePersonTag = new Map<string, number>();
  let ungenutztUeberschreitung = 0;
  const ueberschreitungAbgezogen =
    e.ueberschreitungen !== null && e.ueberschreitungen !== undefined;
  for (const ue of e.ueberschreitungen ?? []) {
    const k = pdKey(ue.person, ue.tag);
    const s = sPersonTag.get(k) ?? 0;
    if (s <= 0) {
      // Ohne Abo-Nutzung an dem Tag lässt sich nichts auf Projekte verteilen.
      ungenutztUeberschreitung += ue.amountUsdMicros;
      continue;
    }
    const liste = ue.listAmountUsdMicros ?? ue.amountUsdMicros;
    uPersonTag.set(k, Math.min(1, ((uPersonTag.get(k) ?? 0) * s + liste) / s));
    uePersonTag.set(k, (uePersonTag.get(k) ?? 0) + ue.amountUsdMicros);
  }

  // Schatten nach Abzug, je Projekt und je Person/Projekt; Ü_P anteilig nach S_{p,d,P} / S_{p,d}.
  const schattenProjekt = new Map<string, number>();
  const uebProjekt = new Map<string, number>();
  const schattenPersonProjekt = new Map<string, Map<string, number>>();
  for (const s of e.schatten) {
    const k = pdKey(s.person, s.tag);
    const projekt = s.projekt ?? UNZUGEORDNET;
    const u = uPersonTag.get(k) ?? 0;
    const netto = s.usdMicros * (1 - u);
    schattenProjekt.set(projekt, (schattenProjekt.get(projekt) ?? 0) + netto);
    const proPerson = schattenPersonProjekt.get(s.person) ?? new Map<string, number>();
    proPerson.set(projekt, (proPerson.get(projekt) ?? 0) + netto);
    schattenPersonProjekt.set(s.person, proPerson);
    const ue = uePersonTag.get(k);
    const sPd = sPersonTag.get(k) ?? 0;
    if (ue !== undefined && sPd > 0) {
      uebProjekt.set(projekt, (uebProjekt.get(projekt) ?? 0) + (ue * s.usdMicros) / sPd);
    }
  }

  // Sitzkosten K_p = Preis · code_anteil_sitz, verteilt nach Variante; ohne Nutzung → „ungenutzt“.
  const verteilung = e.verteilung ?? 'person';
  const anteil = e.codeAnteilSitz ?? 1;
  const sitzanteilProjekt = new Map<string, number>();
  const plus = (projekt: string, wert: number) =>
    sitzanteilProjekt.set(projekt, (sitzanteilProjekt.get(projekt) ?? 0) + wert);
  let ungenutzt = ungenutztUeberschreitung;
  let sitzkostenSumme = 0;
  const gesamtSchatten = summe([...schattenProjekt.values()], (v) => v);
  for (const k of e.sitzkosten) {
    const kp = k.usdMicros * anteil;
    sitzkostenSumme += kp;
    if (verteilung === 'pool') {
      // A_P = (Σ_p K_p) · S_P / Σ S: jeder Sitz (auch ungenutzt) nach dem Schattenanteil der Projekte.
      if (gesamtSchatten <= 0) {
        ungenutzt += kp;
        continue;
      }
      for (const [projekt, sP] of schattenProjekt) plus(projekt, (kp * sP) / gesamtSchatten);
      continue;
    }
    const proPerson = schattenPersonProjekt.get(k.person);
    if (verteilung === 'gleich') {
      // A_P = Σ_p K_p / |Projekte von p|; Projekte = alle mit Nutzung von p im Monat.
      if (!proPerson || proPerson.size === 0) {
        ungenutzt += kp;
        continue;
      }
      for (const projekt of proPerson.keys()) plus(projekt, kp / proPerson.size);
      continue;
    }
    // „person“: A_P = Σ_p K_p · S_{p,P} / S_p.
    const sP = proPerson ? summe([...proPerson.values()], (v) => v) : 0;
    if (!proPerson || sP <= 0) {
      ungenutzt += kp;
      continue;
    }
    for (const [projekt, sPP] of proPerson) plus(projekt, (kp * sPP) / sP);
  }

  const projekte = new Map<string, Projektpreis>();
  const alle = new Set([
    ...schattenProjekt.keys(),
    ...sitzanteilProjekt.keys(),
    ...uebProjekt.keys(),
  ]);
  for (const projekt of alle) {
    const schatten = schattenProjekt.get(projekt) ?? 0;
    const sitzanteil = sitzanteilProjekt.get(projekt) ?? 0;
    const ueb = uebProjekt.get(projekt) ?? 0;
    const pp = e.schattenFaktor * schatten + sitzanteil + ueb;
    const usdCent = mikroZuCent(pp);
    projekte.set(projekt, {
      schattenUsdMicros: Math.round(schatten),
      sitzanteilUsdMicros: Math.round(sitzanteil),
      ueberschreitungUsdMicros: Math.round(ueb),
      projektpreisUsdMicros: Math.round(pp),
      projektpreisUsdCent: usdCent,
      projektpreisEurCent: usdCentZuEurCent(usdCent, e.kursUsdEur),
    });
  }

  const ungenutztCent = mikroZuCent(ungenutzt);
  return {
    projekte,
    ungenutzt: {
      usdMicros: Math.round(ungenutzt),
      usdCent: ungenutztCent,
      eurCent: usdCentZuEurCent(ungenutztCent, e.kursUsdEur),
    },
    verteilung,
    ueberschreitungAbgezogen,
    sitzkostenUsdMicros: Math.round(sitzkostenSumme),
  };
}
