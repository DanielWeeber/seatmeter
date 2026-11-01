// Kosten je Katalog-Projekt: Repos über die getrennte Zuordnung aus `tag_aggregat` (rückwirkend, ohne die
// Nutzungsdaten umzuschreiben), Sitzungen ohne Repo aus `anfrage` über ihre Sitzungs-ID (zur Lesezeit bepreist).
// Ein abgeschlossener Monat kommt aus dem Stand `katalog_abschluss`: Spätere Zuordnungen und Importe ändern
// ihn nicht. Monate ohne Stand (vor der Funktion oder ohne jede Zuordnung beim Abschluss) rechnen live.
// Je Projekt stehen die eigenen Kennzahlen und die Summe mit allen Nachfahren dieser Sicht. Addiert werden nur die eigenen,
// die Summe ist abgeleitet: So zählt nichts doppelt.
import {
  katalogBaumBauen,
  katalogPfadText,
  schattenpreis,
  type KatalogBaumKnoten,
  type KatalogBaumZeile,
  type KatalogKostenAntwort,
  type KatalogKostenProjekt,
  type Kennzahlen,
} from '@seatmeter/shared';
import { sql } from 'kysely';
import { monatsGrenzen } from '../aggregation/tage.js';
import { kennzahlenAus, projektAnzeigename } from '../issues/routen.js';
import { ladeEffektivePreistabelle } from '../preise/tabelle.js';
import { katalogBaumLaden, type KatalogTrx } from './daten.js';

/** Projekte der Anmeldung: `null` = alle; Projektleiter nur ihre (ohne Sitzungen ohne Repo). */
export type KostenSicht = readonly string[] | null;

const NULL_KENNZAHLEN: Kennzahlen = kennzahlenAus(undefined);

function verbinden(
  a: Kennzahlen,
  b: Kennzahlen,
  rechne: (x: number, y: number) => number,
): Kennzahlen {
  const t = {
    input: rechne(a.tokens.input, b.tokens.input),
    output: rechne(a.tokens.output, b.tokens.output),
    cache_read: rechne(a.tokens.cache_read, b.tokens.cache_read),
    cache_write: rechne(a.tokens.cache_write, b.tokens.cache_write),
    cache_write_1h: rechne(a.tokens.cache_write_1h, b.tokens.cache_write_1h),
    web_search: rechne(a.tokens.web_search, b.tokens.web_search),
  };
  return {
    tokens: { ...t, gesamt: t.input + t.output + t.cache_read + t.cache_write },
    anfragen: rechne(a.anfragen, b.anfragen),
    schatten_usd_micros: rechne(a.schatten_usd_micros, b.schatten_usd_micros),
  };
}

const plus = (a: Kennzahlen, b: Kennzahlen) => verbinden(a, b, (x, y) => x + y);
/** Nie negativ: `tag_aggregat` kann hinter `anfrage` zurückliegen. */
const minus = (a: Kennzahlen, b: Kennzahlen) => verbinden(a, b, (x, y) => Math.max(0, x - y));

type SummenRoh = NonNullable<Parameters<typeof kennzahlenAus>[0]>;

const SUMMEN = sql`
  coalesce(sum(input), 0)::bigint AS input,
  coalesce(sum(output), 0)::bigint AS output,
  coalesce(sum(cache_read), 0)::bigint AS cache_read,
  coalesce(sum(cache_write), 0)::bigint AS cache_write,
  coalesce(sum(cache_write_1h), 0)::bigint AS cache_write_1h,
  coalesce(sum(web_search), 0)::bigint AS web_search,
  coalesce(sum(anfragen), 0)::bigint AS anfragen,
  coalesce(sum(schatten_usd_micros), 0)::bigint AS schatten_usd_micros`;

interface SitzungsKosten {
  externeId: string;
  nummer: string;
  name: string;
  pfad: string;
  kunde: string | null;
  sitzungen: number;
  k: Kennzahlen;
}

