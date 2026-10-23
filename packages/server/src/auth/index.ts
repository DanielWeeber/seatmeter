// Modul auth (Free-Edition: lokale Anmeldung, Architektur §6). Routen unter /api/v1/auth/*.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { TokenEimer } from '../ingest-gemeinsam/ratenlimit.js';
import {
  anmeldeAliasse,
  anmeldungSchema,
  einrichtungSchema,
  mandantWahlSchema,
  type Einrichtung,
} from '@seatmeter/shared';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { verschluessele, zufallsToken } from '../krypto.js';
import type { AuthAnbieter } from '@seatmeter/shared';
import type { AuthErweiterung, AuthProvider, PluginKontext, SeatmeterPlugin } from '../plugin.js';
import {
  alleRollen,
  erstelleSitzung,
  ermittleAnmeldung,
  loescheCookies,
  meAntwort,
  benutzerVon,
  requireAnmeldung,
  requireBenutzer,
  type AuthZustand,
} from './kontext.js';
import { Ratenbegrenzer } from './ratenbegrenzer.js';

export * from './kontext.js';
export { Ratenbegrenzer } from './ratenbegrenzer.js';

const ARGON2_OPTIONEN = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** argon2id-Hash eines Passworts mit den Parametern der lokalen Anmeldung (ee: Einladung annehmen). */
export function passwortHash(passwort: string): Promise<string> {
  return argon2.hash(passwort, ARGON2_OPTIONEN);
}

/**
 * Grundlage an der Wurzel-Instanz (vor allen Modulen): Cookie-Parser, `request.benutzer`,
 * Auth-Zustand. Plugin-Provider (ee) werden später über `pluginProvider` nachgereicht.
 */
export async function authGrundlage(
  app: FastifyInstance,
  ctx: PluginKontext,
  pluginProvider: () => readonly AuthProvider[],
  erweiterungen: () => readonly AuthErweiterung[] = () => [],
): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('benutzer', null);
  const zustand: AuthZustand = { ctx, setupToken: null, pluginProvider, erweiterungen };
  app.decorate('seatmeterAuth', zustand);
}

/** Erzeugt das Einrichtungs-Token, solange kein Benutzer existiert, und schreibt es einmal ins Log. */
async function einrichtungVorbereiten(app: FastifyInstance, zustand: AuthZustand): Promise<void> {
  try {
    const { n } = await zustand.ctx.db
      .selectFrom('benutzer')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    if (Number(n) > 0) return;
    const vorgabe = zustand.ctx.konfiguration.SEATMETER_SETUP_TOKEN;
    zustand.setupToken = vorgabe ?? zufallsToken(24);
    if (vorgabe) {
      app.log.warn(
        'Noch kein Benutzer: Einrichtung mit SEATMETER_SETUP_TOKEN über POST /api/v1/auth/setup',
      );
    } else {
      app.log.warn(
        { einrichtungs_token: zustand.setupToken },
        'Noch kein Benutzer: Einrichtungs-Token für POST /api/v1/auth/setup (wird nur jetzt angezeigt)',
      );
    }
  } catch (fehler) {
    app.log.error({ fehler: String(fehler) }, 'Einrichtungsprüfung fehlgeschlagen (DB?)');
  }
}

function gleich(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Legt Mandant und verschlüsselte Salts an (Free-Edition: genau ein Mandant). */
async function legeMandantAn(
  db: Db,
  masterKey: Buffer,
  angabe: NonNullable<Einrichtung['mandant']>,
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const m = await trx
      .insertInto('mandant')
      .values({ name: angabe.name, slug: angabe.slug })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('mandant_geheimnis')
      .values({
        mandant_id: m.id,
        person_salt: verschluessele(masterKey, randomBytes(32), 'mandant_geheimnis.person_salt'),
        projekt_salt: verschluessele(masterKey, randomBytes(32), 'mandant_geheimnis.projekt_salt'),
      })
      .execute();
    return m.id;
  });
}

/** Anmeldeseite: Abfragen „E-Mail → Anmeldedienst“ je Adresse (Stoß 20, danach 30 je Minute). */
const ANBIETER_GRENZE = { proMinute: 30, stoss: 20 } as const;

/** `?email=` (wird klein geschrieben) oder `?mandant=` (Kürzel); ohne beides die einfache Liste. */
const anbieterAbfrageSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+$/)
      .optional(),
    mandant: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
      .optional(),
  })
  .refine((q) => q.email === undefined || q.mandant === undefined);

function ip(request: FastifyRequest): string {
  return request.ip || 'unbekannt';
}

/** Hash zum Ausgleich der Laufzeit bei unbekannten Benutzernamen. */
let blindHash: Promise<string> | null = null;

