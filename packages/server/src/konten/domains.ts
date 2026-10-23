// E-Mail-Domains je Mandant (SSO je Mandant): Die Anmeldeseite fragt die E-Mail-Adresse, eine verifizierte
// Domain führt zum Anmeldedienst des Mandanten. Verifiziert wird per DNS-TXT `_seatmeter.<domain>` mit
// `seatmeter-verifizierung=<token>` oder direkt durch den Plattform-Admin. Domains sind serverweit eindeutig.
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { protokolliere } from '../audit/protokoll.js';
import { requireAnmeldung } from '../auth/kontext.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { zufallsToken } from '../krypto.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Selectable } from 'kysely';
import { ungueltig, verwalteterMandant, VERWALTUNG_AUDIT } from '../mandant/verwaltung.js';
import type { MandantDomainTabelle } from '../db/schema.js';
import { domainAenderungSchema, domainNeuSchema } from './schemas.js';

type Trx = Parameters<Parameters<typeof withMandant>[2]>[0];

/** Öffentliche E-Mail-Anbieter: nie einem Mandanten zuordenbar. */
export const OEFFENTLICHE_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.de',
  'hotmail.com',
  'hotmail.de',
  'live.com',
  'live.de',
  'msn.com',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  'gmx.com',
  'gmx.eu',
  'web.de',
  'email.de',
  'mail.de',
  'yahoo.com',
  'yahoo.de',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  't-online.de',
  'freenet.de',
  'arcor.de',
  'online.de',
  '1und1.de',
  'aol.com',
  'aol.de',
  'posteo.de',
  'mailbox.org',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'tutanota.com',
  'tuta.io',
  'zoho.com',
  'yandex.com',
  'mail.ru',
]);

/** Klein, ohne Punkt am Ende, IDNA (Punycode); `null` bei ungültigen Namen. */
export function normalisiereDomain(roh: string): string | null {
  const t = roh.trim().toLowerCase().replace(/\.$/, '');
  if (!t || t.length > 253) return null;
  const ascii = domainToASCII(t);
  if (!ascii || ascii.length > 253) return null;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(
    ascii,
  )
    ? ascii
    : null;
}

/** Domain einer E-Mail-Adresse (normalisiert) oder `null`. */
export function domainAusEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0 ? normalisiereDomain(email.slice(at + 1)) : null;
}

/** TXT-Abfrage (Tests ersetzen sie mit `setzeTxtAufloeser`). */
export type TxtAufloeser = (name: string) => Promise<string[][]>;

const dnsAufloeser: TxtAufloeser = (name) =>
  new Resolver({ timeout: 3000, tries: 2 }).resolveTxt(name);
let txtAufloeser: TxtAufloeser = dnsAufloeser;

/** Nur für Tests: eigene TXT-Auflösung, `null` = wieder DNS. */
export function setzeTxtAufloeser(f: TxtAufloeser | null): void {
  txtAufloeser = f ?? dnsAufloeser;
}

const DNS_TIMEOUT_MS = 8000;

export async function txtPruefen(
  domain: string,
  token: string,
): Promise<{ ok: boolean; fehler: string | null }> {
  const name = `_seatmeter.${domain}`;
  const erwartet = `seatmeter-verifizierung=${token}`;
  let zeitgeber: NodeJS.Timeout | undefined;
  try {
    const eintraege = await Promise.race([
      txtAufloeser(name),
      new Promise<never>((_, nein) => {
        zeitgeber = setTimeout(() => nein(new Error('ETIMEOUT')), DNS_TIMEOUT_MS);
      }),
    ]);
    if (eintraege.some((teile) => teile.join('').trim() === erwartet))
      return { ok: true, fehler: null };
    return {
      ok: false,
      fehler: `Der TXT-Eintrag ${name} enthält nicht den erwarteten Wert.`,
    };
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : String(e);
    if (code.includes('ETIMEOUT'))
      return { ok: false, fehler: 'Die DNS-Abfrage hat zu lange gedauert.' };
    return { ok: false, fehler: `Kein TXT-Eintrag ${name} gefunden.` };
  } finally {
    clearTimeout(zeitgeber);
  }
}

