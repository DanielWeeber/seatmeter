// Kontenverwaltung durch den Mandanten-Admin (SSO je Mandant): Konten mit Rolle im Mandanten auflisten,
// per E-Mail einladen (Konto ohne Passwort + Einladungslink, 7 Tage), Rollen setzen, deaktivieren und alle
// Rollen entziehen. Das Kontenkontingent (`kontingent.ts`) greift, sobald ein Konto seine erste Rolle bekommt.
// Schutz: der letzte aktive Mandanten-Admin bleibt (409 `letzter_admin`), niemand deaktiviert sich selbst,
// ein Mandanten-Admin deaktiviert keine Konten mit Rollen in weiteren Mandanten und keine Plattform-Admins.
import { protokolliere } from '../audit/protokoll.js';
import { requireAnmeldung, rollenDesBenutzers } from '../auth/kontext.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import type { RolleQuelle } from '../db/schema.js';
import { sha256, zufallsToken } from '../krypto.js';
import { nurEntwickler, type Rolle } from '@seatmeter/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  kontingentFehler,
  ungueltig,
  verwalteterMandant,
  verwaltung,
  VERWALTUNG_AUDIT,
} from '../mandant/verwaltung.js';
import { benutzerParam, kontoAenderungSchema, kontoNeuSchema } from './schemas.js';

export type Trx = Parameters<Parameters<typeof withMandant>[2]>[0];
export type RollenQuelle = RolleQuelle;

export const EINLADUNG_TAGE = 7;

export interface Konto {
  id: string;
  benutzername: string;
  login: 'lokal' | 'oidc';
  rollen: { rolle: Rolle; projekt_ids: string[] | null; quelle: string }[];
  deaktiviert: Date | null;
  zuletzt_angemeldet: Date | null;
  einladung_offen: boolean;
  einladung_bis: Date | null;
  plattform_admin: boolean;
}

/**
 * Konten mit mindestens einer Rolle im Mandanten der Transaktion (ohne Passwort-Hash); `plattformAdmins` aus
 * der Verwaltung (ee), ohne Plugin leer.
 */
export async function kontenListe(
  trx: Trx,
  plattformAdmins: ReadonlySet<string>,
  nurBenutzer?: string,
): Promise<Konto[]> {
  let q = trx
    .selectFrom('rolle as r')
    .innerJoin('benutzer as b', 'b.id', 'r.benutzer_id')
    .select([
      'b.id',
      'b.benutzername',
      'b.login',
      'b.deaktiviert',
      'b.zuletzt_angemeldet',
      sql<boolean>`b.passwort_hash IS NULL`.as('ohne_passwort'),
      'r.rolle',
      'r.projekt_ids',
      'r.quelle',
    ])
    .orderBy('b.benutzername')
    .orderBy('r.rolle');
  if (nurBenutzer) q = q.where('b.id', '=', nurBenutzer);
  const zeilen = await q.execute();
  const einladungen = new Map(
    (await trx.selectFrom('konto_einladung').select(['benutzer_id', 'laeuft_ab']).execute()).map(
      (z) => [z.benutzer_id, z.laeuft_ab] as const,
    ),
  );
  const admins = plattformAdmins;
  const konten = new Map<string, Konto>();
  for (const z of zeilen) {
    let k = konten.get(z.id);
    if (!k) {
      const bis = z.ohne_passwort ? (einladungen.get(z.id) ?? null) : null;
      k = {
        id: z.id,
        benutzername: z.benutzername,
        login: z.login,
        rollen: [],
        deaktiviert: z.deaktiviert,
        zuletzt_angemeldet: z.zuletzt_angemeldet,
        einladung_offen: bis !== null && new Date(bis).getTime() > Date.now(),
        einladung_bis: bis,
        plattform_admin: admins.has(z.id),
      };
      konten.set(z.id, k);
    }
    k.rollen.push({ rolle: z.rolle, projekt_ids: z.projekt_ids, quelle: z.quelle });
  }
  return [...konten.values()];
}

