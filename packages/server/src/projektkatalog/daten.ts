// Datenzugriff des Projektkatalogs (immer innerhalb von `withMandant`): Import, Einstellungen, Zuordnungen.
import type {
  KatalogEinstellung,
  KatalogImportErgebnis,
  KatalogKurz,
  KatalogProjekt,
  KatalogZuordnungAntwort,
} from '@seatmeter/shared';
import { katalogBaumBauen, katalogBaumFiltern, katalogPfadText } from '@seatmeter/shared';
import { sql, type Transaction } from 'kysely';
import type { Konfiguration } from '../config.js';
import type { Datenbank } from '../db/schema.js';
import { projektAnzeigename } from '../issues/routen.js';
import type { KatalogLadung } from './quelle.js';
import { auswahlErreichbar, projektwahlHinderung } from './stufe.js';
import { inaktivListe, katalogSperren, syncStandLaden } from './sync.js';

export type KatalogTrx = Transaction<Datenbank>;

const JE_EINFUEGEN = 500;

export interface KatalogAbgleichOptionen {
  /** Projekte, die fehlen, werden inaktiv. */
  vollstaendig: boolean;
  /** Nur rechnen: dieselben Zahlen wie der echte Lauf, nichts wird geschrieben. */
  trockenlauf?: boolean;
  jetzt?: Date;
}

interface BisherigesProjekt {
  externe_id: string;
  nummer: string | null;
  name: string;
  kunde: string | null;
  parent_externe_id: string | null;
  status_roh: string | null;
  aktiv: boolean;
}

/** Reine Rechnung, damit Trockenlauf und echter Lauf dieselben Zahlen liefern. */
function abgleichPlanen(
  vorher: readonly BisherigesProjekt[],
  ladung: KatalogLadung,
  vollstaendig: boolean,
) {
  const bisher = new Map(vorher.map((v) => [v.externe_id, v]));
  const geschuetzt = new Set(ladung.geschuetzt);
  // Die JSON-Liste darf IDs wiederholen: die letzte zählt. Die CSV liefert jede ID höchstens einmal.
  const eindeutig = [...new Map(ladung.eintraege.map((e) => [e.externe_id, e])).values()].filter(
    (e) => !geschuetzt.has(e.externe_id),
  );
  let neu = 0;
  let aktualisiert = 0;
  let unveraendert = 0;
  const schreiben = eindeutig.map((e) => {
    const b = bisher.get(e.externe_id);
    // Weggelassen bleibt der gespeicherte Wert, `null` leert ihn.
    const nummer = e.nummer === undefined ? (b?.nummer ?? null) : e.nummer;
    const kunde = e.kunde === undefined ? (b?.kunde ?? null) : e.kunde;
    const parent = e.parent === undefined ? (b?.parent_externe_id ?? null) : e.parent;
    const status = e.status === undefined ? (b?.status_roh ?? null) : e.status;
    if (!b) neu += 1;
    else if (
      b.name !== e.name ||
      b.nummer !== nummer ||
      b.kunde !== kunde ||
      b.parent_externe_id !== parent ||
      b.aktiv !== e.aktiv
    ) {
      aktualisiert += 1;
    } else unveraendert += 1;
    return { ...e, nummer, kunde, parent, status };
  });
  // Ohne eine gültige Zeile stimmt mit der Datei etwas nicht: dann nichts deaktivieren.
  const uebersprungen =
    vollstaendig && (ladung.nummerUnlesbar || (schreiben.length === 0 && ladung.abgelehnt > 0));
  const gelesen = new Set(schreiben.map((e) => e.externe_id));
  const deaktivieren =
    vollstaendig && !uebersprungen
      ? vorher
          .filter((v) => v.aktiv && !gelesen.has(v.externe_id) && !geschuetzt.has(v.externe_id))
          .map((v) => v.externe_id)
      : [];
  const nachher = new Map(vorher.map((v) => [v.externe_id, v.aktiv]));
  for (const e of schreiben) nachher.set(e.externe_id, e.aktiv);
  for (const n of deaktivieren) nachher.set(n, false);
  return {
    schreiben,
    deaktivieren,
    uebersprungen,
    zaehler: { neu, aktualisiert, unveraendert },
    aktivGesamt: [...nachher.values()].filter(Boolean).length,
  };
}

/**
 * Gleicht den Katalog mit der Ladung einer Quelle ab (einziger Schreibpfad für Listen): Upsert über die externe ID, bei
 * `vollstaendig` werden fehlende Projekte inaktiv. Nichts wird gelöscht, Zuordnungen bleiben gültig. Projekte
 * abgelehnter Zeilen bleiben unberührt.
 */