function ausgabe(z: Selectable<MandantDomainTabelle>) {
  return {
    domain: z.domain,
    verifiziert: z.verifiziert,
    verifizierungs_token: z.verifizierungs_token,
    verifiziert_am: z.verifiziert_am,
    quelle: z.quelle,
    erstellt: z.erstellt,
    txt_name: `_seatmeter.${z.domain}`,
    txt_wert: `seatmeter-verifizierung=${z.verifizierungs_token}`,
  };
}

/** Ist die Domain im Mandanten der Transaktion verifiziert? */
export async function domainVerifiziert(trx: Trx, domain: string): Promise<boolean> {
  const z = await trx
    .selectFrom('mandant_domain')
    .select('domain')
    .where('domain', '=', domain)
    .where('verifiziert', '=', true)
    .executeTakeFirst();
  return Boolean(z);
}

/**
 * Mandantenfreie Auflösung für die Anmeldeseite (Eigentümer-Verbindung, nur die Zuordnung):
 * verifizierte Domain → Mandant.
 */
export async function mandantZurDomain(db: Db, domain: string): Promise<string | null> {
  const z = await db
    .selectFrom('mandant_domain')
    .select('mandant_id')
    .where('domain', '=', domain)
    .where('verifiziert', '=', true)
    .executeTakeFirst();
  return z?.mandant_id ?? null;
}

function domainAusPfad(request: FastifyRequest, reply: FastifyReply): string | null {
  const roh = (request.params as { domain?: string }).domain ?? '';
  const d = normalisiereDomain(decodeURIComponent(roh));
  if (!d) void reply.code(400).send({ fehler: 'ungültige Domain', code: 'domain_ungueltig' });
  return d;
}