interface OhneRepoStand {
  /** Sitzungen mit gewähltem Katalog-Projekt. */
  zugerechnet: SitzungsKosten[];
  /** Anfragen ohne Repo und ohne Wahl. */
  offen: Kennzahlen;
  /** Alle Anfragen ohne Repo, die noch in `anfrage` liegen. */
  gesamt: Kennzahlen;
}

/** Nutzung ohne Repo direkt aus `anfrage`, bepreist wie im Tagesaggregat, je Sitzung mit oder ohne Wahl. */
async function ohneRepoStand(
  trx: KatalogTrx,
  monat: string,
  pfade: ReadonlyMap<string, string>,
): Promise<OhneRepoStand> {
  const g = monatsGrenzen(monat);
  const anfragen = await trx
    .selectFrom('anfrage')
    .leftJoin('sitzung_katalog', (j) =>
      j
        .onRef('sitzung_katalog.session_id', '=', 'anfrage.session_id')
        .onRef('sitzung_katalog.mandant_id', '=', 'anfrage.mandant_id'),
    )
    .leftJoin('katalog_projekt', 'katalog_projekt.id', 'sitzung_katalog.katalog_projekt_id')
    .select([
      'anfrage.ts',
      'anfrage.session_id',
      'anfrage.model',
      'anfrage.speed',
      'anfrage.inference_geo',
      'anfrage.input',
      'anfrage.output',
      'anfrage.cache_read',
      'anfrage.cache_write',
      'anfrage.cache_write_1h',
      'anfrage.web_search',
      'katalog_projekt.id as katalog_id',
      'katalog_projekt.externe_id',
      'katalog_projekt.nummer',
      'katalog_projekt.name',
      'katalog_projekt.kunde',
    ])
    .where('anfrage.tag', '>=', g.von)
    .where('anfrage.tag', '<', g.bisExklusiv)
    .where('anfrage.zaehlt_als_abo', '=', true)
    .where('anfrage.projekt_id', 'is', null)
    .execute();
  const stand: OhneRepoStand = { zugerechnet: [], offen: NULL_KENNZAHLEN, gesamt: NULL_KENNZAHLEN };
  if (anfragen.length === 0) return stand;
  const m = await trx.selectFrom('mandant').select('cache_write_annahme').executeTakeFirstOrThrow();
  const preise = await ladeEffektivePreistabelle(trx);
  const je = new Map<string, SitzungsKosten & { ids: Set<string> }>();
  for (const a of anfragen) {
    const s = schattenpreis(
      {
        model: a.model,
        ts: a.ts,
        input: a.input,
        output: a.output,
        cache_read: a.cache_read,
        cache_write: a.cache_write,
        cache_write_1h: a.cache_write_1h,
        speed: a.speed,
        inference_geo: a.inference_geo,
      },
      preise,
      m.cache_write_annahme,
    );
    const eine = kennzahlenAus({
      input: a.input,
      output: a.output,
      cache_read: a.cache_read,
      cache_write: a.cache_write,
      // 1h-Anteil wie im Tagesaggregat: bekannt (Quelle B) oder nach cache_write_annahme.
      cache_write_1h: a.cache_write_1h ?? (m.cache_write_annahme === '1h' ? a.cache_write : 0),
      web_search: a.web_search,
      anfragen: 1,
      schatten_usd_micros: s?.usdMicros ?? 0,
    });
    stand.gesamt = plus(stand.gesamt, eine);
    if (!a.externe_id || !a.name || !a.katalog_id) {
      stand.offen = plus(stand.offen, eine);
      continue;
    }
    let z = je.get(a.externe_id);
    if (!z) {
      z = {
        externeId: a.externe_id,
        nummer: a.nummer ?? a.externe_id,
        name: a.name,
        pfad: pfade.get(a.katalog_id) ?? a.name,
        kunde: a.kunde,
        sitzungen: 0,
        k: NULL_KENNZAHLEN,
        ids: new Set(),
      };
      je.set(a.externe_id, z);
    }
    z.k = plus(z.k, eine);
    if (a.session_id) z.ids.add(a.session_id);
    z.sitzungen = z.ids.size;
  }
  stand.zugerechnet = [...je.values()];
  return stand;
}

