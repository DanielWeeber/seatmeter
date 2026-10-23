// Modul ausrollen (Architektur §10): Werte für den Schnipsel-Generator der Dashboard-Seite „Ausrollen“
// und ein neues Mandanten-Token für den Schnipsel mit festem Header. Nur Mandanten-Admins.
// Die Konfiguration enthält nie ein Token; das neue Token steht nur in der einen Antwort.
import type { FastifyRequest } from 'fastify';
import type { AusrollenKonfiguration, MandantenTokenAntwort } from '@seatmeter/shared';
import { AUDIT_AKTION, protokolliere } from '../audit/protokoll.js';
import { benutzerVon, requireRolle } from '../auth/kontext.js';
import { withMandant } from '../db/mandant.js';
import { tokenErzeugen } from '../ingest-gemeinsam/zugang.js';
import type { SeatmeterPlugin } from '../plugin.js';

const ohneSchraegstrich = (u: string) => u.replace(/\/+$/, '');

/** `SEATMETER_INGEST_URL`, sonst `SEATMETER_PUBLIC_URL`, sonst aus der Anfrage (Proxy-Header). */
export function ingestBasis(
  anfrage: FastifyRequest,
  env: NodeJS.ProcessEnv,
  oeffentlich: string | undefined,
): { url: string; quelle: AusrollenKonfiguration['ingest_url_quelle'] } {
  if (env.SEATMETER_INGEST_URL)
    return { url: ohneSchraegstrich(env.SEATMETER_INGEST_URL), quelle: 'konfiguration' };
  if (oeffentlich) return { url: ohneSchraegstrich(oeffentlich), quelle: 'oeffentlich' };
  const proto = String(anfrage.headers['x-forwarded-proto'] ?? anfrage.protocol).split(',')[0];
  const host = String(anfrage.headers['x-forwarded-host'] ?? anfrage.host).split(',')[0];
  return { url: `${proto?.trim() || 'http'}://${host?.trim() || 'localhost'}`, quelle: 'anfrage' };
}

function releaseUrl(env: NodeJS.ProcessEnv): string | null {
  const u = env.SEATMETER_AGENT_RELEASE_URL;
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? ohneSchraegstrich(u) : null;
  } catch {
    return null;
  }
}

export function ausrollenPlugin(env: NodeJS.ProcessEnv = process.env): SeatmeterPlugin {
  return {
    name: 'kern-ausrollen',
    routen(app, { db, konfiguration }) {
      app.get(
        '/api/v1/ausrollen',
        { preHandler: requireRolle('mandanten_admin') },
        async (request): Promise<AusrollenKonfiguration> => {
          const a = benutzerVon(request);
          const { mandant, orgs } = await withMandant(db, a.mandantId, async (trx) => ({
            mandant: await trx
              .selectFrom('mandant')
              .select(['slug', 'name', 'plan'])
              .where('id', '=', a.mandantId)
              .executeTakeFirstOrThrow(),
            orgs: await trx
              .selectFrom('anthropic_org')
              .select(['org_uuid', 'bezeichnung', 'plan'])
              .orderBy('org_uuid')
              .execute(),
          }));
          const basis = ingestBasis(request, env, konfiguration.SEATMETER_PUBLIC_URL);
          return {
            mandant,
            ingest_url: basis.url,
            ingest_url_quelle: basis.quelle,
            otlp_endpoint: `${basis.url}/otlp`,
            orgs: orgs.map((o) => ({
              org_uuid: o.org_uuid,
              bezeichnung: o.bezeichnung,
              plan: o.plan,
            })),
            agent: {
              release_url: releaseUrl(env),
              server_version: env.SEATMETER_VERSION || 'unbekannt',
            },
          };
        },
      );

      // Neues Mandanten-Token (`smi_…`) für Schnipsel mit festem Header; Klartext nur in dieser Antwort.
      // Sicheres Muster: in der Transaktion nur Daten zurückgeben, gesendet wird nach dem Commit.
      app.post(
        '/api/v1/ausrollen/mandanten-token',
        { preHandler: requireRolle('mandanten_admin') },
        async (request, reply) => {
          const a = benutzerVon(request);
          const token = tokenErzeugen('mandant');
          const erstellt = await withMandant(db, a.mandantId, async (trx) => {
            const z = await trx
              .insertInto('ingest_token')
              .values({
                mandant_id: a.mandantId,
                typ: 'mandant',
                token_sha256: token.sha256,
                praefix: token.praefix,
              })
              .returning('erstellt')
              .executeTakeFirstOrThrow();
            await protokolliere(trx, {
              benutzerId: a.benutzerId,
              aktion: AUDIT_AKTION.ingestTokenErzeugt,
              objekt: `ingest_token:${token.praefix}`,
            });
            return new Date(z.erstellt).toISOString();
          });
          const koerper: MandantenTokenAntwort = {
            token: token.klartext,
            praefix: token.praefix,
            erstellt,
          };
          return reply.code(201).header('cache-control', 'no-store').send(koerper);
        },
      );
    },
  };
}
