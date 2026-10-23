// Live-Kalkulation eines Monats (Architektur §5): liest `tag_aggregat`, `person_sitz`, `sitzkosten`,
// `ueberschreitung`, `kurs` und die Mandanten-Einstellungen und rechnet mit `berechneProjektpreise`
// aus @seatmeter/shared. Läuft in einer Transaktion aus `withMandant` (RLS).
import {
  berechneProjektpreise,
  UNZUGEORDNET,
  usdCentZuEurCent,
  type KalkulationAntwort,
  type KalkulationEinstellungen,
  type KalkulationSummen,
  type Kurs,
  type ProjektpreisZeile,
  type SchattenPosten,
  type SitzkostenPosten,
  type TokenSummen,
  type UeberschreitungPosten,
} from '@seatmeter/shared';
import type { Transaction } from 'kysely';
import { monatsGrenzen, plusTage, heuteIn } from '../aggregation/tage.js';
import type { Datenbank } from '../db/schema.js';
import { ladeKurs } from './kurs.js';

type Trx = Transaction<Datenbank>;

export const NAME_UNZUGEORDNET = 'unzugeordnet';
export const NAME_UNGENUTZT = 'ungenutzt (Sitze ohne Nutzung)';
const OHNE_PERSON = 'ohne-person';
const TAG_MS = 86_400_000;

/** Sichtbare Projekte: `null` = alle; sonst nur diese Projekt-IDs (Projektleiter). */
export type ProjektSicht = string[] | null;

export interface MandantKalkulation {
  zeitzone: string;
  einstellungen: KalkulationEinstellungen;
}

export async function ladeMandantKalkulation(trx: Trx): Promise<MandantKalkulation> {
  const m = await trx
    .selectFrom('mandant')
    .select([
      'zeitzone',
      'sitzkosten_verteilung',
      'code_anteil_sitz',
      'schatten_faktor',
      'cache_write_annahme',
    ])
    .executeTakeFirstOrThrow();
  return {
    zeitzone: m.zeitzone,
    einstellungen: {
      sitzkosten_verteilung: m.sitzkosten_verteilung,
      code_anteil_sitz: Number(m.code_anteil_sitz),
      schatten_faktor: Number(m.schatten_faktor),
      cache_write_annahme: m.cache_write_annahme,
    },
  };
}

export function leereTokens(): TokenSummen {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_1h: 0,
    web_search: 0,
    gesamt: 0,
  };
}

/** Preisversionen zusammenführen (eindeutig, sortiert, kommagetrennt). */
export function versionenText(versionen: Iterable<string>): string {
  return [...new Set(versionen)].sort().join(',');
}

/** Summen der sichtbaren Zeilen; EUR nur, wenn alle Zeilen einen EUR-Wert haben. */
export function summiere(zeilen: readonly ProjektpreisZeile[]): KalkulationSummen {
  const s: KalkulationSummen = {
    schatten_usd_micros: 0,
    sitzanteil_usd_micros: 0,
    ueberschreitung_usd_micros: 0,
    projektpreis_usd_micros: 0,
    projektpreis_usd_cent: 0,
    projektpreis_eur_cent: 0,
  };
  for (const z of zeilen) {
    s.schatten_usd_micros += z.schatten_usd_micros;
    s.sitzanteil_usd_micros += z.sitzanteil_usd_micros;
    s.ueberschreitung_usd_micros += z.ueberschreitung_usd_micros;
    s.projektpreis_usd_micros += z.projektpreis_usd_micros;
    s.projektpreis_usd_cent += z.projektpreis_usd_cent;
    s.projektpreis_eur_cent =
      s.projektpreis_eur_cent === null || z.projektpreis_eur_cent === null
        ? null
        : s.projektpreis_eur_cent + z.projektpreis_eur_cent;
  }
  return s;
}

