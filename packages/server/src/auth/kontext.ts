// Anmeldung je Anfrage (Architektur §6): Sitzungs-Cookie (Provider `lokal`), optional der
// Header-Modus hinter einem vertrauenswürdigen Proxy, danach Auth-Provider aus Plugins (ee: OIDC).
// Exportiert die preHandler `requireAnmeldung`, `requireBenutzer` und `requireRolle` für alle Module.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fehlerKoerper, rolleSchema, type AuthMe, type Rolle } from '@seatmeter/shared';
import { sql, type Transaction } from 'kysely';
import { protokolliere, AUDIT_AKTION } from '../audit/protokoll.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { sha256, zufallsToken } from '../krypto.js';
import type { Datenbank, SitzungQuelle } from '../db/schema.js';
import type { AuthErweiterung, AuthProvider, MandantRolle, PluginKontext } from '../plugin.js';

export type { MandantRolle } from '../plugin.js';

export const SITZUNG_COOKIE = 'seatmeter_sitzung';
export const CSRF_COOKIE = 'seatmeter_csrf';
export const CSRF_HEADER = 'x-seatmeter-csrf';

export interface Anmeldung {
  benutzerId: string;
  benutzername: string;
  /** Aktiver Mandant; `null`, wenn der Benutzer keine Rolle hat. */
  mandantId: string | null;
  /** Rollen im aktiven Mandanten. */
  rollen: Rolle[];
  /** Sichtbare Projekte; `null` = alle (Projektleiter sehen nur ihre zugewiesenen Projekte). */
  projektIds: string[] | null;
  sitzungId: string | null;
  /** Erwarteter Wert im Header `X-Seatmeter-CSRF`; `null` bei Plugin-Providern ohne Cookie. */
  csrf: string | null;
  quelle: string;
}

export type AnmeldungMitMandant = Anmeldung & { mandantId: string };

export interface AuthZustand {
  ctx: PluginKontext;
  /** Einrichtungs-Token, solange kein Benutzer existiert. */
  setupToken: string | null;
  /** Auth-Provider aus Plugins (ee), erst nach der Plugin-Registrierung bekannt. */
  pluginProvider: () => readonly AuthProvider[];
  /** Auth-Erweiterungen aus Plugins (ee: Plattform-Admin, Lizenzstatus), ebenfalls nachgereicht. */
  erweiterungen: () => readonly AuthErweiterung[];
}

declare module 'fastify' {
  interface FastifyInstance {
    seatmeterAuth: AuthZustand;
  }
  interface FastifyRequest {
    benutzer: Anmeldung | null;
  }
}

/** Rollen eines Benutzers über alle Mandanten (SECURITY-DEFINER-Funktion, RLS-frei). */
export async function rollenDesBenutzers(db: Db, benutzerId: string): Promise<MandantRolle[]> {
  const r = await sql<MandantRolle>`SELECT * FROM benutzer_mandanten(${benutzerId}::uuid)`.execute(
    db,
  );
  return r.rows.filter((z) => rolleSchema.safeParse(z.rolle).success);
}

/**
 * Rollen aus `rolle` plus die zusätzlichen Rollen der Plugins (ee: Plattform-Admin). Grundlage für
 * Mandantenwahl, Sitzung und `/me`; doppelte Paare (Mandant, Rolle) erscheinen nur einmal.
 */
export async function alleRollen(
  zustand: AuthZustand,
  benutzerId: string,
): Promise<MandantRolle[]> {
  const alle = await rollenDesBenutzers(zustand.ctx.db, benutzerId);
  for (const e of zustand.erweiterungen()) {
    if (!e.zusatzRollen) continue;
    for (const r of await e.zusatzRollen(benutzerId, zustand.ctx)) {
      if (!alle.some((x) => x.mandant_id === r.mandant_id && x.rolle === r.rolle)) alle.push(r);
    }
  }
  return alle;
}

function rollenIn(alle: MandantRolle[], mandantId: string | null) {
  const eigene = alle.filter((r) => r.mandant_id === mandantId);
  const rollen = [...new Set(eigene.map((r) => r.rolle))];
  // Projektleiter ohne weitere Rolle sehen nur ihre Projekte; jede andere Rolle sieht alle.
  const nurProjektleiter = rollen.length > 0 && rollen.every((r) => r === 'projektleiter');
  const projektIds = nurProjektleiter
    ? [...new Set(eigene.flatMap((r) => r.projekt_ids ?? []))]
    : null;
  return { rollen, projektIds };
}