export const authPlugin: SeatmeterPlugin = {
  name: 'kern-auth',
  async routen(app) {
    const zustand = app.seatmeterAuth;
    const { db, konfiguration } = zustand.ctx;
    await einrichtungVorbereiten(app, zustand);
    // Fehlversuche: je Benutzername 5, je Adresse 30 in 15 Minuten.
    const jeName = new Ratenbegrenzer(5, 15 * 60_000);
    const jeAdresse = new Ratenbegrenzer(30, 15 * 60_000);

    app.post('/api/v1/auth/setup', async (request, reply) => {
      if (jeAdresse.gesperrt(ip(request))) {
        return reply.code(429).header('retry-after', '900').send({ fehler: 'zu viele Versuche' });
      }
      const eingabe = einrichtungSchema.safeParse(anmeldeAliasse(request.body));
      if (!eingabe.success) return reply.code(400).send({ fehler: 'ungültige Eingabe' });
      if (!zustand.setupToken) {
        return reply.code(409).send({ fehler: 'Einrichtung bereits abgeschlossen' });
      }
      if (!gleich(eingabe.data.setup_token, zustand.setupToken)) {
        jeAdresse.fehlschlag(ip(request));
        return reply.code(403).send({ fehler: 'Einrichtungs-Token falsch' });
      }
      const hash = await argon2.hash(eingabe.data.passwort, ARGON2_OPTIONEN);
      const ergebnis = await db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('seatmeter:einrichtung'))`.execute(trx);
        const { n } = await trx
          .selectFrom('benutzer')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow();
        if (Number(n) > 0) return null;
        const b = await trx
          .insertInto('benutzer')
          .values({ benutzername: eingabe.data.benutzername, login: 'lokal', passwort_hash: hash })
          .returning(['id', 'benutzername'])
          .executeTakeFirstOrThrow();
        return b;
      });
      if (!ergebnis) {
        zustand.setupToken = null;
        return reply.code(409).send({ fehler: 'Einrichtung bereits abgeschlossen' });
      }
      // Mandant: vorhandenen nehmen (Free = einer), sonst aus der Eingabe anlegen.
      const vorhanden = await db
        .selectFrom('mandant')
        .select('id')
        .orderBy('erstellt')
        .executeTakeFirst();
      let mandantId = vorhanden?.id ?? null;
      if (!mandantId && eingabe.data.mandant) {
        mandantId = await legeMandantAn(
          db,
          konfiguration.SEATMETER_MASTER_KEY,
          eingabe.data.mandant,
        );
      }
      if (mandantId) {
        await db
          .insertInto('rolle')
          .values({ mandant_id: mandantId, benutzer_id: ergebnis.id, rolle: 'mandanten_admin' })
          .execute();
        await withMandant(db, mandantId, (trx) =>
          protokolliere(trx, {
            benutzerId: ergebnis.id,
            aktion: AUDIT_AKTION.einrichtung,
            objekt: 'Erstes Admin-Konto',
          }),
        );
      }
      zustand.setupToken = null;
      const a = await erstelleSitzung(zustand, reply, ergebnis, 'lokal', mandantId);
      return reply.code(201).send(await meAntwort(zustand, a));
    });

    app.post('/api/v1/auth/login', async (request, reply) => {
      const eingabe = anmeldungSchema.safeParse(anmeldeAliasse(request.body));
      if (!eingabe.success) return reply.code(400).send({ fehler: 'ungültige Eingabe' });
      const name = eingabe.data.benutzername.toLowerCase();
      if (jeName.gesperrt(name) || jeAdresse.gesperrt(ip(request))) {
        return reply.code(429).header('retry-after', '900').send({ fehler: 'zu viele Versuche' });
      }
      const b = await db
        .selectFrom('benutzer')
        .select(['id', 'benutzername', 'passwort_hash'])
        .where('benutzername', '=', eingabe.data.benutzername)
        .where('login', '=', 'lokal')
        .where('deaktiviert', 'is', null)
        .executeTakeFirst();
      blindHash ??= argon2.hash(zufallsToken(), ARGON2_OPTIONEN);
      const ok = await argon2
        .verify(b?.passwort_hash ?? (await blindHash), eingabe.data.passwort)
        .catch(() => false);
      if (!b?.passwort_hash || !ok) {
        jeName.fehlschlag(name);
        jeAdresse.fehlschlag(ip(request));
        return reply.code(401).send({ fehler: 'Anmeldung fehlgeschlagen' });
      }
      jeName.zuruecksetzen(name);
      const a = await erstelleSitzung(zustand, reply, b, 'lokal');
      return meAntwort(zustand, a);
    });

    app.post('/api/v1/auth/logout', { preHandler: requireAnmeldung }, async (request, reply) => {
      const a = request.benutzer;
      if (a?.sitzungId) {
        await db.deleteFrom('benutzer_sitzung').where('id', '=', a.sitzungId).execute();
      }
      loescheCookies(reply);
      return reply.code(204).send();
    });

    // Für die Anmeldeseite: Formular (lokal) und Knöpfe der Auth-Provider (Modul oidc). Mit `?email=`
    // bzw. `?mandant=` zusätzlich der Anmeldedienst des Mandanten (ee: verifizierte Domain → Mandant);
    // die Antwort hängt nie davon ab, ob ein Konto existiert. Abfragen je Adresse begrenzt.
    const abfragenJeAdresse = new TokenEimer();
    app.get('/api/v1/auth/anbieter', async (request, reply) => {
      const anbieter: AuthAnbieter['anbieter'] = [
        { name: 'lokal', titel: 'Anmelden', start: null },
      ];
      for (const p of zustand.pluginProvider()) {
        const link = p.anmeldeLink?.(zustand.ctx);
        if (link) anbieter.push({ name: p.name, titel: link.titel, start: link.start });
      }
      const q = anbieterAbfrageSchema.safeParse(request.query);
      if (!q.success) return reply.code(400).send({ fehler: 'ungültige Eingabe' });
      const { email, mandant } = q.data;
      if (email === undefined && mandant === undefined) return { anbieter } satisfies AuthAnbieter;
      const warten = abfragenJeAdresse.pruefen(ip(request), ANBIETER_GRENZE);
      if (warten > 0) {
        return reply
          .code(429)
          .header('retry-after', String(warten))
          .send({ fehler: 'zu viele Versuche' });
      }
      let oidc: AuthAnbieter['oidc'] = null;
      const abfrage = email !== undefined ? { email } : { mandant: mandant ?? '' };
      for (const p of zustand.pluginProvider()) {
        const ziel = await p.anmeldeZiel?.(abfrage, zustand.ctx);
        if (ziel) {
          oidc = { bezeichnung: ziel.bezeichnung, start_url: ziel.start };
          break;
        }
      }
      return { anbieter, oidc } satisfies AuthAnbieter;
    });

    // Für den Web-Client: Einrichtungsformular zeigen?
    app.get('/api/v1/auth/setup', async () => ({ noetig: zustand.setupToken !== null }));

    // Einstellungen des aktiven Mandanten (lesend; Ändern folgt mit dem Einstellungs-Modul).
    app.get('/api/v1/auth/mandant', { preHandler: requireBenutzer }, async (request) => {
      const a = benutzerVon(request);
      return withMandant(db, a.mandantId, (trx) =>
        trx
          .selectFrom('mandant')
          .select([
            'id',
            'name',
            'slug',
            'plan',
            'abrechnungsmodell',
            'auswertungsstufe',
            'klarnamen_aktiv',
            'zeitzone',
            'waehrung',
            'sitzkosten_verteilung',
            'code_anteil_sitz',
            'schatten_faktor',
            'cache_write_annahme',
            'aufbewahrung_anfrage_tage',
            'aufbewahrung_aggregat_monate',
            'aufbewahrung_abschluss_monate',
            'aufbewahrung_kontrollsumme_tage',
            'aufbewahrung_statistik_monate',
            'aufbewahrung_audit_monate',
          ])
          .executeTakeFirstOrThrow(),
      );
    });

    app.get('/api/v1/auth/me', async (request, reply) => {
      const a = await ermittleAnmeldung(request, reply);
      if (!a) return reply.code(401).send({ fehler: 'nicht angemeldet' });
      return meAntwort(zustand, a);
    });

    app.post('/api/v1/auth/mandant', { preHandler: requireAnmeldung }, async (request, reply) => {
      const a = request.benutzer;
      const eingabe = mandantWahlSchema.safeParse(request.body);
      if (!eingabe.success) return reply.code(400).send({ fehler: 'ungültige Eingabe' });
      if (!a?.sitzungId) return reply.code(400).send({ fehler: 'nur mit Sitzung möglich' });
      const alle = await alleRollen(zustand, a.benutzerId);
      if (!alle.some((r) => r.mandant_id === eingabe.data.mandant_id)) {
        return reply.code(403).send({ fehler: 'keine Rolle in diesem Mandanten' });
      }
      await db
        .updateTable('benutzer_sitzung')
        .set({ mandant_id: eingabe.data.mandant_id })
        .where('id', '=', a.sitzungId)
        .execute();
      await withMandant(db, eingabe.data.mandant_id, (trx) =>
        protokolliere(trx, { benutzerId: a.benutzerId, aktion: AUDIT_AKTION.mandantGewechselt }),
      );
      request.benutzer = null;
      const neu = await ermittleAnmeldung(request, reply);
      return neu ? meAntwort(zustand, neu) : reply.code(401).send({ fehler: 'nicht angemeldet' });
    });
  },
};
