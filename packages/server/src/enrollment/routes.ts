// Enrollment (Architektur §2.2 `enroll <code>`, §6 Rechner-Token):
// - Agent: `POST /api/agent/v1/enroll` (Einmalcode → Rechner + Token), `GET /api/agent/v1/config`,
//   `POST /api/agent/v1/heartbeat` (Lebenszeichen je Sweeper-Lauf, setzt `rechner.zuletzt_gesehen`).
// - Dashboard: `POST /api/v1/rechner/einmalcode`, `GET /api/v1/rechner`, `POST /api/v1/rechner/:id/widerrufen`.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  agentHeartbeatSchema,
  agentKonfigurationSchema,
  enrollmentAnfrageSchema,
  type AgentKonfiguration,
  type EnrollmentAntwort,
} from '@seatmeter/shared';
import { base32 } from '@seatmeter/shared/hmac';
import { withMandant } from '../db/mandant.js';
import { nutzungVermerken } from '../ingest-gemeinsam/speichern.js';
import { ratenlimitMeldung, type IngestRatenlimit } from '../ingest-gemeinsam/ratenlimit.js';
import {
  antworteBeiDbAusfall,
  sha256,
  sichererFehlerHandler,
  tokenErzeugen,
  zugangsHook,
  zugangVon,
} from '../ingest-gemeinsam/zugang.js';
import { benutzerVon, requireRolle } from '../auth/index.js';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import type { PluginKontext } from '../plugin.js';

export interface EnrollmentOptionen {
  ctx: PluginKontext;
  /** Öffentliche Basis-URL für den Agenten (`SEATMETER_INGEST_URL`); sonst aus der Anfrage abgeleitet. */
  ingestUrl?: string | undefined;
  /** Ratenlimits, gemeinsam mit OTLP und Agent-Ingest (Eimer je IP, Enrollment, Fehlversuche). */
  ratenlimit: IngestRatenlimit;
}

export const EINMALCODE_GUELTIG_STUNDEN = 24;

/** Einmalcode `XXXX-XXXX-XXXX` (Base32, 60 Bit). */
export function einmalcodeErzeugen(): string {
  const roh = base32(randomBytes(8)).slice(0, 12);
  return `${roh.slice(0, 4)}-${roh.slice(4, 8)}-${roh.slice(8, 12)}`;
}