/** Ein Projekt mit nur seinen eigenen Kennzahlen, noch ohne Baum. */
type EigeneKosten = Omit<KatalogKostenProjekt, 'eltern_externe_id' | 'tiefe' | 'summe'>;

interface KostenKnoten extends KatalogBaumKnoten {
  pfad: string;
  kunde: string | null;
}

const nurKennzahlen = (k: Kennzahlen): Kennzahlen => ({
  tokens: k.tokens,
  anfragen: k.anfragen,
  schatten_usd_micros: k.schatten_usd_micros,
});

/**
 * Baumreihenfolge mit Summen. `knoten` sind genau die Projekte dieser Sicht; ein Elternprojekt außerhalb macht das Kind zur
 * Wurzel. Zyklen und die Tiefengrenze löst `katalogBaumBauen`: Jedes Projekt steht einmal im Baum und zählt einmal. Ein
 * Projekt, das erst nach dem Laden des Katalogs entstand, fehlt in `knoten`: Es steht oben, damit das Gesamt stimmt.
 */
export function mitSummen(
  eigene: ReadonlyMap<string, EigeneKosten>,
  knoten: readonly KostenKnoten[],
): KatalogKostenProjekt[] {
  const bekannt = new Set(knoten.map((n) => n.externe_id));
  const baum = katalogBaumBauen([
    ...knoten,
    ...[...eigene.values()]
      .filter((p) => !bekannt.has(p.externe_id))
      .map((p) => ({ ...p, parent_externe_id: null })),
  ]);
  const summen = baum.map((z) => {
    const e = eigene.get(z.projekt.externe_id);
    return e ? nurKennzahlen(e) : NULL_KENNZAHLEN;
  });
  // Eltern stehen vor ihren Kindern: rückwärts sind die Kinder fertig, wenn das Elternprojekt drankommt.
  for (let i = baum.length - 1; i >= 0; i -= 1) {
    const eltern = baum[i]!.elternIndex;
    if (eltern !== null) summen[eltern] = plus(summen[eltern]!, summen[i]!);
  }
  return baum.map((z, i) => {
    const { pfad, kunde, externe_id, nummer, name } = z.projekt;
    return {
      ...(eigene.get(externe_id) ?? {
        externe_id,
        nummer,
        name,
        pfad,
        kunde,
        repos: [],
        ohne_repo: NULL_KENNZAHLEN,
        sitzungen_ohne_repo: 0,
        ...NULL_KENNZAHLEN,
      }),
      eltern_externe_id: z.elternIndex === null ? null : baum[z.elternIndex]!.projekt.externe_id,
      tiefe: z.tiefe,
      summe: summen[i]!,
    };
  });
}

type KatalogBaum = readonly KatalogBaumZeile<KatalogBaumKnoten & { kunde: string | null }>[];

/**
 * Knoten aus dem Katalogbaum: Projekte mit eigenen Kosten und, wenn `mitVorfahren`, ihre Vorfahren. Eine eingeschränkte Sicht
 * bekommt keine Vorfahren als Zeilen: Beträge, Repos und Summen verborgener Projekte erscheinen nicht, das Kind steht oben.
 * Der Pfad darf den Namen eines verborgenen Elternprojekts nennen: Projektnamen sind unter Beschäftigten nicht geheim, die
 * Auswahl zeigt jeder Person mit Rolle `entwickler` den aktiven Katalog.
 */
