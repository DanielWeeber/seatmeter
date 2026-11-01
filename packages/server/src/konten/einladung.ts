// Einladung annehmen (ohne Anmeldung): Der Link `/einladung/<token>` aus der Kontenverwaltung setzt einmalig
// das Passwort eines eingeladenen Kontos und meldet es an. Token nur als SHA-256 gespeichert, 7 Tage gültig,
// danach und nach der Annahme wertlos. Fehlversuche je Adresse begrenzt.
//   POST /api/v1/auth/einladung/pruefen  { token }            → { benutzername, gueltig_bis }
//   POST /api/v1/auth/einladung          { token, passwort }  → wie /auth/login (Sitzung, /me-Antwort)
import { nurEntwickler } from '@seatmeter/shared';
import { protokolliere } from '../audit/protokoll.js';
import { passwortHash } from '../auth/index.js';
import { erstelleSitzung, meAntwort } from '../auth/kontext.js';
import { Ratenbegrenzer } from '../auth/ratenbegrenzer.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { sha256 } from '../krypto.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ungueltig, VERWALTUNG_AUDIT } from '../mandant/verwaltung.js';
import { einladungAnnehmenSchema, einladungTokenSchema } from './schemas.js';

/** Offene Einladung zum Token (Eigentümer-Verbindung, nur die Zuordnung Token → Konto und Mandant). */
async function einladungFinden(db: Db, token: string) {
  return db
    .selectFrom('konto_einladung as e')
    .innerJoin('benutzer as b', 'b.id', 'e.benutzer_id')
    .select(['e.mandant_id', 'e.benutzer_id', 'e.laeuft_ab', 'b.benutzername'])
    .where('e.token_sha256', '=', sha256(token))
    .where('e.laeuft_ab', '>', new Date())
    .where('b.passwort_hash', 'is', null)
    .where('b.deaktiviert', 'is', null)
    .executeTakeFirst();
}

const UNGUELTIG = {
  code: 'einladung_ungueltig',
  fehler: 'Der Einladungslink ist ungültig, schon benutzt oder abgelaufen.',
} as const;

export function registriereEinladungRouten(app: FastifyInstance, db: Db): void {
  // Fehlversuche je Adresse: 20 in 15 Minuten.
  const fehlversuche = new Ratenbegrenzer(20, 15 * 60_000);
  const adresse = (r: FastifyRequest) => r.ip || 'unbekannt';
  const gesperrt = (request: FastifyRequest, reply: FastifyReply) => {
    if (!fehlversuche.gesperrt(adresse(request))) return false;
    void reply.code(429).header('retry-after', '900').send({ fehler: 'zu viele Versuche' });
    return true;
  };

  app.post('/api/v1/auth/einladung/pruefen', async (request, reply) => {
    if (gesperrt(request, reply)) return reply;
    const e = einladungTokenSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const einladung = await einladungFinden(db, e.data.token);
    if (!einladung) {
      fehlversuche.fehlschlag(adresse(request));
      return reply.code(404).send(UNGUELTIG);
    }
    return { benutzername: einladung.benutzername, gueltig_bis: einladung.laeuft_ab };
  });

  app.post('/api/v1/auth/einladung', async (request, reply) => {
    if (gesperrt(request, reply)) return reply;
    const e = einladungAnnehmenSchema.safeParse(request.body);
    if (!e.success) return ungueltig(reply, e.error);
    const einladung = await einladungFinden(db, e.data.token);
    if (!einladung) {
      fehlversuche.fehlschlag(adresse(request));
      return reply.code(404).send(UNGUELTIG);
    }
    const hash = await passwortHash(e.data.passwort);
    const angenommen = await withMandant(db, einladung.mandant_id, async (trx) => {
      // Einmalig: nur solange das Konto noch kein Passwort hat.
      const r = await trx
        .updateTable('benutzer')
        .set({ passwort_hash: hash, login: 'lokal' })
        .where('id', '=', einladung.benutzer_id)
        .where('passwort_hash', 'is', null)
        .where('deaktiviert', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) return false;
      const rollen = await trx
        .selectFrom('rolle')
        .select('rolle')
        .where('mandant_id', '=', einladung.mandant_id)
        .where('benutzer_id', '=', einladung.benutzer_id)
        .execute();
      // Nur `entwickler`: ohne Konto im Audit, wie beim Anlegen über SSO. Die Annahme liegt direkt vor der Wahl und ließe
      // sich ihr sonst zuordnen.
      const nurWahl = nurEntwickler(rollen.map((z) => z.rolle));
      await protokolliere(trx, {
        benutzerId: nurWahl ? null : einladung.benutzer_id,
        aktion: VERWALTUNG_AUDIT.einladungAngenommen,
        objekt: nurWahl ? 'Rolle entwickler' : `benutzer:${einladung.benutzer_id}`,
      });
      return true;
    });
    if (!angenommen) return reply.code(404).send(UNGUELTIG);
    // Alle Einladungen des Kontos (auch anderer Mandanten) sind damit erledigt.
    await db
      .deleteFrom('konto_einladung')
      .where('benutzer_id', '=', einladung.benutzer_id)
      .execute();
    const a = await erstelleSitzung(
      app.seatmeterAuth,
      reply,
      { id: einladung.benutzer_id, benutzername: einladung.benutzername },
      'lokal',
      einladung.mandant_id,
    );
    return meAntwort(app.seatmeterAuth, a);
  });
}