function cookieOptionen(zustand: AuthZustand, httpOnly: boolean) {
  const url = zustand.ctx.konfiguration.SEATMETER_PUBLIC_URL;
  return {
    path: '/',
    httpOnly,
    sameSite: 'lax' as const,
    secure: url?.startsWith('https://') ?? false,
    maxAge: zustand.ctx.konfiguration.SEATMETER_SITZUNG_STUNDEN * 3600,
  };
}

/** Aktiver Mandant einer neuen Sitzung: Wunsch, falls der Benutzer dort eine Rolle hat, sonst der erste. */
function sitzungsMandant(alle: MandantRolle[], wunsch?: string | null): string | null {
  return (
    (wunsch && alle.some((r) => r.mandant_id === wunsch) ? wunsch : null) ??
    alle[0]?.mandant_id ??
    null
  );
}

const QUELLE_TEXT: Record<SitzungQuelle, string> = {
  lokal: 'lokal',
  remote_user: 'Proxy-Header',
  oidc: 'OIDC',
};

/** Neue Zeile in `benutzer_sitzung` (Token nur als SHA-256); liefert Klartext-Token und CSRF-Wert. */
async function sitzungEinfuegen(
  executor: Db | Transaction<Datenbank>,
  stunden: number,
  benutzerId: string,
  mandantId: string | null,
  quelle: SitzungQuelle,
): Promise<{ id: string; token: string; csrf: string }> {
  const token = zufallsToken();
  const csrf = zufallsToken(24);
  const zeile = await executor
    .insertInto('benutzer_sitzung')
    .values({
      token_sha256: sha256(token),
      benutzer_id: benutzerId,
      mandant_id: mandantId,
      csrf,
      quelle,
      laeuft_ab: new Date(Date.now() + stunden * 3600_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: zeile.id, token, csrf };
}

/** Audit „Anmeldung“ im Mandanten der neuen Sitzung (ohne Mandant kein Eintrag). */
async function anmeldungProtokollieren(
  db: Db,
  benutzerId: string,
  mandantId: string | null,
  quelle: SitzungQuelle,
): Promise<void> {
  await db
    .updateTable('benutzer')
    .set({ zuletzt_angemeldet: new Date() })
    .where('id', '=', benutzerId)
    .execute();
  if (!mandantId) return;
  await withMandant(db, mandantId, (trx) =>
    protokolliere(trx, { benutzerId, aktion: AUDIT_AKTION.anmeldung, objekt: QUELLE_TEXT[quelle] }),
  );
}

/** Legt eine Sitzung an und setzt Sitzungs- und CSRF-Cookie. */
export async function erstelleSitzung(
  zustand: AuthZustand,
  reply: FastifyReply,
  benutzer: { id: string; benutzername: string },
  quelle: SitzungQuelle,
  mandantWunsch?: string | null,
): Promise<Anmeldung> {
  const { db, konfiguration } = zustand.ctx;
  const alle = await alleRollen(zustand, benutzer.id);
  const mandantId = sitzungsMandant(alle, mandantWunsch);
  const s = await sitzungEinfuegen(
    db,
    konfiguration.SEATMETER_SITZUNG_STUNDEN,
    benutzer.id,
    mandantId,
    quelle,
  );
  reply.setCookie(SITZUNG_COOKIE, s.token, cookieOptionen(zustand, true));
  reply.setCookie(CSRF_COOKIE, s.csrf, cookieOptionen(zustand, false));
  await anmeldungProtokollieren(db, benutzer.id, mandantId, quelle);
  return {
    benutzerId: benutzer.id,
    benutzername: benutzer.benutzername,
    mandantId,
    ...rollenIn(alle, mandantId),
    sitzungId: s.id,
    csrf: s.csrf,
    quelle,
  };
}

/**
 * Header-Modus: Eine noch gültige Sitzung desselben Benutzers mit Anmeldeart `remote_user` wird
 * wiederverwendet, statt je cookieloser Anfrage (curl, Monitoring, Browser ohne Cookie) eine neue
 * Sitzung samt Audit-Eintrag „Anmeldung“ anzulegen. Wiederverwendet wird nur eine Sitzung, deren
 * Mandant der Benutzer noch hat. Weil nur der SHA-256 des Sitzungs-Tokens gespeichert ist, setzt die
 * Wiederverwendung nur das CSRF-Cookie neu; das Sitzungs-Cookie gibt es nur mit einer neuen Sitzung.
 * Ein Advisory-Lock je Benutzer sorgt dafür, dass gleichzeitige Anfragen nur eine Sitzung anlegen.
 */
async function headerSitzung(
  zustand: AuthZustand,
  reply: FastifyReply,
  benutzer: { id: string; benutzername: string },
): Promise<Anmeldung> {
  const { db, konfiguration } = zustand.ctx;
  const alle = await alleRollen(zustand, benutzer.id);
  const mandanten = [...new Set(alle.map((r) => r.mandant_id))];
  const ergebnis = await db.transaction().execute(async (trx) => {
    const schluessel = `seatmeter:header-sitzung:${benutzer.id}`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${schluessel}))`.execute(trx);
    const offen = await trx
      .selectFrom('benutzer_sitzung')
      .select(['id', 'mandant_id', 'csrf'])
      .where('benutzer_id', '=', benutzer.id)
      .where('quelle', '=', 'remote_user')
      .where('laeuft_ab', '>', new Date())
      .where((eb) =>
        mandanten.length > 0 ? eb('mandant_id', 'in', mandanten) : eb('mandant_id', 'is', null),
      )
      .orderBy('erstellt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (offen)
      return { neu: false as const, id: offen.id, csrf: offen.csrf, mandantId: offen.mandant_id };
    const mandantId = sitzungsMandant(alle);
    const s = await sitzungEinfuegen(
      trx,
      konfiguration.SEATMETER_SITZUNG_STUNDEN,
      benutzer.id,
      mandantId,
      'remote_user',
    );
    return { neu: true as const, ...s, mandantId };
  });
  if (ergebnis.neu) {
    reply.setCookie(SITZUNG_COOKIE, ergebnis.token, cookieOptionen(zustand, true));
    await anmeldungProtokollieren(db, benutzer.id, ergebnis.mandantId, 'remote_user');
  }
  reply.setCookie(CSRF_COOKIE, ergebnis.csrf, cookieOptionen(zustand, false));
  return {
    benutzerId: benutzer.id,
    benutzername: benutzer.benutzername,
    mandantId: ergebnis.mandantId,
    ...rollenIn(alle, ergebnis.mandantId),
    sitzungId: ergebnis.id,
    csrf: ergebnis.csrf,
    quelle: 'remote_user',
  };
}

export function loescheCookies(reply: FastifyReply): void {
  reply.clearCookie(SITZUNG_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

async function ausSitzung(zustand: AuthZustand, token: string): Promise<Anmeldung | null> {
  const { db } = zustand.ctx;
  const s = await db
    .selectFrom('benutzer_sitzung as s')
    .innerJoin('benutzer as b', 'b.id', 's.benutzer_id')
    .select(['s.id', 's.benutzer_id', 's.mandant_id', 's.csrf', 's.quelle', 'b.benutzername'])
    .where('s.token_sha256', '=', sha256(token))
    .where('s.laeuft_ab', '>', new Date())
    .where('b.deaktiviert', 'is', null)
    .executeTakeFirst();
  if (!s) return null;
  const alle = await alleRollen(zustand, s.benutzer_id);
  // Rolle im gespeicherten Mandanten entzogen: kein aktiver Mandant mehr.
  const mandantId = alle.some((r) => r.mandant_id === s.mandant_id) ? s.mandant_id : null;
  return {
    benutzerId: s.benutzer_id,
    benutzername: s.benutzername,
    mandantId,
    ...rollenIn(alle, mandantId),
    sitzungId: s.id,
    csrf: s.csrf,
    quelle: s.quelle,
  };
}

/** Mandant für neue Header-Benutzer: slug aus SEATMETER_AUTO_MANDANT, sonst der einzige Mandant. */
async function autoMandant(zustand: AuthZustand): Promise<string | null> {
  const { db, konfiguration } = zustand.ctx;
  // Läuft als Eigentümer (ohne withMandant): mandantenfreie Suche vor der Anmeldung.
  if (konfiguration.SEATMETER_AUTO_MANDANT) {
    const m = await db
      .selectFrom('mandant')
      .select('id')
      .where('slug', '=', konfiguration.SEATMETER_AUTO_MANDANT)
      .executeTakeFirst();
    return m?.id ?? null;
  }
  const alle = await db.selectFrom('mandant').select('id').limit(2).execute();
  return alle.length === 1 ? (alle[0]?.id ?? null) : null;
}

/** Header-Modus: Benutzer mit gleichem Benutzernamen anmelden, beim ersten Mal anlegen. */
async function ausHeader(
  zustand: AuthZustand,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Anmeldung | null> {
  const name = zustand.ctx.konfiguration.SEATMETER_TRUST_REMOTE_USER_HEADER;
  if (!name) return null;
  const roh = request.headers[name];
  const wert = (Array.isArray(roh) ? roh[0] : roh)?.trim();
  if (!wert || wert.length > 200) return null;
  const { db, konfiguration } = zustand.ctx;

  let benutzer = await db
    .selectFrom('benutzer')
    .select(['id', 'benutzername', 'deaktiviert'])
    .where('benutzername', '=', wert)
    .executeTakeFirst();
  if (benutzer?.deaktiviert) return null;
  if (!benutzer) {
    const mandantId = await autoMandant(zustand);
    if (!mandantId) {
      request.log.warn('Header-Anmeldung: kein Mandant für neue Benutzer (SEATMETER_AUTO_MANDANT)');
      return null;
    }
    // Kontenkontingent (ee): passt noch ein neues Konto mit Rolle in den Mandanten?
    const voll = await withMandant(db, mandantId, async (trx) => {
      for (const e of zustand.erweiterungen()) {
        const stand = await e.kontingentPruefen?.(trx, null);
        if (stand) return stand;
      }
      return null;
    });
    if (voll) {
      request.log.warn('Header-Anmeldung: Kontenkontingent des Mandanten ausgeschöpft');
      return null;
    }
    const neu = await db.transaction().execute(async (trx) => {
      const angelegt = await trx
        .insertInto('benutzer')
        .values({ benutzername: wert, login: 'lokal' })
        .onConflict((oc) => oc.column('benutzername').doNothing())
        .returning(['id', 'benutzername'])
        .executeTakeFirst();
      if (!angelegt) return null;
      await trx
        .insertInto('rolle')
        .values({
          mandant_id: mandantId,
          benutzer_id: angelegt.id,
          rolle: konfiguration.SEATMETER_AUTO_ROLLE,
        })
        .execute();
      return angelegt;
    });
    if (neu) {
      await withMandant(db, mandantId, (trx) =>
        protokolliere(trx, {
          benutzerId: neu.id,
          aktion: AUDIT_AKTION.benutzerAngelegt,
          objekt: `Proxy-Header, Rolle ${konfiguration.SEATMETER_AUTO_ROLLE}`,
        }),
      );
    }
    benutzer = await db
      .selectFrom('benutzer')
      .select(['id', 'benutzername', 'deaktiviert'])
      .where('benutzername', '=', wert)
      .executeTakeFirst();
    if (!benutzer || benutzer.deaktiviert) return null;
  }
  return headerSitzung(zustand, reply, benutzer);
}

/** Ermittelt die Anmeldung der Anfrage (Cookie, Header-Modus, Plugin-Provider) und merkt sie sich. */
export async function ermittleAnmeldung(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Anmeldung | null> {
  if (request.benutzer) return request.benutzer;
  const zustand = request.server.seatmeterAuth;
  const headerName = zustand.ctx.konfiguration.SEATMETER_TRUST_REMOTE_USER_HEADER;
  const token = request.cookies[SITZUNG_COOKIE];
  let anmeldung = token ? await ausSitzung(zustand, token) : null;
  if (anmeldung && headerName) {
    // Hinter dem Proxy gilt der Header: anderer Benutzer am Proxy = neue Sitzung.
    const roh = request.headers[headerName];
    const wert = (Array.isArray(roh) ? roh[0] : roh)?.trim();
    if (wert && wert !== anmeldung.benutzername) anmeldung = null;
  }
  anmeldung ??= await ausHeader(zustand, request, reply);
  if (!anmeldung) {
    for (const provider of zustand.pluginProvider()) {
      const k = await provider.authentifizieren(request, zustand.ctx);
      if (!k) continue;
      const alle = await alleRollen(zustand, k.benutzerId);
      const b = await zustand.ctx.db
        .selectFrom('benutzer')
        .select('benutzername')
        .where('id', '=', k.benutzerId)
        .executeTakeFirst();
      anmeldung = {
        benutzerId: k.benutzerId,
        benutzername: b?.benutzername ?? k.benutzerId,
        mandantId: k.mandantId || null,
        ...rollenIn(alle, k.mandantId || null),
        sitzungId: null,
        csrf: null,
        quelle: provider.name,
      };
      break;
    }
  }
  request.benutzer = anmeldung;
  return anmeldung;
}

const SICHERE_METHODEN = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Double-Submit: zustandsändernde Anfragen brauchen `X-Seatmeter-CSRF` = Token der Sitzung. */
function csrfOk(request: FastifyRequest, a: Anmeldung): boolean {
  if (SICHERE_METHODEN.has(request.method) || a.csrf === null) return true;
  const header = request.headers[CSRF_HEADER];
  return typeof header === 'string' && header.length > 0 && header === a.csrf;
}

/** preHandler: angemeldet (Mandant optional), CSRF geprüft. */
export async function requireAnmeldung(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const a = await ermittleAnmeldung(request, reply);
  if (!a) return reply.code(401).send(fehlerKoerper('nicht_angemeldet', 'nicht angemeldet'));
  if (!csrfOk(request, a)) {
    return reply.code(403).send(fehlerKoerper('csrf', 'CSRF-Token fehlt oder passt nicht'));
  }
  return undefined;
}

/** preHandler: angemeldet mit aktivem Mandanten. */
export async function requireBenutzer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  await requireAnmeldung(request, reply);
  if (reply.sent) return reply;
  if (!request.benutzer?.mandantId) {
    return reply.code(403).send(fehlerKoerper('kein_mandant', 'kein Mandant gewählt'));
  }
  return undefined;
}

/** preHandler-Fabrik: angemeldet mit aktivem Mandanten und mindestens einer der Rollen. */
export function requireRolle(...rollen: Rolle[]) {
  return async function rolleNoetig(request: FastifyRequest, reply: FastifyReply) {
    await requireBenutzer(request, reply);
    if (reply.sent) return reply;
    if (!request.benutzer?.rollen.some((r) => rollen.includes(r))) {
      return reply.code(403).send(fehlerKoerper('rolle_fehlt', 'Rolle fehlt'));
    }
    return undefined;
  };
}

/** Anmeldung nach `requireBenutzer`/`requireRolle` (wirft, wenn der preHandler fehlt). */
export function benutzerVon(request: FastifyRequest): AnmeldungMitMandant {
  const a = request.benutzer;
  if (!a?.mandantId) throw new Error('requireBenutzer fehlt an dieser Route');
  return a as AnmeldungMitMandant;
}

/** Antwort für `/api/v1/auth/me` (mit Zusatzfeldern der Plugins, z. B. `ee`). */
export async function meAntwort(zustand: AuthZustand, a: Anmeldung): Promise<AuthMe> {
  const alle = await alleRollen(zustand, a.benutzerId);
  const mandanten = new Map<string, AuthMe['mandanten'][number]>();
  for (const r of alle) {
    const m = mandanten.get(r.mandant_id) ?? {
      id: r.mandant_id,
      name: r.name,
      slug: r.slug,
      rollen: [],
    };
    if (!m.rollen.includes(r.rolle)) m.rollen.push(r.rolle);
    mandanten.set(r.mandant_id, m);
  }
  const aktiv = a.mandantId ? mandanten.get(a.mandantId) : undefined;
  const zusatz: Record<string, unknown> = {};
  for (const e of zustand.erweiterungen()) {
    if (e.me) Object.assign(zusatz, await e.me(a, zustand.ctx));
  }
  return {
    ...zusatz,
    benutzer: { id: a.benutzerId, benutzername: a.benutzername, login: a.benutzername },
    mandant_id: a.mandantId,
    mandant: aktiv ? { id: aktiv.id, name: aktiv.name, slug: aktiv.slug } : null,
    provider: a.quelle,
    rollen: a.rollen,
    mandanten: [...mandanten.values()],
    csrf: a.csrf,
  };
}

/** Auth-Provider `lokal` (Sitzungs-Cookie) laut Schnittstelle `AuthProvider`. */
export const lokalerAuthProvider: AuthProvider = {
  name: 'lokal',
  async authentifizieren(request) {
    const token = request.cookies[SITZUNG_COOKIE];
    if (!token) return null;
    const a = await ausSitzung(request.server.seatmeterAuth, token);
    return a?.mandantId
      ? { benutzerId: a.benutzerId, mandantId: a.mandantId, rollen: a.rollen }
      : null;
  },
};
