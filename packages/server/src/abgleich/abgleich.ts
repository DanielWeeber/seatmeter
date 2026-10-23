// Abgleich (Architektur §2.6): Quelle C (Analytics API bzw. Team-CSV) → Tabelle `ueberschreitung`
// je Person/Tag/Modell und ein Lauf in `abgleich_lauf` mit Abweichungsbericht gegen `tag_aggregat`
// (Schwelle ±3 %, Zusammenfassung ohne Personendaten). Personen werden über HMAC-Schlüssel gefunden:
// actor.user_id → `person.key_konto_id` (HMAC(account_id), vom Kern-Ingest gefüllt), sonst `key_konto`;
// E-Mail → `key_email`. Rohwerte werden nie gespeichert.
import type { AbgleichLauf, AbgleichZusammenfassung, CsvZuordnung } from '@seatmeter/shared';
import { personKeyEmail, personKeyKonto } from '@seatmeter/shared/hmac';
import { plusTage } from '../aggregation/tage.js';
import { withMandant } from '../db/mandant.js';
import type { Datenbank } from '../db/schema.js';
import { mandantSaltsLaden } from '../ingest-gemeinsam/geheimnis.js';
import { entschluessele, verschluessele } from '../krypto.js';
import type { PluginKontext } from '../plugin.js';
import { sql, type Transaction } from 'kysely';
import {
  AnalyticsFehler,
  holeKosten,
  holeNutzung,
  type AnalyticsOptionen,
  type FetchFunktion,
} from './analytics.js';
import { leseSpendCsv, type CsvErgebnis } from './csv.js';

type Trx = Transaction<Datenbank>;
export const AAD_ANALYTICS = 'mandant_geheimnis.analytics_key';
export const SCHWELLE_PROZENT = 3;
export type Ausloeser = 'plan' | 'einmal' | 'api';

export interface AbgleichOptionen {
  fetch?: FetchFunktion;
  basis?: string;
  warte?: (ms: number) => Promise<void>;
}

/** Ein Posten der Quelle C nach der Personenzuordnung. */
export interface QuellePosten {
  personId: string | null;
  /** Gehashte Kennung der Quelle (hex), nur zum Zählen nicht zugeordneter Personentage. */
  akteur: string;
  tag: string;
  model: string;
  amountUsdMicros: number;
  listAmountUsdMicros: number | null;
  tokens: { input: number; output: number; cache_read: number; cache_write: number } | null;
}

interface PersonIndex {
  konto: Map<string, string>;
  email: Map<string, string>;
}

async function personIndex(trx: Trx): Promise<PersonIndex> {
  const personen = await trx
    .selectFrom('person')
    .select(['id', 'key_konto', 'key_konto_id', 'key_email'])
    .execute();
  const idx: PersonIndex = { konto: new Map(), email: new Map() };
  for (const p of personen) {
    // key_konto_id (account_id) zuerst; key_konto trifft, wenn der Ingest nur account_id kannte.
    if (p.key_konto) idx.konto.set(p.key_konto.toString('hex'), p.id);
    if (p.key_konto_id) idx.konto.set(p.key_konto_id.toString('hex'), p.id);
    if (p.key_email) idx.email.set(p.key_email.toString('hex'), p.id);
  }
  return idx;
}

function finde(idx: PersonIndex, konto: Buffer | null, email: Buffer | null): string | null {
  return (
    (konto ? idx.konto.get(konto.toString('hex')) : undefined) ??
    (email ? idx.email.get(email.toString('hex')) : undefined) ??
    null
  );
}

const summeTokens = (t: QuellePosten['tokens']) =>
  t ? t.input + t.output + t.cache_read + t.cache_write : 0;