export async function katalogAbgleichen(
  trx: KatalogTrx,
  mandantId: string,
  quelle: string,
  ladung: KatalogLadung,
  optionen: KatalogAbgleichOptionen,
): Promise<KatalogImportErgebnis> {
  const { vollstaendig, trockenlauf = false, jetzt = new Date() } = optionen;
  // Zwei gleichzeitige Importe würden sonst gegen denselben alten Stand rechnen.
  if (!trockenlauf) await katalogSperren(trx, mandantId);
  const vorher = await trx
    .selectFrom('katalog_projekt')
    .select(['externe_id', 'nummer', 'name', 'kunde', 'parent_externe_id', 'status_roh', 'aktiv'])
    .execute();
  const plan = abgleichPlanen(vorher, ladung, vollstaendig);
  if (!trockenlauf) {
    for (let i = 0; i < plan.schreiben.length; i += JE_EINFUEGEN) {
      await trx
        .insertInto('katalog_projekt')
        .values(
          plan.schreiben.slice(i, i + JE_EINFUEGEN).map((e) => ({
            mandant_id: mandantId,
            externe_id: e.externe_id,
            nummer: e.nummer,
            name: e.name,
            kunde: e.kunde,
            parent_externe_id: e.parent,
            status_roh: e.status,
            aktiv: e.aktiv,
            quelle,
            zuletzt_gesehen: jetzt,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['mandant_id', 'externe_id']).doUpdateSet((eb) => ({
            nummer: eb.ref('excluded.nummer'),
            name: eb.ref('excluded.name'),
            kunde: eb.ref('excluded.kunde'),
            parent_externe_id: eb.ref('excluded.parent_externe_id'),
            status_roh: eb.ref('excluded.status_roh'),
            aktiv: eb.ref('excluded.aktiv'),
            quelle: eb.ref('excluded.quelle'),
            zuletzt_gesehen: eb.ref('excluded.zuletzt_gesehen'),
          })),
        )
        .execute();
    }
    for (let i = 0; i < plan.deaktivieren.length; i += JE_EINFUEGEN) {
      await trx
        .updateTable('katalog_projekt')
        .set({ aktiv: false })
        .where('externe_id', 'in', plan.deaktivieren.slice(i, i + JE_EINFUEGEN))
        .execute();
    }
    await trx
      .insertInto('mandant_projektkatalog')
      .values({ mandant_id: mandantId, zuletzt_import: jetzt, import_quelle: quelle })
      .onConflict((oc) =>
        oc.column('mandant_id').doUpdateSet({
          zuletzt_import: jetzt,
          import_quelle: quelle,
          geaendert: jetzt,
        }),
      )
      .execute();
  }
  return {
    ...plan.zaehler,
    deaktiviert: plan.deaktivieren.length,
    abgelehnt: ladung.abgelehnt,
    aktiv_gesamt: plan.aktivGesamt,
    abgelehnte_zeilen: ladung.meldungen,
    hinweise: ladung.hinweise,
    deaktivierung_uebersprungen: plan.uebersprungen,
    trockenlauf,
  };
}

export async function aktiveProjekte(trx: KatalogTrx): Promise<number> {
  const z = await trx
    .selectFrom('katalog_projekt')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('aktiv', '=', true)
    .executeTakeFirstOrThrow();
  return Number(z.n);
}

export async function einstellungLaden(
  trx: KatalogTrx,
  konfiguration: Konfiguration,
): Promise<KatalogEinstellung> {
  const e = await trx.selectFrom('mandant_projektkatalog').selectAll().executeTakeFirst();
  const z = await sql<{ gesamt: number; aktiv: number }>`
    SELECT count(*)::int AS gesamt, (count(*) FILTER (WHERE aktiv))::int AS aktiv
    FROM katalog_projekt`.execute(trx);
  const { alter_stunden: _alter, ...sync } = await syncStandLaden(trx, e);
  return {
    stufe: e?.stufe ?? 'aus',
    kontakt: e?.kontakt ?? null,
    hinderung: projektwahlHinderung(konfiguration),
    auswahl_erreichbar: await auswahlErreichbar(trx, konfiguration),
    inaktiv_status: inaktivListe(e?.inaktiv_status),
    sync,
    zuletzt_import: e?.zuletzt_import ? new Date(e.zuletzt_import).toISOString() : null,
    import_quelle: e?.import_quelle ?? null,
    projekte_aktiv: Number(z.rows[0]?.aktiv ?? 0),
    projekte_gesamt: Number(z.rows[0]?.gesamt ?? 0),
  };
}

/** Ohne Nummer zeigt die Anzeige die externe ID. */
function mitAnzeigeNummer<T extends { externe_id: string; nummer: string | null }>(z: T) {
  return { ...z, nummer: z.nummer ?? z.externe_id };
}

async function baumLaden(trx: KatalogTrx) {
  const zeilen = await trx
    .selectFrom('katalog_projekt')
    .select([
      'id',
      'externe_id',
      'nummer',
      'name',
      'kunde',
      'parent_externe_id',
      'status_roh',
      'aktiv',
      'quelle',
      'zuletzt_gesehen',
    ])
    .execute();
  return katalogBaumBauen(zeilen.map(mitAnzeigeNummer));
}

/** Pfad je Katalog-Projekt, z. B. `Webshop › AP Login`, für Kosten, Zuordnung und Bestätigung. */
export async function katalogPfade(trx: KatalogTrx): Promise<Map<string, string>> {
  const baum = await baumLaden(trx);
  return new Map(baum.map((z) => [z.projekt.id, katalogPfadText(z.pfad)]));
}

/**
 * Projekte in Baumreihenfolge. `nurAktive`: aktive Projekte plus ihre inaktiven Vorfahren als Kontext (nicht wählbar),
 * damit die Auswahl die Hierarchie zeigen kann.
 */
export async function projekteLaden(
  trx: KatalogTrx,
  nurAktive: boolean,
): Promise<KatalogProjekt[]> {
  const baum = await baumLaden(trx);
  const zeilen = nurAktive ? katalogBaumFiltern(baum, (p) => p.aktiv) : baum;
  return zeilen.map(({ projekt: p, pfad }) => ({
    id: p.id,
    externe_id: p.externe_id,
    nummer: p.nummer,
    name: p.name,
    pfad: katalogPfadText(pfad),
    parent_externe_id: p.parent_externe_id,
    kunde: p.kunde,
    aktiv: p.aktiv,
    status: p.status_roh,
    quelle: p.quelle,
    zuletzt_gesehen: new Date(p.zuletzt_gesehen).toISOString(),
  }));
}

export async function katalogProjektLaden(
  trx: KatalogTrx,
  id: string,
): Promise<KatalogKurz | null> {
  const p = await trx
    .selectFrom('katalog_projekt')
    .select(['id', 'externe_id', 'nummer', 'name', 'kunde', 'parent_externe_id', 'aktiv'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!p) return null;
  const pfade = await katalogPfade(trx);
  return { ...mitAnzeigeNummer(p), pfad: pfade.get(p.id) ?? p.name };
}

/** Alle sichtbaren seatmeter-Projekte mit Zuordnung; `projektIds` wie in der Anmeldung (`null` = alle). */
export async function zuordnungLaden(
  trx: KatalogTrx,
  projektIds: readonly string[] | null,
): Promise<KatalogZuordnungAntwort> {
  if (projektIds !== null && projektIds.length === 0) return { zuordnung: [] };
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
      'katalog_projekt.parent_externe_id',
      'katalog_projekt.aktiv',
    ])
    // Nur Repos mit Nutzung oder Wahl: Zeilen ohne beides sind keine Arbeit an einem Projekt.
    .where((eb) =>
      eb.or([
        eb('projekt_katalog.projekt_id', 'is not', null),
        eb.exists(
          eb
            .selectFrom('tag_aggregat')
            .select('tag_aggregat.projekt_id')
            .whereRef('tag_aggregat.projekt_id', '=', 'projekt.id'),
        ),
        eb.exists(
          eb
            .selectFrom('anfrage')
            .select('anfrage.projekt_id')
            .whereRef('anfrage.projekt_id', '=', 'projekt.id'),
        ),
      ]),
    );
  if (projektIds !== null) q = q.where('projekt.id', 'in', projektIds);
  const zeilen = await q.execute();
  const pfade = await katalogPfade(trx);
  return {
    zuordnung: zeilen
      .map((z) => ({
        projekt_id: z.id,
        projekt_name: projektAnzeigename(z),
        katalog:
          z.katalog_id && z.externe_id && z.name
            ? {
                id: z.katalog_id,
                externe_id: z.externe_id,
                nummer: z.nummer ?? z.externe_id,
                name: z.name,
                pfad: pfade.get(z.katalog_id) ?? z.name,
                parent_externe_id: z.parent_externe_id,
                kunde: z.kunde,
                aktiv: z.aktiv ?? false,
              }
            : null,
      }))
      .sort((x, y) => x.projekt_name.localeCompare(y.projekt_name)),
  };
}

/** Name und Kunde aus dem Katalog je seatmeter-Projekt (für die Seite „Projekte“). */
export async function katalogNamenLaden(
  trx: KatalogTrx,
  projektIds: readonly string[],
): Promise<Map<string, { name: string; kunde: string | null }>> {
  if (projektIds.length === 0) return new Map();
  const zeilen = await trx
    .selectFrom('projekt_katalog')
    .innerJoin('katalog_projekt', 'katalog_projekt.id', 'projekt_katalog.katalog_projekt_id')
    .select([
      'projekt_katalog.projekt_id',
      'katalog_projekt.externe_id',
      'katalog_projekt.nummer',
      'katalog_projekt.name',
      'katalog_projekt.kunde',
    ])
    .where('projekt_katalog.projekt_id', 'in', [...projektIds])
    .execute();
  return new Map(
    zeilen.map((z) => [
      z.projekt_id,
      { name: `${z.nummer ?? z.externe_id} ${z.name}`, kunde: z.kunde },
    ]),
  );
}