function knotenAusBaum(
  baum: KatalogBaum,
  ids: ReadonlySet<string>,
  mitVorfahren: boolean,
): KostenKnoten[] {
  const behalten = new Uint8Array(baum.length);
  baum.forEach((z, i) => {
    if (!ids.has(z.projekt.externe_id)) return;
    let j: number | null = i;
    while (j !== null && behalten[j] === 0) {
      behalten[j] = 1;
      j = mitVorfahren ? baum[j]!.elternIndex : null;
    }
  });
  const knoten: KostenKnoten[] = [];
  baum.forEach((z, i) => {
    if (behalten[i] === 0) return;
    knoten.push({
      externe_id: z.projekt.externe_id,
      // Der schon aufgelöste Elternteil: Zyklen, Waisen und die Tiefengrenze sind hier erledigt.
      parent_externe_id: z.elternIndex === null ? null : baum[z.elternIndex]!.projekt.externe_id,
      nummer: z.projekt.nummer,
      name: z.projekt.name,
      pfad: katalogPfadText(z.pfad),
      kunde: z.projekt.kunde,
    });
  });
  return knoten;
}

function gesamtAus(
  eigene: ReadonlyMap<string, EigeneKosten>,
  offen: KatalogKostenAntwort['offen'],
): Kennzahlen {
  let g = offen.ohne_repo;
  for (const p of eigene.values()) g = plus(g, p);
  for (const r of offen.repos) g = plus(g, r);
  return nurKennzahlen(g);
}

/** Live-Berechnung aus Aggregat, Zuordnung und Sitzungen. */
export async function kostenLive(
  trx: KatalogTrx,
  sicht: KostenSicht,
  monat: string,
): Promise<KatalogKostenAntwort> {
  const g = monatsGrenzen(monat);
  const leer: KatalogKostenAntwort = {
    monat,
    quelle: 'live',
    projekte: [],
    gesamt: NULL_KENNZAHLEN,
    eingeschraenkt: sicht !== null,
    offen: { repos: [], ohne_repo: NULL_KENNZAHLEN },
  };
  if (sicht !== null && sicht.length === 0) return leer;
  const filter = sicht === null ? sql`true` : sql`projekt_id = ANY(${[...sicht]}::uuid[])`;
  const summen = await sql<SummenRoh & { projekt_id: string | null }>`
    SELECT projekt_id, ${SUMMEN} FROM tag_aggregat
    WHERE tag >= ${g.von}::date AND tag < ${g.bisExklusiv}::date AND ${filter}
    GROUP BY projekt_id`.execute(trx);
  const jeRepo = new Map(summen.rows.map((z) => [z.projekt_id, kennzahlenAus(z)]));

  let q = trx
    .selectFrom('projekt')
    .leftJoin('projekt_katalog', 'projekt_katalog.projekt_id', 'projekt.id')
    .leftJoin('katalog_projekt', 'katalog_projekt.id', 'projekt_katalog.katalog_projekt_id')
    .select([
      'projekt.id',
      'projekt.anzeigename',
      'projekt.repo_name',
      'projekt.owner',
      'projekt.url_norm',
      'katalog_projekt.id as katalog_id',
      'katalog_projekt.externe_id',
      'katalog_projekt.nummer',
      'katalog_projekt.name',
      'katalog_projekt.kunde',
    ]);
  if (sicht !== null) q = q.where('projekt.id', 'in', [...sicht]);
  const repos = await q.execute();
  const baum = await katalogBaumLaden(trx);
  const pfade = new Map(baum.map((z) => [z.projekt.id, katalogPfadText(z.pfad)]));

  const katalog = new Map<string, EigeneKosten>();
  // Je gewähltem Projekt nur das Eigene: Der Schlüssel ist die externe ID, die Nummer dürfte sich wiederholen.
  const eintrag = (
    externeId: string,
    nummer: string,
    name: string,
    pfad: string,
    kunde: string | null,
  ) => {
    let p = katalog.get(externeId);
    if (!p) {
      p = {
        externe_id: externeId,
        nummer,
        name,
        pfad,
        kunde,
        repos: [],
        ohne_repo: NULL_KENNZAHLEN,
        sitzungen_ohne_repo: 0,
        ...NULL_KENNZAHLEN,
      };
      katalog.set(externeId, p);
    }
    return p;
  };
  const offen: KatalogKostenAntwort['offen'] = { repos: [], ohne_repo: NULL_KENNZAHLEN };
  for (const r of repos) {
    const k = jeRepo.get(r.id) ?? NULL_KENNZAHLEN;
    const zeile = { id: r.id, name: projektAnzeigename(r), ...k };
    if (r.externe_id && r.name && r.katalog_id) {
      const p = eintrag(
        r.externe_id,
        r.nummer ?? r.externe_id,
        r.name,
        pfade.get(r.katalog_id) ?? r.name,
        r.kunde,
      );
      p.repos.push(zeile);
      Object.assign(p, plus(p, k));
    } else if (k.anfragen > 0) {
      offen.repos.push(zeile);
    }
  }

  // Sitzungen ohne Repo haben keine Projekt-ID, also nur für Rollen ohne Projektbeschränkung.
  if (sicht === null) {
    const stand = await ohneRepoStand(trx, monat, pfade);
    for (const z of stand.zugerechnet) {
      const p = eintrag(z.externeId, z.nummer, z.name, z.pfad, z.kunde);
      p.ohne_repo = z.k;
      p.sitzungen_ohne_repo = z.sitzungen;
      Object.assign(p, plus(p, z.k));
    }
    // Offen ist, was in `anfrage` keine Wahl hat. Dazu kommt, was nur noch im Aggregat steht, weil die Einzelanfragen
    // schon gelöscht sind. Das Aggregat allein läge tagsüber hinter `anfrage` zurück. Ohne mehr Anfragen ist ein Rest nur
    // ein Preisunterschied, etwa nach geänderter Cache-Annahme vor dem nächsten Neuaufbau, und keine Nutzung.
    const aggregat = jeRepo.get(null) ?? NULL_KENNZAHLEN;
    offen.ohne_repo =
      aggregat.anfragen > stand.gesamt.anfragen
        ? plus(stand.offen, minus(aggregat, stand.gesamt))
        : stand.offen;
  }
  for (const p of katalog.values()) {
    p.repos.sort(
      (x, y) => y.schatten_usd_micros - x.schatten_usd_micros || x.name.localeCompare(y.name),
    );
  }
  offen.repos.sort((x, y) => y.schatten_usd_micros - x.schatten_usd_micros);
  const knoten = knotenAusBaum(baum, new Set(katalog.keys()), sicht === null);
  return {
    ...leer,
    projekte: mitSummen(katalog, knoten),
    gesamt: gesamtAus(katalog, offen),
    offen,
  };
}