/** Schreibt `ueberschreitung` für [von, bisExklusiv): alte Zeilen derselben Quelle weg, neue (amount > 0) rein. */
export async function schreibeUeberschreitung(
  trx: Trx,
  quelle: 'api' | 'csv',
  von: string,
  bisExklusiv: string,
  posten: readonly QuellePosten[],
): Promise<{ zeilen: number; usdMicros: number }> {
  await trx
    .deleteFrom('ueberschreitung')
    .where('quelle', '=', quelle)
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .execute();
  const je = new Map<string, QuellePosten & { personId: string }>();
  for (const p of posten) {
    if (!p.personId || p.amountUsdMicros <= 0) continue;
    const k = `${p.personId}|${p.tag}|${p.model}`;
    const alt = je.get(k);
    if (!alt) {
      je.set(k, { ...p, personId: p.personId, tokens: p.tokens ? { ...p.tokens } : null });
      continue;
    }
    alt.amountUsdMicros += p.amountUsdMicros;
    alt.listAmountUsdMicros =
      alt.listAmountUsdMicros === null && p.listAmountUsdMicros === null
        ? null
        : (alt.listAmountUsdMicros ?? 0) + (p.listAmountUsdMicros ?? 0);
    if (p.tokens) {
      alt.tokens ??= { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      alt.tokens.input += p.tokens.input;
      alt.tokens.output += p.tokens.output;
      alt.tokens.cache_read += p.tokens.cache_read;
      alt.tokens.cache_write += p.tokens.cache_write;
    }
  }
  let usdMicros = 0;
  for (const p of je.values()) {
    usdMicros += p.amountUsdMicros;
    const werte = {
      amount_usd_micros: p.amountUsdMicros,
      list_amount_usd_micros: p.listAmountUsdMicros,
      input: p.tokens?.input ?? 0,
      output: p.tokens?.output ?? 0,
      cache_read: p.tokens?.cache_read ?? 0,
      cache_write: p.tokens?.cache_write ?? 0,
      quelle,
    };
    const q = trx
      .insertInto('ueberschreitung')
      .values({
        mandant_id: sql<string>`app_mandant_id()`,
        tag: p.tag,
        person_id: p.personId,
        model: p.model,
        ...werte,
      })
      .onConflict((oc) => {
        const u = oc.columns(['mandant_id', 'tag', 'person_id', 'model']).doUpdateSet(werte);
        // Die API gewinnt: eine CSV überschreibt keine API-Zeile.
        return quelle === 'csv' ? u.where('ueberschreitung.quelle', '=', 'csv') : u;
      });
    await q.execute();
  }
  return { zeilen: je.size, usdMicros };
}

/** Abweichungsbericht: Tokens der Quelle je Person/Tag gegen das Tagesaggregat (nur Abo). */
export async function abweichungen(
  trx: Trx,
  von: string,
  bisExklusiv: string,
  posten: readonly QuellePosten[],
  ueberschreitung: { zeilen: number; usdMicros: number },
): Promise<AbgleichZusammenfassung> {
  const quelle = new Map<string, number>();
  const personentage = new Set<string>();
  const ohne = new Set<string>();
  let mitTokens = false;
  for (const p of posten) {
    if (p.tokens) mitTokens = true;
    if (!p.personId) {
      ohne.add(`${p.akteur}|${p.tag}`);
      continue;
    }
    const k = `${p.personId}|${p.tag}`;
    personentage.add(k);
    quelle.set(k, (quelle.get(k) ?? 0) + summeTokens(p.tokens));
  }
  const agg = await trx
    .selectFrom('tag_aggregat')
    .select([
      'person_id',
      'tag',
      sql<string>`sum(input + output + cache_read + cache_write)`.as('tokens'),
    ])
    .where('tag', '>=', von)
    .where('tag', '<', bisExklusiv)
    .where('person_id', 'is not', null)
    .groupBy(['person_id', 'tag'])
    .execute();
  const seatmeter = new Map(agg.map((z) => [`${z.person_id}|${z.tag}`, Number(z.tokens)]));
  const tage = new Map<string, { q: number; s: number }>();
  const z: AbgleichZusammenfassung = {
    schwelle_prozent: SCHWELLE_PROZENT,
    personentage_quelle: personentage.size + ohne.size,
    zugeordnet: personentage.size,
    ohne_zuordnung: ohne.size,
    abweichend: 0,
    innerhalb: 0,
    nur_seatmeter: 0,
    tokens_quelle: 0,
    tokens_seatmeter: 0,
    abdeckung_prozent: null,
    ueberschreitung_zeilen: ueberschreitung.zeilen,
    ueberschreitung_usd_micros: ueberschreitung.usdMicros,
    tage: [],
  };
  for (const k of personentage) {
    const q = quelle.get(k) ?? 0;
    const s = seatmeter.get(k) ?? 0;
    const tag = k.slice(k.indexOf('|') + 1);
    const t = tage.get(tag) ?? { q: 0, s: 0 };
    t.q += q;
    t.s += s;
    tage.set(tag, t);
    z.tokens_quelle += q;
    z.tokens_seatmeter += s;
    if (!mitTokens) continue;
    const abw = q > 0 ? Math.abs(s - q) / q : s > 0 ? 1 : 0;
    if (abw * 100 > SCHWELLE_PROZENT) z.abweichend += 1;
    else z.innerhalb += 1;
  }
  for (const [k, s] of seatmeter) {
    if (personentage.has(k) || s <= 0) continue;
    z.nur_seatmeter += 1;
    const tag = k.slice(k.indexOf('|') + 1);
    const t = tage.get(tag) ?? { q: 0, s: 0 };
    t.s += s;
    tage.set(tag, t);
    z.tokens_seatmeter += s;
  }
  if (mitTokens && z.tokens_quelle > 0) {
    z.abdeckung_prozent = Math.round((z.tokens_seatmeter / z.tokens_quelle) * 1000) / 10;
  }
  z.tage = [...tage]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, t]) => ({
      tag,
      tokens_quelle: t.q,
      tokens_seatmeter: t.s,
      abweichung_prozent: mitTokens && t.q > 0 ? Math.round(((t.s - t.q) / t.q) * 1000) / 10 : null,
    }));
  return z;
}