/** Registriert die Domain-Routen (Mandanten-Admin von :id oder Plattform-Admin). */
export function registriereDomainRouten(app: FastifyInstance, db: Db): void {
  const basis = '/api/v1/mandant/domains';
  const opt = { preHandler: requireAnmeldung };

  app.get(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const zeilen = await withMandant(db, m.id, (trx) =>
      trx.selectFrom('mandant_domain').selectAll().orderBy('domain').execute(),
    );
    return { domains: zeilen.map(ausgabe) };
  });

  app.post(basis, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const e = domainNeuSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const domain = normalisiereDomain(e.data.domain);
    if (!domain)
      return reply.code(400).send({ fehler: 'ungültige Domain', code: 'domain_ungueltig' });
    if (OEFFENTLICHE_DOMAINS.has(domain))
      return reply.code(400).send({
        fehler: 'Öffentliche E-Mail-Anbieter können keinem Mandanten zugeordnet werden.',
        code: 'domain_oeffentlich',
      });
    // Serverweit eindeutig: auch Domains anderer Mandanten prüfen (Eigentümer-Verbindung, nur Zuordnung).
    const vorhanden = await db
      .selectFrom('mandant_domain')
      .select('mandant_id')
      .where('domain', '=', domain)
      .executeTakeFirst();
    if (vorhanden && vorhanden.mandant_id !== m.id) return vergeben(reply);
    const benutzerId = request.benutzer!.benutzerId;
    try {
      const zeile = await withMandant(db, m.id, async (trx) => {
        const alt = await trx
          .selectFrom('mandant_domain')
          .selectAll()
          .where('domain', '=', domain)
          .executeTakeFirst();
        if (alt) return { zeile: alt, neu: false };
        const neu = await trx
          .insertInto('mandant_domain')
          .values({ domain, mandant_id: m.id, verifizierungs_token: zufallsToken(18) })
          .returningAll()
          .executeTakeFirstOrThrow();
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.domainHinzugefuegt,
          objekt: `domain:${domain}`,
        });
        return { zeile: neu, neu: true };
      });
      return reply.code(zeile.neu ? 201 : 200).send(ausgabe(zeile.zeile));
    } catch (fehler) {
      if (fehler && typeof fehler === 'object' && 'code' in fehler && fehler.code === '23505')
        return vergeben(reply);
      throw fehler;
    }
  });

  app.delete(`${basis}/:domain`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const domain = domainAusPfad(request, reply);
    if (!domain) return reply;
    const benutzerId = request.benutzer!.benutzerId;
    const ok = await withMandant(db, m.id, async (trx) => {
      const r = await trx
        .deleteFrom('mandant_domain')
        .where('domain', '=', domain)
        .executeTakeFirst();
      if (Number(r.numDeletedRows) === 0) return false;
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.domainEntfernt,
        objekt: `domain:${domain}`,
      });
      return true;
    });
    return ok ? reply.code(204).send() : reply.code(404).send({ fehler: 'Domain nicht gefunden' });
  });

  app.post(`${basis}/:domain/pruefen`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    const domain = domainAusPfad(request, reply);
    if (!domain) return reply;
    const zeile = await withMandant(db, m.id, (trx) =>
      trx.selectFrom('mandant_domain').selectAll().where('domain', '=', domain).executeTakeFirst(),
    );
    if (!zeile) return reply.code(404).send({ fehler: 'Domain nicht gefunden' });
    if (zeile.verifiziert) return { verifiziert: true, fehler: null, domain: ausgabe(zeile) };
    const ergebnis = await txtPruefen(domain, zeile.verifizierungs_token);
    if (!ergebnis.ok)
      return { verifiziert: false, fehler: ergebnis.fehler, domain: ausgabe(zeile) };
    const benutzerId = request.benutzer!.benutzerId;
    const neu = await withMandant(db, m.id, async (trx) => {
      const z = await trx
        .updateTable('mandant_domain')
        .set({ verifiziert: true, verifiziert_am: new Date(), quelle: 'dns' })
        .where('domain', '=', domain)
        .returningAll()
        .executeTakeFirstOrThrow();
      await protokolliere(trx, {
        benutzerId,
        aktion: VERWALTUNG_AUDIT.domainVerifiziert,
        objekt: `domain:${domain} (DNS-TXT)`,
      });
      return z;
    });
    return { verifiziert: true, fehler: null, domain: ausgabe(neu) };
  });

  // Plattform-Admin: direkt verifizieren (oder zurücknehmen), z. B. nach Prüfung per Vertrag.
  app.put(`${basis}/:domain`, opt, async (request, reply) => {
    const m = await verwalteterMandant(request, reply);
    if (!m) return reply;
    if (m.zugriff !== 'plattform')
      return reply.code(403).send({ fehler: 'nur für Plattform-Admins' });
    const domain = domainAusPfad(request, reply);
    if (!domain) return reply;
    const e = domainAenderungSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const benutzerId = request.benutzer!.benutzerId;
    const z = await withMandant(db, m.id, async (trx) => {
      const neu = await trx
        .updateTable('mandant_domain')
        .set(
          e.data.verifiziert
            ? { verifiziert: true, verifiziert_am: new Date(), quelle: 'plattform_admin' }
            : { verifiziert: false, verifiziert_am: null, quelle: null },
        )
        .where('domain', '=', domain)
        .returningAll()
        .executeTakeFirst();
      if (neu)
        await protokolliere(trx, {
          benutzerId,
          aktion: VERWALTUNG_AUDIT.domainVerifiziert,
          objekt: `domain:${domain} ${e.data.verifiziert ? 'verifiziert' : 'zurückgenommen'} (Plattform-Admin)`,
        });
      return neu;
    });
    return z ? ausgabe(z) : reply.code(404).send({ fehler: 'Domain nicht gefunden' });
  });
}

function vergeben(reply: FastifyReply) {
  return reply.code(409).send({
    fehler: 'Diese Domain gehört schon zu einem anderen Mandanten.',
    code: 'domain_vergeben',
  });
}