/** Spalten je Zeile mal diese Zahl muss unter der Grenze von 65 535 Parametern bleiben. */
const JE_EINFUEGEN = 500;

/**
 * Schreibt den Stand für einen abgeschlossenen Monat (Aufruf aus dem Monatsabschluss, gleiche Transaktion);
 * ein erneuter Abschluss ersetzt ihn. Ohne jede Zuordnung kein Stand, damit spätere Zuordnungen wirken.
 * Sind die Einzelanfragen des Monats schon gelöscht, lassen sich die Sitzungen ohne Repo nicht neu rechnen: Dann bleiben
 * ihre eingefrorenen Zeilen stehen, sonst wanderten die Kosten nach „offen“.
 * Die Hierarchie friert mit: je Zeile das aufgelöste Elternprojekt und der Pfad. Vorfahren ohne eigene Nutzung bekommen eine
 * leere Zeile, damit der Baum auch ohne den Katalog vollständig bleibt. Ein erneuter Abschluss nimmt die aktuelle Hierarchie.
 */
export async function katalogAbschlussSchreiben(
  trx: KatalogTrx,
  mandantId: string,
  monat: string,
): Promise<void> {
  const g = monatsGrenzen(monat);
  const tag = g.von;
  const aggregat = await sql<SummenRoh>`
    SELECT ${SUMMEN} FROM tag_aggregat
    WHERE tag >= ${g.von}::date AND tag < ${g.bisExklusiv}::date AND projekt_id IS NULL`.execute(
    trx,
  );
  const stand = await ohneRepoStand(trx, monat, new Map());
  const abgedeckt = kennzahlenAus(aggregat.rows[0]).anfragen <= stand.gesamt.anfragen;
  const eingefroren = abgedeckt
    ? []
    : (
        await trx
          .selectFrom('katalog_abschluss')
          .selectAll()
          .where('monat', '=', tag)
          .where('projekt_id', 'is', null)
          .execute()
      ).filter((z) => z.nummer === '' || Number(z.sitzungen) > 0); // Leere Zeilen entstehen neu.
  await trx.deleteFrom('katalog_abschluss').where('monat', '=', tag).execute();
  const k = await kostenLive(trx, null, monat);
  if (k.projekte.length === 0 && eingefroren.length === 0) return;
  const behalten = eingefroren.length > 0;
  const werte = (x: Kennzahlen) => ({
    input: x.tokens.input,
    output: x.tokens.output,
    cache_read: x.tokens.cache_read,
    cache_write: x.tokens.cache_write,
    cache_write_1h: x.tokens.cache_write_1h,
    web_search: x.tokens.web_search,
    anfragen: x.anfragen,
    schatten_usd_micros: x.schatten_usd_micros,
  });
  const basis = { mandant_id: mandantId, monat: tag };
  const projekte = new Map(k.projekte.map((p) => [p.externe_id, p]));
  const nurEingefroren = new Set(
    eingefroren.filter((z) => z.nummer !== '').map((z) => z.externe_id || z.nummer),
  );
  const knoten = knotenAusBaum(
    await katalogBaumLaden(trx),
    new Set([...projekte.keys(), ...nurEingefroren]),
    true,
  );
  const jeKnoten = new Map(knoten.map((n) => [n.externe_id, n]));
  const zeilen = [
    ...knoten.flatMap((n) => {
      const p = projekte.get(n.externe_id);
      const kopf = {
        ...basis,
        externe_id: n.externe_id,
        nummer: n.nummer,
        name: n.name,
        pfad: n.pfad,
        parent_externe_id: n.parent_externe_id,
        kunde: n.kunde,
      };
      const eigene = [
        ...(p?.repos ?? []).map((r) => ({
          ...kopf,
          projekt_id: r.id,
          projekt_name: r.name,
          sitzungen: 0,
          ...werte(r),
        })),
        ...(!behalten && p && p.sitzungen_ohne_repo > 0
          ? [
              {
                ...kopf,
                projekt_id: null,
                projekt_name: null,
                sitzungen: p.sitzungen_ohne_repo,
                ...werte(p.ohne_repo),
              },
            ]
          : []),
      ];
      if (eigene.length > 0 || nurEingefroren.has(n.externe_id)) return eigene;
      return [
        {
          ...kopf,
          projekt_id: null,
          projekt_name: null,
          sitzungen: 0,
          ...werte(NULL_KENNZAHLEN),
        },
      ];
    }),
    // Nummer leer: im Monat offen geblieben (ohne Zuordnung).
    ...k.offen.repos.map((r) => ({
      ...basis,
      externe_id: '',
      nummer: '',
      name: '',
      pfad: null,
      parent_externe_id: null,
      kunde: null,
      projekt_id: r.id,
      projekt_name: r.name,
      sitzungen: 0,
      ...werte(r),
    })),
    ...(behalten
      ? eingefroren.map(({ id: _id, ...z }) => {
          // Kosten und Name bleiben eingefroren, die Hierarchie folgt dem Rest dieses Abschlusses.
          const n = jeKnoten.get(z.externe_id || z.nummer);
          return n ? { ...z, pfad: n.pfad, parent_externe_id: n.parent_externe_id } : z;
        })
      : [
          {
            ...basis,
            externe_id: '',
            nummer: '',
            name: '',
            pfad: null,
            parent_externe_id: null,
            kunde: null,
            projekt_id: null,
            projekt_name: null,
            sitzungen: 0,
            ...werte(k.offen.ohne_repo),
          },
        ]),
  ];
  for (let i = 0; i < zeilen.length; i += JE_EINFUEGEN) {
    await trx
      .insertInto('katalog_abschluss')
      .values(zeilen.slice(i, i + JE_EINFUEGEN))
      .execute();
  }
}