function status(z: AbgleichZusammenfassung): 'ok' | 'abweichung' {
  return z.abweichend > 0 || z.ohne_zuordnung > 0 ? 'abweichung' : 'ok';
}

export function laufDto(z: {
  id: string;
  quelle: 'api' | 'csv';
  zeitraum: string;
  status: AbgleichLauf['status'];
  ausloeser: Ausloeser;
  gestartet: Date;
  beendet: Date | null;
  zeilen: number;
  fehler: string | null;
  abweichungen: unknown;
}): AbgleichLauf {
  // daterange '[von,bis)' → von und bis (inklusiv).
  const m = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/.exec(z.zeitraum) ?? [];
  return {
    id: z.id,
    quelle: z.quelle,
    von: m[1] ?? '',
    bis: m[2] ? plusTage(m[2], -1) : '',
    status: z.status,
    ausloeser: z.ausloeser,
    gestartet: new Date(z.gestartet).toISOString(),
    beendet: z.beendet ? new Date(z.beendet).toISOString() : null,
    zeilen: z.zeilen,
    fehler: z.fehler,
    zusammenfassung: (z.abweichungen as AbgleichZusammenfassung | null) ?? null,
  };
}

export const LAUF_SPALTEN = [
  'id',
  'quelle',
  sql<string>`zeitraum::text`.as('zeitraum'),
  'status',
  'ausloeser',
  'gestartet',
  'beendet',
  'zeilen',
  'fehler',
  'abweichungen',
] as const;

