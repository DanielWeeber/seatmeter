// Mandantenverwaltung im Kern (seit 2026-10-24, vorher ee): Zugriff auf den verwalteten Mandanten unter
// `/api/v1/mandant/…` (aktiver Mandant der Sitzung oder `?mandant=<id>`), Kontenkontingent und Plattform-Admins
// über die Auth-Erweiterungen der Plugins (ee: Mandantenfähigkeit), gemeinsame Audit-Aktionen und Antworten.
// Ohne Plugin gibt es kein Kontingent und keine Plattform-Admins; verwalten darf nur der Mandanten-Admin.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { rollenDesBenutzers, type AuthZustand } from '../auth/kontext.js';
import type { Datenbank } from '../db/schema.js';
import type { KontingentStand } from '../plugin.js';

export type { KontingentStand } from '../plugin.js';

type Trx = Transaction<Datenbank>;

/** Aktionsnamen im `audit` des Mandanten (Konten, Rollen, Tokens, SSO, SCIM). */
export const VERWALTUNG_AUDIT = {
  tokenErzeugt: 'Ingest-Token erzeugt',
  tokenWiderrufen: 'Ingest-Token widerrufen',
  orgHinzugefuegt: 'Org hinzugefügt',
  orgEntfernt: 'Org entfernt',
  rolleZugewiesen: 'Rolle zugewiesen',
  rolleEntzogen: 'Rolle entzogen',
  oidcGeaendert: 'OIDC-Konfiguration geändert',
  oidcEntfernt: 'OIDC-Konfiguration entfernt',
  oidcGeprueft: 'OIDC-Konfiguration geprüft',
  domainHinzugefuegt: 'Domain hinzugefügt',
  domainEntfernt: 'Domain entfernt',
  domainVerifiziert: 'Domain verifiziert',
  kontoEingeladen: 'Konto eingeladen',
  einladungAngenommen: 'Einladung angenommen',
  kontoAngelegt: 'Konto angelegt',
  kontoDeaktiviert: 'Konto deaktiviert',
  kontoAktiviert: 'Konto aktiviert',
  scimTokenErzeugt: 'SCIM-Token erzeugt',
  scimTokenWiderrufen: 'SCIM-Token widerrufen',
  scimGruppe: 'SCIM-Gruppe',
} as const;

/** 400 mit den zod-Meldungen (deutsch). */
export function ungueltig(reply: FastifyReply, fehler: z.ZodError) {
  return reply.code(400).send({ fehler: 'ungültige Eingabe', details: fehler.issues });
}

/** Fehlerantwort 409/403 `konten_kontingent` mit verständlichem Text. */
export function kontingentFehler(stand: KontingentStand) {
  return {
    code: 'konten_kontingent' as const,
    fehler: `Das Kontenkontingent des Mandanten ist ausgeschöpft (${stand.belegt} von ${stand.max ?? '∞'} Konten).`,
    kontingent: stand,
  };
}

/** Kontenkontingent, Plattform-Admins und Verwaltungsrecht aus den Auth-Erweiterungen (ee). */
export interface Verwaltung {
  /** `null` = passt (immer ohne Erweiterung), sonst der volle Stand. */
  kontingentPruefen(trx: Trx, benutzerId: string | null): Promise<KontingentStand | null>;
  kontingentStand(trx: Trx): Promise<KontingentStand>;
  plattformAdmins(): Promise<Set<string>>;
  istPlattformAdmin(benutzerId: string): Promise<boolean>;
  mandantVerwalten(benutzerId: string, mandantId: string): Promise<boolean>;
  plattformAdminAbgleichen(benutzerId: string, soll: boolean): Promise<void>;
}

/** Konten mit mindestens einer Rolle im Mandanten der Transaktion (aktiv), ohne die angegebenen. */
async function belegtePlaetze(trx: Trx): Promise<number> {
  const z = await sql<{ n: number }>`
    SELECT count(DISTINCT r.benutzer_id)::int AS n
    FROM rolle r JOIN benutzer b ON b.id = r.benutzer_id
    WHERE b.deaktiviert IS NULL`.execute(trx);
  return Number(z.rows[0]?.n ?? 0);
}

export function verwaltung(zustand: AuthZustand): Verwaltung {
  const alle = () => zustand.erweiterungen();
  const v: Verwaltung = {
    async kontingentPruefen(trx, benutzerId) {
      for (const e of alle()) {
        const voll = await e.kontingentPruefen?.(trx, benutzerId);
        if (voll) return voll;
      }
      return null;
    },
    async kontingentStand(trx) {
      for (const e of alle()) if (e.kontingentStand) return e.kontingentStand(trx);
      return { belegt: await belegtePlaetze(trx), max: null };
    },
    async plattformAdmins() {
      const ids = new Set<string>();
      for (const e of alle())
        for (const id of (await e.plattformAdmins?.(zustand.ctx)) ?? []) ids.add(id);
      return ids;
    },
    async istPlattformAdmin(benutzerId) {
      return (await v.plattformAdmins()).has(benutzerId);
    },
    async mandantVerwalten(benutzerId, mandantId) {
      for (const e of alle())
        if (await e.mandantVerwalten?.(benutzerId, mandantId, zustand.ctx)) return true;
      return false;
    },
    async plattformAdminAbgleichen(benutzerId, soll) {
      for (const e of alle()) await e.plattformAdminAbgleichen?.(benutzerId, soll, zustand.ctx);
    },
  };
  return v;
}

/** `plattform`: Zugriff über eine Erweiterung (ee: Plattform-Admin); `admin`: Mandanten-Admin des Mandanten. */
export type MandantZugriff = 'plattform' | 'admin';

const zielSchema = z.object({ mandant: z.uuid().optional() });

/**
 * Verwalteter Mandant einer Anfrage unter `/api/v1/mandant/…` (nach `requireAnmeldung`): `?mandant=<id>` oder
 * der aktive Mandant der Sitzung. Erlaubt für Mandanten-Admins dieses Mandanten (echte Rolle, nicht die
 * Sicht eines Plattform-Admins) und über `AuthErweiterung.mandantVerwalten` (ee). Antwortet selbst mit
 * 400/403/404 und liefert dann `null`.
 */
export async function verwalteterMandant(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; zugriff: MandantZugriff } | null> {
  const zustand = request.server.seatmeterAuth;
  const b = request.benutzer;
  const q = zielSchema.safeParse(request.query ?? {});
  if (!q.success) {
    await reply.code(400).send({ fehler: 'ungültige Mandanten-ID' });
    return null;
  }
  const id = q.data.mandant ?? b?.mandantId ?? null;
  if (!b || !id) {
    await reply.code(403).send({ fehler: 'kein Mandant gewählt', code: 'kein_mandant' });
    return null;
  }
  let zugriff: MandantZugriff | null = null;
  if (await verwaltung(zustand).mandantVerwalten(b.benutzerId, id)) zugriff = 'plattform';
  else if (
    (await rollenDesBenutzers(zustand.ctx.db, b.benutzerId)).some(
      (r) => r.mandant_id === id && r.rolle === 'mandanten_admin',
    )
  )
    zugriff = 'admin';
  if (!zugriff) {
    await reply
      .code(403)
      .send({ fehler: 'kein Zugriff auf diesen Mandanten', code: 'rolle_fehlt' });
    return null;
  }
  const m = await zustand.ctx.db
    .selectFrom('mandant')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!m) {
    await reply.code(404).send({ fehler: 'Mandant nicht gefunden' });
    return null;
  }
  return { id, zugriff };
}