/** Groß, ohne Trennzeichen und Leerraum; gehasht wird nur diese Form. */
export function einmalcodeNormalisieren(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

function basisUrl(anfrage: FastifyRequest, fest?: string): string {
  if (fest) return fest.replace(/\/+$/, '');
  const proto = String(anfrage.headers['x-forwarded-proto'] ?? anfrage.protocol).split(',')[0];
  const host = String(anfrage.headers['x-forwarded-host'] ?? anfrage.host).split(',')[0];
  return `${proto?.trim() || 'http'}://${host?.trim() || 'localhost'}`;
}

export function agentKonfiguration(anfrage: FastifyRequest, fest?: string): AgentKonfiguration {
  // Standardwerte aus dem Schema (Modus hooks, Sweeper 10 min, keine Pfadfilter, 30 Tage Rückfüllung).
  return agentKonfigurationSchema.parse({ server_url: basisUrl(anfrage, fest) });
}

const einmalcodeAnfrageSchema = z.strictObject({
  /** Anzeigename des Rechners (vom Admin, z. B. „MacBook Entwicklung“); landet in `rechner.bezeichnung`. */
  bezeichnung: z.string().trim().min(1).max(100).optional(),
  person_id: z.uuid().optional(),
  pseudonym: z
    .string()
    .regex(/^P-[A-Z2-7]{6}$/)
    .optional(),
});

const rechnerIdSchema = z.strictObject({ id: z.uuid() });

// ---------------------------------------------------------------------------------------------

export async function enrollmentRouten(
  app: FastifyInstance,
  optionen: EnrollmentOptionen,
): Promise<void> {
  const { ctx } = optionen;
  const { db } = ctx;
  const { ratenlimit } = optionen;

  // Agent-Routen (öffentlicher Ingest-Host).
  await app.register(async (kind) => {
    kind.setErrorHandler(sichererFehlerHandler);

    kind.post('/api/agent/v1/enroll', async (anfrage, antwort) => {
      // Ohne Token erreichbar: Eimer je IP, Versuche je IP und (enger) falsche Einmalcodes je IP.
      const sperre = ratenlimit.ip(anfrage.ip) ?? ratenlimit.enroll(anfrage.ip);
      if (sperre) {
        ratenlimit.ablehnen(anfrage, antwort, 'b', sperre);
        return antwort.code(429).send({ fehler: ratenlimitMeldung(sperre) });
      }
      const eingabe = enrollmentAnfrageSchema.safeParse(anfrage.body);
      if (!eingabe.success) return antwort.code(400).send({ fehler: 'Anfrage ungültig' });
      const codeHash = sha256(einmalcodeNormalisieren(eingabe.data.code));
      try {
        const treffer = (
          await sql<{ mandant_id: string; person_id: string | null }>`
            SELECT mandant_id, person_id FROM einmalcode_aufloesen(${codeHash})`.execute(db)
        ).rows[0];
        if (!treffer) {
          ratenlimit.enrollFehlversuch(anfrage.ip);
          return antwort
            .code(401)
            .send({ fehler: 'Einmalcode ungültig, abgelaufen oder schon genutzt' });
        }
        const token = tokenErzeugen('rechner');
        const rechnerId = await withMandant(db, treffer.mandant_id, async (trx) => {
          // Code atomar verbrauchen (parallele Versuche mit demselben Code: nur einer gewinnt).
          const code = await trx
            .updateTable('einmalcode')
            .set({ genutzt_am: new Date() })
            .where('code_sha256', '=', codeHash)
            .where('genutzt_am', 'is', null)
            .where('laeuft_ab', '>', new Date())
            .returning(['person_id', 'bezeichnung'])
            .executeTakeFirst();
          if (!code) return null;
          const rechner = await trx
            .insertInto('rechner')
            .values({
              mandant_id: treffer.mandant_id,
              person_id: code.person_id,
              bezeichnung: code.bezeichnung,
              os: eingabe.data.os,
              agent_version: eingabe.data.agent_version,
              zuletzt_gesehen: new Date(),
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('ingest_token')
            .values({
              mandant_id: treffer.mandant_id,
              typ: 'rechner',
              rechner_id: rechner.id,
              token_sha256: token.sha256,
              praefix: token.praefix,
            })
            .execute();
          await trx
            .updateTable('einmalcode')
            .set({ rechner_id: rechner.id })
            .where('code_sha256', '=', codeHash)
            .execute();
          return rechner.id;
        });
        if (!rechnerId) {
          ratenlimit.enrollFehlversuch(anfrage.ip);
          return antwort
            .code(401)
            .send({ fehler: 'Einmalcode ungültig, abgelaufen oder schon genutzt' });
        }
        const koerper: EnrollmentAntwort = {
          rechner_id: rechnerId,
          token: token.klartext,
          konfiguration: agentKonfiguration(anfrage, optionen.ingestUrl),
        };
        // Das Token wird genau hier einmal ausgeliefert und nirgends zwischengespeichert.
        return antwort.code(201).header('cache-control', 'no-store').send(koerper);
      } catch (f) {
        if (antworteBeiDbAusfall(f, antwort)) return antwort;
        throw f;
      }
    });

    await kind.register(async (mitToken) => {
      mitToken.addHook(
        'onRequest',
        zugangsHook({ db, typen: ['rechner'], ratenlimit, gruppe: 'agent', quelle: 'b' }),
      );
      mitToken.get('/api/agent/v1/config', async (anfrage, antwort) => {
        const zugang = zugangVon(anfrage);
        try {
          await withMandant(db, zugang.mandantId, (trx) =>
            nutzungVermerken(trx, zugang.tokenId, zugang.rechnerId),
          );
        } catch (f) {
          if (antworteBeiDbAusfall(f, antwort)) return antwort;
          throw f;
        }
        return agentKonfiguration(anfrage, optionen.ingestUrl);
      });

      // Lebenszeichen des Agenten (auch bei leerer Warteschlange): nur Zeitpunkt (Server-Uhr) und
      // Agent-Version, keine Inhalte. Grundlage für `agenten` in `/api/health/ingest`.
      mitToken.post('/api/agent/v1/heartbeat', async (anfrage, antwort) => {
        const eingabe = agentHeartbeatSchema.safeParse(anfrage.body);
        if (!eingabe.success) return antwort.code(400).send({ fehler: 'Anfrage ungültig' });
        const zugang = zugangVon(anfrage);
        try {
          await withMandant(db, zugang.mandantId, (trx) =>
            nutzungVermerken(trx, zugang.tokenId, zugang.rechnerId, eingabe.data.agent_version),
          );
        } catch (f) {
          if (antworteBeiDbAusfall(f, antwort)) return antwort;
          throw f;
        }
        return antwort.code(204).send();
      });
    });
  });

  // Dashboard-Routen (nur angemeldet, Rolle Mandanten-Admin).
  await app.register(async (kind) => {
    // Anmeldung, CSRF und Rolle über das Modul auth (Cookie-Sitzung, Header-Modus oder Plugin-Provider).
    kind.addHook('preHandler', requireRolle('mandanten_admin'));

    kind.post('/api/v1/rechner/einmalcode', async (anfrage, antwort) => {
      const eingabe = einmalcodeAnfrageSchema.safeParse(anfrage.body ?? {});
      if (!eingabe.success) return antwort.code(400).send({ fehler: 'Anfrage ungültig' });
      const b = benutzerVon(anfrage);
      const code = einmalcodeErzeugen();
      const laeuftAb = new Date(Date.now() + EINMALCODE_GUELTIG_STUNDEN * 3_600_000);
      const ergebnis = await withMandant(db, b.mandantId, async (trx) => {
        let personId: string | null = null;
        if (eingabe.data.person_id || eingabe.data.pseudonym) {
          let q = trx.selectFrom('person').select('id').where('mandant_id', '=', b.mandantId);
          if (eingabe.data.person_id) q = q.where('id', '=', eingabe.data.person_id);
          if (eingabe.data.pseudonym) q = q.where('pseudonym', '=', eingabe.data.pseudonym);
          const p = await q.executeTakeFirst();
          if (!p) return null;
          personId = p.id;
        }
        await trx
          .insertInto('einmalcode')
          .values({
            code_sha256: sha256(einmalcodeNormalisieren(code)),
            mandant_id: b.mandantId,
            person_id: personId,
            laeuft_ab: laeuftAb,
            bezeichnung: eingabe.data.bezeichnung ?? null,
          })
          .execute();
        await protokolliere(trx, {
          benutzerId: b.benutzerId,
          aktion: AUDIT_AKTION.einmalcodeErzeugt,
          objekt: personId ? `person:${personId}` : null,
        });
        return { personId };
      });
      if (!ergebnis) return antwort.code(404).send({ fehler: 'Person nicht gefunden' });
      return antwort
        .code(201)
        .header('cache-control', 'no-store')
        .send({
          code,
          laeuft_ab: laeuftAb.toISOString(),
          person_id: ergebnis.personId,
          bezeichnung: eingabe.data.bezeichnung ?? null,
        });
    });

    kind.get('/api/v1/rechner', async (anfrage) => {
      const b = benutzerVon(anfrage);
      const zeilen = await withMandant(db, b.mandantId, (trx) =>
        trx
          .selectFrom('rechner as r')
          .leftJoin('person as p', 'p.id', 'r.person_id')
          .select([
            'r.id',
            'r.bezeichnung',
            'r.os',
            'r.agent_version',
            'r.registriert',
            'r.zuletzt_gesehen',
            'r.widerrufen',
            'r.person_id',
            'p.pseudonym',
          ])
          .orderBy('r.registriert', 'desc')
          .execute(),
      );
      return {
        rechner: zeilen.map((z) => ({
          id: z.id,
          bezeichnung: z.bezeichnung,
          os: z.os,
          agent_version: z.agent_version,
          registriert: new Date(z.registriert).toISOString(),
          zuletzt_gesehen: z.zuletzt_gesehen ? new Date(z.zuletzt_gesehen).toISOString() : null,
          widerrufen: z.widerrufen ? new Date(z.widerrufen).toISOString() : null,
          person_id: z.person_id,
          person_pseudonym: z.pseudonym,
        })),
      };
    });

    kind.post('/api/v1/rechner/:id/widerrufen', async (anfrage, antwort) => {
      const param = rechnerIdSchema.safeParse(anfrage.params);
      if (!param.success) return antwort.code(400).send({ fehler: 'Rechner-ID ungültig' });
      const b = benutzerVon(anfrage);
      const jetzt = new Date();
      const ergebnis = await withMandant(db, b.mandantId, async (trx) => {
        const r = await trx
          .selectFrom('rechner')
          .select('id')
          .where('id', '=', param.data.id)
          .executeTakeFirst();
        if (!r) return null;
        await trx
          .updateTable('rechner')
          .set({ widerrufen: jetzt })
          .where('id', '=', r.id)
          .where('widerrufen', 'is', null)
          .execute();
        await trx
          .updateTable('ingest_token')
          .set({ widerrufen: jetzt })
          .where('rechner_id', '=', r.id)
          .where('widerrufen', 'is', null)
          .execute();
        await protokolliere(trx, {
          benutzerId: b.benutzerId,
          aktion: AUDIT_AKTION.rechnerWiderrufen,
          objekt: `rechner:${r.id}`,
        });
        return r.id;
      });
      if (!ergebnis) return antwort.code(404).send({ fehler: 'Rechner nicht gefunden' });
      return antwort.code(204).send();
    });
  });
}