async function laufAnlegen(
  ctx: PluginKontext,
  mandantId: string,
  quelle: 'api' | 'csv',
  von: string,
  bisEx: string,
  ausloeser: Ausloeser,
) {
  return withMandant(ctx.db, mandantId, (trx) =>
    trx
      .insertInto('abgleich_lauf')
      .values({
        mandant_id: sql<string>`app_mandant_id()`,
        zeitraum: sql<string>`daterange(${von}::date, ${bisEx}::date)`,
        quelle,
        ausloeser,
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
}

async function laufLaden(trx: Trx, id: string): Promise<AbgleichLauf> {
  return laufDto(
    await trx
      .selectFrom('abgleich_lauf')
      .select(LAUF_SPALTEN)
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
}

async function laufFehler(
  ctx: PluginKontext,
  mandantId: string,
  id: string,
  fehler: unknown,
): Promise<AbgleichLauf> {
  const text =
    fehler instanceof AnalyticsFehler
      ? fehler.message
      : 'Abgleich fehlgeschlagen (Details im Server-Log ohne Inhalte)';
  return withMandant(ctx.db, mandantId, async (trx) => {
    await trx
      .updateTable('abgleich_lauf')
      .set({ status: 'fehler', fehler: text, beendet: new Date() })
      .where('id', '=', id)
      .execute();
    return laufLaden(trx, id);
  });
}

/** Analytics-Key (verschlüsselt) setzen bzw. löschen. */
export async function setzeAnalyticsKey(
  trx: Trx,
  masterKey: Buffer,
  mandantId: string,
  key: string | null,
): Promise<void> {
  await mandantSaltsLaden(trx, masterKey, mandantId);
  await trx
    .updateTable('mandant_geheimnis')
    .set({
      analytics_key: key === null ? null : verschluessele(masterKey, key, AAD_ANALYTICS),
      analytics_key_geaendert: new Date(),
    })
    .where('mandant_id', '=', mandantId)
    .execute();
}

/** Abgleich mit der Analytics API für [von, bis] (UTC-Tage, inklusiv). */
export async function abgleichAnalytics(
  ctx: PluginKontext,
  mandantId: string,
  von: string,
  bis: string,
  ausloeser: Ausloeser,
  o: AbgleichOptionen = {},
): Promise<AbgleichLauf> {
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;
  const bisEx = plusTage(bis, 1);
  const lauf = await laufAnlegen(ctx, mandantId, 'api', von, bisEx, ausloeser);
  try {
    const { key, salt } = await withMandant(ctx.db, mandantId, async (trx) => {
      const { personSalt } = await mandantSaltsLaden(trx, masterKey, mandantId);
      const g = await trx
        .selectFrom('mandant_geheimnis')
        .select('analytics_key')
        .executeTakeFirst();
      return {
        key: g?.analytics_key
          ? entschluessele(masterKey, g.analytics_key, AAD_ANALYTICS).toString('utf8')
          : null,
        salt: personSalt,
      };
    });
    if (!key) throw new AnalyticsFehler('auth', null, 'Kein Analytics-Key hinterlegt');
    const ao: AnalyticsOptionen = {
      key,
      pseudonymisiere: (userId, email) => ({
        konto: personKeyKonto(salt, userId),
        email: email ? personKeyEmail(salt, email) : null,
      }),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.basis ? { basis: o.basis } : {}),
      ...(o.warte ? { warte: o.warte } : {}),
    };
    const nutzung = await holeNutzung(ao, von, bisEx);
    const kosten = await holeKosten(ao, von, bisEx);
    return await withMandant(ctx.db, mandantId, async (trx) => {
      const idx = await personIndex(trx);
      const posten: QuellePosten[] = nutzung.map((n) => ({
        personId: finde(idx, n.akteur.konto, n.akteur.email),
        akteur: n.akteur.konto.toString('hex'),
        tag: n.tag,
        model: n.model,
        amountUsdMicros: 0,
        listAmountUsdMicros: null,
        tokens: {
          input: n.input,
          output: n.output,
          cache_read: n.cache_read,
          cache_write: n.cache_write,
        },
      }));
      // Kosten an die Nutzungszeile gleicher Person/Tag/Modell hängen (Tokens der Überschreitung).
      const nachSchluessel = new Map(
        posten.map((p, i) => [
          `${nutzung[i]!.akteur.konto.toString('hex')}|${p.tag}|${p.model}`,
          p,
        ]),
      );
      for (const k of kosten) {
        const p = nachSchluessel.get(`${k.akteur.konto.toString('hex')}|${k.tag}|${k.model}`);
        if (p) {
          p.amountUsdMicros += k.amountUsdMicros;
          p.listAmountUsdMicros =
            k.listAmountUsdMicros === null
              ? p.listAmountUsdMicros
              : (p.listAmountUsdMicros ?? 0) + k.listAmountUsdMicros;
        } else {
          posten.push({
            personId: finde(idx, k.akteur.konto, k.akteur.email),
            akteur: k.akteur.konto.toString('hex'),
            tag: k.tag,
            model: k.model,
            amountUsdMicros: k.amountUsdMicros,
            listAmountUsdMicros: k.listAmountUsdMicros,
            tokens: null,
          });
        }
      }
      const ue = await schreibeUeberschreitung(trx, 'api', von, bisEx, posten);
      const z = await abweichungen(trx, von, bisEx, posten, ue);
      await trx
        .updateTable('abgleich_lauf')
        .set({
          status: status(z),
          abweichungen: JSON.stringify(z),
          zeilen: nutzung.length + kosten.length,
          beendet: new Date(),
        })
        .where('id', '=', lauf.id)
        .execute();
      return laufLaden(trx, lauf.id);
    });
  } catch (fehler) {
    return laufFehler(ctx, mandantId, lauf.id, fehler);
  }
}

/** Vorschau bzw. Import des Team-Spend-CSV. */
export async function leseCsvFuerMandant(
  ctx: PluginKontext,
  mandantId: string,
  csv: string,
  zuordnung: CsvZuordnung | undefined,
  betragEinheit: 'usd' | 'cent' | undefined,
): Promise<{ ergebnis: CsvErgebnis; personen: (string | null)[] }> {
  return withMandant(ctx.db, mandantId, async (trx) => {
    const { personSalt } = await mandantSaltsLaden(
      trx,
      ctx.konfiguration.SEATMETER_MASTER_KEY,
      mandantId,
    );
    const ergebnis = leseSpendCsv(csv, (email) => personKeyEmail(personSalt, email), {
      ...(zuordnung ? { zuordnung } : {}),
      ...(betragEinheit ? { betragEinheit } : {}),
    });
    const idx = await personIndex(trx);
    return { ergebnis, personen: ergebnis.zeilen.map((z) => finde(idx, null, z.emailKey)) };
  });
}

export async function abgleichCsv(
  ctx: PluginKontext,
  mandantId: string,
  csv: string,
  zuordnung: CsvZuordnung | undefined,
  betragEinheit: 'usd' | 'cent' | undefined,
  ausloeser: Ausloeser,
): Promise<AbgleichLauf | { ungueltig: string[] }> {
  const { ergebnis, personen } = await leseCsvFuerMandant(
    ctx,
    mandantId,
    csv,
    zuordnung,
    betragEinheit,
  );
  if (ergebnis.zeilen.length === 0)
    return { ungueltig: ergebnis.fehler.length ? ergebnis.fehler : ['Keine gültigen Zeilen'] };
  const tage = ergebnis.zeilen.map((z) => z.tag).sort();
  const von = tage[0]!;
  const bisEx = plusTage(tage[tage.length - 1]!, 1);
  const lauf = await laufAnlegen(ctx, mandantId, 'csv', von, bisEx, ausloeser);
  try {
    return await withMandant(ctx.db, mandantId, async (trx) => {
      const posten: QuellePosten[] = ergebnis.zeilen.map((z, i) => ({
        personId: personen[i] ?? null,
        akteur: z.emailKey.toString('hex'),
        tag: z.tag,
        model: z.model,
        amountUsdMicros: z.amountUsdMicros,
        listAmountUsdMicros: z.listAmountUsdMicros,
        tokens: z.hatTokens
          ? {
              input: z.input,
              output: z.output,
              cache_read: z.cache_read,
              cache_write: z.cache_write,
            }
          : null,
      }));
      const ue = await schreibeUeberschreitung(trx, 'csv', von, bisEx, posten);
      const z = await abweichungen(trx, von, bisEx, posten, ue);
      await trx
        .updateTable('abgleich_lauf')
        .set({
          status: status(z),
          abweichungen: JSON.stringify(z),
          zeilen: ergebnis.zeilen.length,
          fehler: ergebnis.fehler.length ? ergebnis.fehler.slice(0, 5).join('; ') : null,
          beendet: new Date(),
        })
        .where('id', '=', lauf.id)
        .execute();
      return laufLaden(trx, lauf.id);
    });
  } catch (fehler) {
    return laufFehler(ctx, mandantId, lauf.id, fehler);
  }
}

/** Job `abgleich.analytics`: alle Mandanten mit Key, die letzten 8 UTC-Tage bis gestern (Revisionen). */
export async function abgleichJob(
  ctx: PluginKontext,
  o: AbgleichOptionen = {},
  jetzt: Date = new Date(),
) {
  const heute = jetzt.toISOString().slice(0, 10);
  const mandanten = await ctx.db
    .selectFrom('mandant_geheimnis')
    .select('mandant_id')
    .where('analytics_key', 'is not', null)
    .execute();
  const summe = { mandanten: 0, ok: 0, abweichung: 0, fehler: 0 };
  for (const m of mandanten) {
    const lauf = await abgleichAnalytics(
      ctx,
      m.mandant_id,
      plusTage(heute, -8),
      plusTage(heute, -1),
      'plan',
      o,
    );
    summe.mandanten += 1;
    if (lauf.status === 'ok') summe.ok += 1;
    else if (lauf.status === 'abweichung') summe.abweichung += 1;
    else summe.fehler += 1;
  }
  return summe;
}