/** Zeilen sortieren (Projekte nach Preis absteigend, dann „unzugeordnet“, dann „ungenutzt“) und filtern. */
export function sichtbar(zeilen: ProjektpreisZeile[], sicht: ProjektSicht): ProjektpreisZeile[] {
  const rang = { projekt: 0, unzugeordnet: 1, ungenutzt: 2 } as const;
  return zeilen
    .filter((z) => sicht === null || (z.topf === 'projekt' && sicht.includes(z.projekt_id ?? '')))
    .sort(
      (a, b) =>
        rang[a.topf] - rang[b.topf] ||
        b.projektpreis_usd_micros - a.projektpreis_usd_micros ||
        a.name.localeCompare(b.name, 'de'),
    );
}

/** Tage, an denen ein Sitz im Monat gilt (für die anteiligen Sitzkosten). */
function tageImMonat(
  von: string,
  bisExklusiv: string,
  ab: string,
  bis: string | null,
): { tage: number; monatTage: number } {
  const monatTage = Math.round((Date.parse(bisExklusiv) - Date.parse(von)) / TAG_MS);
  const start = ab > von ? ab : von;
  const letzter = plusTage(bisExklusiv, -1);
  const ende = bis !== null && bis < letzter ? bis : letzter;
  const tage = ende < start ? 0 : Math.round((Date.parse(ende) - Date.parse(start)) / TAG_MS) + 1;
  return { tage, monatTage };
}

/**
 * Live-Kalkulation für `monat` (`JJJJ-MM`, Mandanten-Zeitzone). Ohne Sichtfilter rechnet sie immer
 * über alle Projekte (Sitzanteile hängen von allen ab); `sicht` filtert erst die Ausgabe.
 */