/** Stand eines abgeschlossenen Monats; `null`, wenn es keinen gibt. */
async function kostenAusAbschluss(
  trx: KatalogTrx,
  sicht: KostenSicht,
  monat: string,
): Promise<KatalogKostenAntwort | null> {
  const tag = monatsGrenzen(monat).von;
  // Repo-Zeilen zuerst: Nummer, Name und Kunde eines Projekts kommen von der ersten Zeile. Sitzungen ohne Repo können nach einem
  // erneuten Abschluss ältere Bezeichnungen tragen, Repo-Zeilen haben immer die des letzten Abschlusses, und die Projektleitung
  // sieht nur sie. Die ID macht die Reihenfolge unabhängig vom Speicherort.
  const zeilen = await trx
    .selectFrom('katalog_abschluss')
    .selectAll()
    .where('monat', '=', tag)
    .orderBy(sql`projekt_id IS NULL`)
    .orderBy('id')
    .execute();
  if (zeilen.length === 0) return null;
  const katalog = new Map<string, EigeneKosten>();
  const knoten = new Map<string, KostenKnoten>();
  const offen: KatalogKostenAntwort['offen'] = { repos: [], ohne_repo: NULL_KENNZAHLEN };
  for (const z of zeilen) {
    const eigenes = sicht === null || (z.projekt_id !== null && sicht.includes(z.projekt_id));
    if (!eigenes) continue;
    const k = kennzahlenAus(z);
    if (z.nummer === '') {
      if (z.projekt_id) offen.repos.push({ id: z.projekt_id, name: z.projekt_name ?? '', ...k });
      else offen.ohne_repo = k;
      continue;
    }
    const schluessel = z.externe_id || z.nummer;
    let p = katalog.get(schluessel);
    if (!p) {
      p = {
        externe_id: schluessel,
        nummer: z.nummer,
        name: z.name,
        pfad: z.pfad ?? z.name,
        kunde: z.kunde,
        repos: [],
        ohne_repo: NULL_KENNZAHLEN,
        sitzungen_ohne_repo: 0,
        ...NULL_KENNZAHLEN,
      };
      katalog.set(schluessel, p);
      knoten.set(schluessel, {
        externe_id: schluessel,
        // Fehlt das Elternprojekt in dieser Sicht oder im Stand, steht das Kind oben. Vor Migration 0031: alles flach.
        parent_externe_id: z.parent_externe_id,
        nummer: p.nummer,
        name: p.name,
        pfad: p.pfad,
        kunde: p.kunde,
      });
    }
    if (z.projekt_id) {
      p.repos.push({ id: z.projekt_id, name: z.projekt_name ?? '', ...k });
    } else {
      p.ohne_repo = k;
      p.sitzungen_ohne_repo = Number(z.sitzungen);
    }
    Object.assign(p, plus(p, k));
  }
  return {
    monat,
    quelle: 'monatsabschluss',
    projekte: mitSummen(katalog, [...knoten.values()]),
    gesamt: gesamtAus(katalog, offen),
    eingeschraenkt: sicht !== null,
    offen,
  };
}

export async function kostenBerechnen(
  trx: KatalogTrx,
  sicht: KostenSicht,
  monat: string,
): Promise<KatalogKostenAntwort> {
  return (await kostenAusAbschluss(trx, sicht, monat)) ?? kostenLive(trx, sicht, monat);
}