/** Wäre `benutzerId` nach der Änderung kein aktiver Mandanten-Admin mehr der letzte? */
export async function istLetzterAdmin(trx: Trx, benutzerId: string): Promise<boolean> {
  const eigene = await trx
    .selectFrom('rolle as r')
    .innerJoin('benutzer as b', 'b.id', 'r.benutzer_id')
    .select('r.id')
    .where('r.benutzer_id', '=', benutzerId)
    .where('r.rolle', '=', 'mandanten_admin')
    .where('b.deaktiviert', 'is', null)
    .executeTakeFirst();
  if (!eigene) return false;
  const andere = await trx
    .selectFrom('rolle as r')
    .innerJoin('benutzer as b', 'b.id', 'r.benutzer_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('r.benutzer_id', '<>', benutzerId)
    .where('r.rolle', '=', 'mandanten_admin')
    .where('b.deaktiviert', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(andere.n) === 0;
}

/**
 * Setzt die Rollen eines Kontos im Mandanten auf `soll` (Herkunft `quelle`). `entziehen`: `alle` (Standard)
 * entzieht jede fehlende Rolle; `quelle` nur fehlende Rollen dieser Herkunft und lässt vorhandene Rollen
 * anderer Herkunft unverändert (OIDC/SCIM-Abgleich); `nie` ergänzt nur. Audit je Änderung.
 */
export async function rollenSetzen(
  trx: Trx,
  angabe: {
    benutzerId: string;
    soll: Map<Rolle, string[] | null>;
    quelle: RollenQuelle;
    entziehen?: 'alle' | 'quelle' | 'nie';
    akteur: string | null;
    hinweis?: string;
    /**
     * Bleibt dem Konto danach nur `entwickler`, steht es nicht im Audit: Das passiert bei der ersten Anmeldung über den
     * Link der Projektwahl, die Wahl selbst steht bewusst ohne Konto im Audit.
     */
    ohneKontoBeiEntwickler?: boolean;
  },
): Promise<{ zugewiesen: number; entzogen: number }> {
  const { benutzerId, soll, quelle } = angabe;
  const entziehen = angabe.entziehen ?? 'alle';
  const zusatz = angabe.hinweis ? ` (${angabe.hinweis})` : '';
  const ist = await trx
    .selectFrom('rolle')
    .select(['id', 'rolle', 'quelle', 'projekt_ids'])
    .where('benutzer_id', '=', benutzerId)
    .execute();
  const bleiben = ist.filter(
    (r) =>
      soll.has(r.rolle) || entziehen === 'nie' || (entziehen === 'quelle' && r.quelle !== quelle),
  );
  const ohneKonto =
    angabe.ohneKontoBeiEntwickler === true &&
    nurEntwickler([...soll.keys(), ...bleiben.map((r) => r.rolle)]);
  const akteur = ohneKonto ? null : angabe.akteur;
  const ziel = ohneKonto ? '' : `benutzer:${benutzerId} `;
  let zugewiesen = 0;
  let entzogen = 0;
  for (const r of ist) {
    if (soll.has(r.rolle) || entziehen === 'nie') continue;
    if (entziehen === 'quelle' && r.quelle !== quelle) continue;
    await trx.deleteFrom('rolle').where('id', '=', r.id).execute();
    entzogen++;
    await protokolliere(trx, {
      benutzerId: akteur,
      aktion: VERWALTUNG_AUDIT.rolleEntzogen,
      objekt: `${ziel}rolle:${r.rolle}${zusatz}`,
    });
  }
  for (const [rolle, projektIds] of soll) {
    const vorhanden = ist.find((r) => r.rolle === rolle);
    if (vorhanden && entziehen === 'quelle') continue;
    const ids = rolle === 'projektleiter' ? (projektIds ?? []) : null;
    if (
      vorhanden &&
      vorhanden.quelle === quelle &&
      JSON.stringify(vorhanden.projekt_ids) === JSON.stringify(ids)
    )
      continue;
    await trx
      .insertInto('rolle')
      .values({
        mandant_id: sql<string>`app_mandant_id()`,
        benutzer_id: benutzerId,
        rolle,
        projekt_ids: ids,
        quelle,
      })
      .onConflict((oc) =>
        oc
          .columns(['mandant_id', 'benutzer_id', 'rolle'])
          .doUpdateSet({ projekt_ids: ids, quelle }),
      )
      .execute();
    if (!vorhanden) zugewiesen++;
    await protokolliere(trx, {
      benutzerId: akteur,
      aktion: VERWALTUNG_AUDIT.rolleZugewiesen,
      objekt: `${ziel}rolle:${rolle}${zusatz}`,
    });
  }
  return { zugewiesen, entzogen };
}

/** Sperrt das Konto (alle Mandanten) und beendet alle seine Sitzungen. */
export async function kontoSperren(trx: Trx, benutzerId: string, akteur: string | null) {
  await trx
    .updateTable('benutzer')
    .set({ deaktiviert: new Date() })
    .where('id', '=', benutzerId)
    .where('deaktiviert', 'is', null)
    .execute();
  await trx.deleteFrom('benutzer_sitzung').where('benutzer_id', '=', benutzerId).execute();
  await protokolliere(trx, {
    benutzerId: akteur,
    aktion: VERWALTUNG_AUDIT.kontoDeaktiviert,
    objekt: `benutzer:${benutzerId}`,
  });
}

/** Hebt die Sperre auf (Sitzungen gibt es nach der Sperre keine mehr). */
export async function kontoEntsperren(trx: Trx, benutzerId: string, akteur: string | null) {
  await trx
    .updateTable('benutzer')
    .set({ deaktiviert: null })
    .where('id', '=', benutzerId)
    .execute();
  await protokolliere(trx, {
    benutzerId: akteur,
    aktion: VERWALTUNG_AUDIT.kontoAktiviert,
    objekt: `benutzer:${benutzerId}`,
  });
}

/** Neuer Einladungslink (ersetzt einen älteren dieses Mandanten); Token nur als SHA-256 gespeichert. */
async function einladungErzeugen(trx: Trx, benutzerId: string, akteur: string) {
  const token = zufallsToken(32);
  const bis = new Date(Date.now() + EINLADUNG_TAGE * 86_400_000);
  await trx
    .insertInto('konto_einladung')
    .values({
      mandant_id: sql<string>`app_mandant_id()`,
      benutzer_id: benutzerId,
      token_sha256: sha256(token),
      laeuft_ab: bis,
      erstellt_von: akteur,
    })
    .onConflict((oc) =>
      oc.columns(['mandant_id', 'benutzer_id']).doUpdateSet({
        token_sha256: sha256(token),
        laeuft_ab: bis,
        erstellt: new Date(),
        erstellt_von: akteur,
      }),
    )
    .execute();
  await protokolliere(trx, {
    benutzerId: akteur,
    aktion: VERWALTUNG_AUDIT.kontoEingeladen,
    objekt: `benutzer:${benutzerId}`,
  });
  return { url: `/einladung/${token}`, gueltig_bis: bis };
}

const LETZTER_ADMIN = {
  code: 'letzter_admin',
  fehler: 'Der letzte Mandanten-Admin kann nicht entfernt oder deaktiviert werden.',
} as const;

/** Hat das Konto Rollen in anderen Mandanten (ohne Plattform-Sicht)? */
async function fremdeRollen(db: Db, benutzerId: string, mandantId: string): Promise<boolean> {
  return (await rollenDesBenutzers(db, benutzerId)).some((r) => r.mandant_id !== mandantId);
}

function sollAus(rollen: Rolle[], projektIds: string[] | null | undefined) {
  return new Map<Rolle, string[] | null>(
    rollen.map((r) => [r, r === 'projektleiter' ? (projektIds ?? []) : null]),
  );
}

export function registriereKontenRouten(app: FastifyInstance, db: Db): void {
  const basis = '/api/v1/mandant/konten';
  const opt = { preHandler: requireAnmeldung };
  const v = verwaltung(app.seatmeterAuth);

  app.get(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    return withMandant(db, m.id, async (trx) => ({
      konten: await kontenListe(trx, await v.plattformAdmins()),
      kontingent: await v.kontingentStand(trx),
    }));
  });

  app.post(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const e = kontoNeuSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const akteur = request.benutzer!.benutzerId;
    const vorher = await db
      .selectFrom('benutzer')
      .select(['id', 'deaktiviert'])
      .where('benutzername', '=', e.data.benutzername)
      .executeTakeFirst();
    if (vorher?.deaktiviert)
      return reply
        .code(409)
        .send({ code: 'konto_gesperrt', fehler: 'Dieses Konto ist deaktiviert.' });
    const ergebnis = await withMandant(db, m.id, async (trx) => {
      const voll = await v.kontingentPruefen(trx, vorher?.id ?? null);
      if (voll) return { art: 'voll', stand: voll } as const;
      let id = vorher?.id;
      if (!id) {
        const neu = await trx
          .insertInto('benutzer')
          .values({ benutzername: e.data.benutzername, login: 'lokal' })
          .returning('id')
          .executeTakeFirstOrThrow();
        id = neu.id;
        await protokolliere(trx, {
          benutzerId: akteur,
          aktion: VERWALTUNG_AUDIT.kontoAngelegt,
          objekt: `benutzer:${id} (Einladung)`,
        });
      }
      await rollenSetzen(trx, {
        benutzerId: id,
        soll: sollAus(e.data.rollen, e.data.projekt_ids),
        quelle: 'manuell',
        entziehen: 'nie',
        akteur,
      });
      // Einladungslink nur für Konten, die diese Einladung angelegt hat (nie für fremde Konten).
      const einladung = vorher ? null : await einladungErzeugen(trx, id, akteur);
      const [konto] = await kontenListe(trx, await v.plattformAdmins(), id);
      return { art: 'ok', konto, einladung } as const;
    });
    if (ergebnis.art === 'voll') return reply.code(409).send(kontingentFehler(ergebnis.stand));
    return reply.code(201).send({ konto: ergebnis.konto, einladung: ergebnis.einladung });
  });

  app.post(`${basis}/:benutzerId/einladung`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const p = benutzerParam.safeParse(request.params);
    if (!p.success) return ungueltig(reply, p.error);
    const akteur = request.benutzer!.benutzerId;
    const ergebnis = await withMandant(db, m.id, async (trx) => {
      // Nur noch nicht angenommene Einladungen dieses Mandanten erneuern.
      const offen = await trx
        .selectFrom('konto_einladung as e')
        .innerJoin('benutzer as b', 'b.id', 'e.benutzer_id')
        .select('b.id')
        .where('e.benutzer_id', '=', p.data.benutzerId)
        .where('b.passwort_hash', 'is', null)
        .where('b.deaktiviert', 'is', null)
        .executeTakeFirst();
      if (!offen) return null;
      return einladungErzeugen(trx, p.data.benutzerId, akteur);
    });
    if (!ergebnis)
      return reply.code(404).send({ fehler: 'Keine offene Einladung für dieses Konto' });
    return reply.code(201).send({ einladung: ergebnis });
  });

  app.put(`${basis}/:benutzerId`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const p = benutzerParam.safeParse(request.params);
    if (!p.success) return ungueltig(reply, p.error);
    const e = kontoAenderungSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const akteur = request.benutzer!.benutzerId;
    const ziel = p.data.benutzerId;
    const fremd = e.data.deaktiviert === true ? await fremdeRollen(db, ziel, m.id) : false;
    const ergebnis = await withMandant(db, m.id, async (trx) => {
      const [konto] = await kontenListe(trx, await v.plattformAdmins(), ziel);
      if (!konto) return { status: 404, body: { fehler: 'Konto nicht gefunden' } } as const;
      if (konto.plattform_admin && m.zugriff !== 'plattform')
        return { status: 403, body: { fehler: 'Plattform-Admins verwaltet nur die Plattform' } };
      if (e.data.deaktiviert === true && !konto.deaktiviert) {
        if (ziel === akteur)
          return {
            status: 409,
            body: {
              code: 'letzter_admin',
              fehler: 'Das eigene Konto kann nicht deaktiviert werden.',
            },
          } as const;
        if (await istLetzterAdmin(trx, ziel)) return { status: 409, body: LETZTER_ADMIN } as const;
        if (fremd && m.zugriff !== 'plattform')
          return {
            status: 409,
            body: {
              code: 'konto_mehrere_mandanten',
              fehler:
                'Das Konto hat Rollen in weiteren Mandanten; bitte stattdessen die Rollen entziehen.',
            },
          } as const;
        await kontoSperren(trx, ziel, akteur);
      } else if (e.data.deaktiviert === false && konto.deaktiviert) {
        const voll = await v.kontingentPruefen(trx, ziel);
        if (voll) return { status: 409, body: kontingentFehler(voll) } as const;
        await kontoEntsperren(trx, ziel, akteur);
      }
      if (e.data.rollen !== undefined) {
        if (!e.data.rollen.includes('mandanten_admin') && (await istLetzterAdmin(trx, ziel)))
          return { status: 409, body: LETZTER_ADMIN } as const;
        const projektIds =
          e.data.projekt_ids !== undefined
            ? e.data.projekt_ids
            : (konto.rollen.find((r) => r.rolle === 'projektleiter')?.projekt_ids ?? []);
        await rollenSetzen(trx, {
          benutzerId: ziel,
          soll: sollAus(e.data.rollen, projektIds),
          quelle: 'manuell',
          akteur,
        });
      } else if (e.data.projekt_ids !== undefined) {
        const soll = new Map(konto.rollen.map((r) => [r.rolle, r.projekt_ids] as const));
        if (soll.has('projektleiter')) soll.set('projektleiter', e.data.projekt_ids ?? []);
        await rollenSetzen(trx, { benutzerId: ziel, soll, quelle: 'manuell', akteur });
      }
      const [neu] = await kontenListe(trx, await v.plattformAdmins(), ziel);
      return { status: 200, body: neu ?? { ...konto, rollen: [] } } as const;
    });
    return reply.code(ergebnis.status).send(ergebnis.body);
  });

  app.delete(`${basis}/:benutzerId/rollen`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const p = benutzerParam.safeParse(request.params);
    if (!p.success) return ungueltig(reply, p.error);
    const akteur = request.benutzer!.benutzerId;
    const ziel = p.data.benutzerId;
    const status = await withMandant(db, m.id, async (trx) => {
      const [konto] = await kontenListe(trx, await v.plattformAdmins(), ziel);
      if (!konto) return 404;
      if (konto.plattform_admin && m.zugriff !== 'plattform') return 403;
      if (await istLetzterAdmin(trx, ziel)) return 409;
      await rollenSetzen(trx, { benutzerId: ziel, soll: new Map(), quelle: 'manuell', akteur });
      await trx.deleteFrom('konto_einladung').where('benutzer_id', '=', ziel).execute();
      return 204;
    });
    if (status === 409) return reply.code(409).send(LETZTER_ADMIN);
    if (status === 404) return reply.code(404).send({ fehler: 'Konto nicht gefunden' });
    if (status === 403)
      return reply.code(403).send({ fehler: 'Plattform-Admins verwaltet nur die Plattform' });
    return reply.code(204).send();
  });
}