export async function kalkuliereMonat(
  trx: Trx,
  monat: string,
  sicht: ProjektSicht = null,
  jetzt: Date = new Date(),
): Promise<KalkulationAntwort> {
  const { von, bisExklusiv } = monatsGrenzen(monat);
  const mandant = await ladeMandantKalkulation(trx);
  const e = mandant.einstellungen;
  const kurs: Kurs = await ladeKurs(trx, monat);
  const hinweise: string[] = [];

  const aggregat = await trx
    .selectFrom('tag_aggregat')
    .select([
      'tag',
      'person_id',
      'projekt_id',
      'input',
      'output',
      'cache_read',
      'cache_write',
      'cache_write_1h',
      'web_search',
      'anfragen',
      'schatten_usd_micros',
      'preis_version',
    ])
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .execute();

  // Schatten je Person/Projekt/Tag, Tokens und Preisversionen je Projekt.
  const posten = new Map<string, SchattenPosten>();
  const tokens = new Map<string, { t: TokenSummen; anfragen: number; versionen: Set<string> }>();
  let ohnePreis = false;
  const personenMitNutzung = new Set<string>();
  for (const z of aggregat) {
    const person = z.person_id ?? OHNE_PERSON;
    if (z.person_id) personenMitNutzung.add(z.person_id);
    const projekt = z.projekt_id ?? UNZUGEORDNET;
    const schluessel = `${person}\u0000${projekt}\u0000${z.tag}`;
    const p = posten.get(schluessel) ?? { person, projekt, tag: z.tag, usdMicros: 0 };
    p.usdMicros += Number(z.schatten_usd_micros);
    posten.set(schluessel, p);
    const t = tokens.get(projekt) ?? { t: leereTokens(), anfragen: 0, versionen: new Set() };
    t.t.input += Number(z.input);
    t.t.output += Number(z.output);
    t.t.cache_read += Number(z.cache_read);
    t.t.cache_write += Number(z.cache_write);
    t.t.cache_write_1h += Number(z.cache_write_1h);
    t.t.web_search += Number(z.web_search);
    t.anfragen += Number(z.anfragen);
    if (z.preis_version) for (const v of z.preis_version.split(',')) t.versionen.add(v);
    else ohnePreis = true;
    tokens.set(projekt, t);
  }

  // Sitzkosten je Person: Preis des Sitztyps im Monat, anteilig nach Tagen mit gültigem Sitz.
  const sitze = await trx
    .selectFrom('person_sitz')
    .select(['person_id', 'sitz_typ', 'gueltig_ab', 'gueltig_bis'])
    .where('gueltig_ab', '<', bisExklusiv)
    .where((eb) => eb.or([eb('gueltig_bis', 'is', null), eb('gueltig_bis', '>=', von)]))
    .execute();
  const preise = await trx
    .selectFrom('sitzkosten')
    .select(['sitz_typ', 'gueltig_ab', 'preis_monat', 'waehrung'])
    .where('gueltig_ab', '<', bisExklusiv)
    .orderBy('gueltig_ab', 'desc')
    .execute();
  const preisJeTyp = new Map<string, { preis: number; waehrung: string }>();
  for (const p of preise) {
    if (!preisJeTyp.has(p.sitz_typ)) {
      preisJeTyp.set(p.sitz_typ, { preis: Number(p.preis_monat), waehrung: p.waehrung });
    }
  }
  const kostenJePerson = new Map<string, number>();
  const typenOhnePreis = new Set<string>();
  let eurOhneKurs = false;
  let fremdeWaehrung = false;
  for (const s of sitze) {
    const preis = preisJeTyp.get(s.sitz_typ);
    if (!preis) {
      typenOhnePreis.add(s.sitz_typ);
      continue;
    }
    let usd = preis.preis;
    if (preis.waehrung === 'EUR') {
      if (kurs.usd_eur === null) {
        eurOhneKurs = true;
        continue;
      }
      usd = preis.preis / kurs.usd_eur;
    } else if (preis.waehrung !== 'USD') {
      fremdeWaehrung = true;
      continue;
    }
    const { tage, monatTage } = tageImMonat(von, bisExklusiv, s.gueltig_ab, s.gueltig_bis);
    if (tage <= 0) continue;
    const mikro = (usd * 1_000_000 * tage) / monatTage;
    kostenJePerson.set(s.person_id, (kostenJePerson.get(s.person_id) ?? 0) + mikro);
  }
  const sitzkosten: SitzkostenPosten[] = [...kostenJePerson].map(([person, usdMicros]) => ({
    person,
    usdMicros,
  }));

  // Überschreitung (Quelle C): nur, wenn für den Monat Daten vorliegen; sonst „nicht abgezogen“.
  const ueRoh = await trx
    .selectFrom('ueberschreitung')
    .select(['person_id', 'tag', 'amount_usd_micros', 'list_amount_usd_micros'])
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .execute();
  const ueJeTag = new Map<string, UeberschreitungPosten>();
  for (const u of ueRoh) {
    const k = `${u.person_id}\u0000${u.tag}`;
    const alt = ueJeTag.get(k) ?? {
      person: u.person_id,
      tag: u.tag,
      amountUsdMicros: 0,
      listAmountUsdMicros: 0,
    };
    alt.amountUsdMicros += Number(u.amount_usd_micros);
    alt.listAmountUsdMicros =
      (alt.listAmountUsdMicros ?? 0) + Number(u.list_amount_usd_micros ?? u.amount_usd_micros);
    ueJeTag.set(k, alt);
  }

  const ergebnis = berechneProjektpreise({
    schatten: [...posten.values()],
    ueberschreitungen: ueRoh.length > 0 ? [...ueJeTag.values()] : null,
    sitzkosten,
    verteilung: e.sitzkosten_verteilung,
    codeAnteilSitz: e.code_anteil_sitz,
    schattenFaktor: e.schatten_faktor,
    kursUsdEur: kurs.usd_eur,
  });

  // Projektnamen.
  const ids = [...ergebnis.projekte.keys()].filter((k) => k !== UNZUGEORDNET);
  const projekte = ids.length
    ? await trx
        .selectFrom('projekt')
        .select(['id', 'anzeigename', 'repo_name', 'owner', 'url_norm', 'kunde'])
        .where('id', 'in', ids)
        .execute()
    : [];
  const projektInfo = new Map(projekte.map((p) => [p.id, p]));

  const zeilen: ProjektpreisZeile[] = [];
  for (const [projekt, pp] of ergebnis.projekte) {
    const info = projektInfo.get(projekt);
    const t = tokens.get(projekt);
    const tok = t?.t ?? leereTokens();
    tok.gesamt = tok.input + tok.output + tok.cache_read + tok.cache_write;
    const istUnzugeordnet = projekt === UNZUGEORDNET;
    zeilen.push({
      topf: istUnzugeordnet ? 'unzugeordnet' : 'projekt',
      projekt_id: istUnzugeordnet ? null : projekt,
      name: istUnzugeordnet
        ? NAME_UNZUGEORDNET
        : (info?.anzeigename ??
          (info?.owner && info.repo_name ? `${info.owner}/${info.repo_name}` : null) ??
          info?.repo_name ??
          info?.url_norm ??
          projekt),
      kunde: info?.kunde ?? null,
      tokens: tok,
      anfragen: t?.anfragen ?? 0,
      schatten_usd_micros: pp.schattenUsdMicros,
      sitzanteil_usd_micros: pp.sitzanteilUsdMicros,
      ueberschreitung_usd_micros: pp.ueberschreitungUsdMicros,
      projektpreis_usd_micros: pp.projektpreisUsdMicros,
      projektpreis_usd_cent: pp.projektpreisUsdCent,
      projektpreis_eur_cent: pp.projektpreisEurCent,
      preis_version: versionenText(t?.versionen ?? []),
    });
  }
  if (ergebnis.ungenutzt.usdMicros !== 0) {
    zeilen.push({
      topf: 'ungenutzt',
      projekt_id: null,
      name: NAME_UNGENUTZT,
      kunde: null,
      tokens: leereTokens(),
      anfragen: 0,
      schatten_usd_micros: 0,
      sitzanteil_usd_micros: ergebnis.ungenutzt.usdMicros,
      ueberschreitung_usd_micros: 0,
      projektpreis_usd_micros: ergebnis.ungenutzt.usdMicros,
      projektpreis_usd_cent: ergebnis.ungenutzt.usdCent,
      projektpreis_eur_cent: usdCentZuEurCent(ergebnis.ungenutzt.usdCent, kurs.usd_eur),
      preis_version: '',
    });
  }

  if (monat === heuteIn(mandant.zeitzone, jetzt).slice(0, 7)) {
    hinweise.push('Monat läuft noch: Werte vorläufig.');
  }
  if (kurs.usd_eur === null) {
    hinweise.push(
      'Kein Kurs für den Monat: EUR-Werte fehlen (EZB-Abruf oder manuellen Kurs setzen).',
    );
  } else if (kurs.vorlaeufig) {
    hinweise.push('Kurs vorläufig: Mittel der bisherigen EZB-Tageskurse.');
  }
  if (!ergebnis.ueberschreitungAbgezogen) {
    hinweise.push('Überschreitung nicht abgezogen (keine Abgleichsdaten für den Monat).');
  }
  const ohneSitz = [...personenMitNutzung].filter((p) => !kostenJePerson.has(p)).length;
  if (ohneSitz > 0) {
    hinweise.push(`${ohneSitz} Person(en) mit Nutzung ohne Sitz: keine Sitzkosten verteilt.`);
  }
  for (const typ of [...typenOhnePreis].sort()) {
    hinweise.push(`Sitztyp ${typ} ohne Sitzkosten: Sitze dieses Typs kosten 0.`);
  }
  if (eurOhneKurs) hinweise.push('Sitzkosten in EUR ohne Kurs nicht umgerechnet (0 angesetzt).');
  if (fremdeWaehrung)
    hinweise.push('Sitzkosten in anderer Währung als USD/EUR nicht berücksichtigt.');
  if (ohnePreis) hinweise.push('Modelle ohne Preis: Schattenpreis 0 (siehe Datenqualität).');

  const abschluss = await trx
    .selectFrom('monatsabschluss')
    .select('eingefroren_am')
    .where('monat', '=', von)
    .limit(1)
    .executeTakeFirst();

  const sicht_zeilen = sichtbar(zeilen, sicht);
  return {
    monat,
    quelle: 'live',
    eingefroren_am: null,
    abgeschlossen: abschluss !== undefined,
    einstellungen: e,
    kurs,
    ueberschreitung_abgezogen: ergebnis.ueberschreitungAbgezogen,
    sitzkosten_usd_micros: sicht === null ? ergebnis.sitzkostenUsdMicros : null,
    zeilen: sicht_zeilen,
    summe: summiere(sicht_zeilen),
    hinweise,
  };
}
