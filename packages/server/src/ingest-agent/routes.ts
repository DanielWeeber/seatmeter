// Routen `POST /api/ingest/v1/anfragen` und `POST /api/ingest/v1/sitzungen` (Quelle B, nur Rechner-Token).
// Strikte Schemas aus @seatmeter/shared: unbekannte Felder (cwd, Pfade, Hostnamen, Inhalte) → 400.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import {
  agentPushSchema,
  agentSitzungenPushSchema,
  istPfadProjekt,
  normalisiereRepoUrl,
  QUELLE_B,
  schluesselFiltern,
  type AgentAnfrage,
  type AgentPushAntwort,
  type AuthHinweis,
  type AuthKlasse,
  type ProjektMeldung,
} from '@seatmeter/shared';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import {
  imAnnahmefenster,
  mandantKontextLaden,
  partitionenSicherstellen,
  tagIn,
  verwerfZaehler,
  type MandantKontext,
} from '../ingest-gemeinsam/kontext.js';
import {
  anfrageSpeichern,
  leereStatistik,
  nutzungVermerken,
  personAufloesen,
  personSchluessel,
  pfadProjektAufloesen,
  projektAufloesen,
  sitzungenBuendeln,
  sitzungSpeichern,
  statistikErhoehen,
  type SitzungEingang,
} from '../ingest-gemeinsam/speichern.js';
import type { IngestRatenlimit } from '../ingest-gemeinsam/ratenlimit.js';
import {
  antworteBeiDbAusfall,
  sichererFehlerHandler,
  zugangsHook,
  zugangVon,
  type IngestZugang,
} from '../ingest-gemeinsam/zugang.js';

export interface AgentIngestOptionen {
  db: Db;
  masterKey: Buffer;
  /** Ratenlimits (je IP, Fehlversuche, je Rechner mit Mandanten-Grenze), gemeinsam mit OTLP und Enrollment. */
  ratenlimit: IngestRatenlimit;
}

/** Abo-Regel für Quelle B (Architektur §4, Zeile „Nur Quelle B“): Hinweis des Agenten + Positivliste. */
export function klassifiziereHinweis(h: AuthHinweis, orgs: ReadonlySet<string>): AuthKlasse {
  if (h.klasse === 'api') return 'api';
  if (!h.org_uuid) return 'unbekannt';
  return orgs.has(h.org_uuid.toLowerCase()) ? 'abo' : 'fremd_org';
}

/** Nur Pfade der Felder, nie Werte (die könnten Inhalte enthalten). */
function schemaFehler(fehler: ZodError): { fehler: string; felder: string[] } {
  const felder = [...new Set(fehler.issues.map((i) => i.path.join('.') || '(Wurzel)'))].slice(
    0,
    20,
  );
  return { fehler: 'Push entspricht nicht dem Schema (unbekannte oder fehlende Felder)', felder };
}

/** Repo-Projekt oder Pfad-Projekt (Schema schon geprüft) auflösen; `null` = unzugeordnet. */
async function projektIdFuer(
  trx: Parameters<Parameters<typeof withMandant>[2]>[0],
  ctx: MandantKontext,
  p: ProjektMeldung | null,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!p) return null;
  if (istPfadProjekt(p)) return pfadProjektAufloesen(trx, ctx, p.name, cache);
  return projektAufloesen(
    trx,
    ctx,
    { url: p.url_norm, owner: p.owner, repoName: p.repo_name, provider: p.provider },
    cache,
  );
}

/** Prüft, dass eine gemeldete URL wirklich eine normalisierte Remote-URL ist (kein Pfad, keine Zugangsdaten). */
function projektGueltig(p: ProjektMeldung | null): boolean {
  if (!p || istPfadProjekt(p)) return true;
  const info = normalisiereRepoUrl(p.url_norm);
  return info !== null && info.urlNorm === p.url_norm;
}

async function rechnerPerson(
  ctx: MandantKontext,
  zugang: IngestZugang,
  trx: Parameters<Parameters<typeof withMandant>[2]>[0],
): Promise<string | null> {
  if (!zugang.rechnerId) return null;
  const r = await trx
    .selectFrom('rechner')
    .select('person_id')
    .where('id', '=', zugang.rechnerId)
    .where('mandant_id', '=', ctx.mandantId)
    .executeTakeFirst();
  return r?.person_id ?? null;
}

export async function agentIngestRouten(
  app: FastifyInstance,
  optionen: AgentIngestOptionen,
): Promise<void> {
  const { db, masterKey } = optionen;

  await app.register(async (kind) => {
    kind.addHook(
      'onRequest',
      zugangsHook({
        db,
        typen: ['rechner'],
        ratenlimit: optionen.ratenlimit,
        gruppe: 'agent',
        quelle: 'b',
      }),
    );
    kind.setErrorHandler(sichererFehlerHandler);

    kind.post('/api/ingest/v1/anfragen', async (anfrage: FastifyRequest, antwort: FastifyReply) => {
      const push = agentPushSchema.safeParse(anfrage.body);
      if (!push.success) return antwort.code(400).send(schemaFehler(push.error));
      if (!push.data.anfragen.every((a) => projektGueltig(a.projekt))) {
        return antwort
          .code(400)
          .send({ fehler: 'projekt.url_norm ist keine normalisierte Repo-URL' });
      }
      const zugang = zugangVon(anfrage);
      try {
        const ctx = await withMandant(db, zugang.mandantId, (trx) =>
          mandantKontextLaden(trx, masterKey, zugang.mandantId),
        );
        const jetzt = new Date();
        const statistik = leereStatistik();
        const ergebnis: AgentPushAntwort = {
          angenommen: 0,
          wiederholt: 0,
          verworfen_api: 0,
          verworfen_fremd_org: 0,
          abgelehnt: 0,
        };
        const abo: { a: AgentAnfrage; ts: Date }[] = [];
        for (const a of push.data.anfragen) {
          const ts = new Date(a.ts);
          const zaehler = verwerfZaehler(klassifiziereHinweis(a.auth_hinweis, ctx.orgs));
          if (zaehler) {
            statistik[zaehler]++;
            ergebnis[zaehler]++;
          } else if (!imAnnahmefenster(ts, ctx.aufbewahrungTage, jetzt)) {
            ergebnis.abgelehnt++;
          } else {
            abo.push({ a, ts });
          }
        }
        await partitionenSicherstellen(
          db,
          abo.map((x) => x.ts),
        );
        await withMandant(db, ctx.mandantId, async (trx) => {
          const personen = new Map<string, string>();
          const projekte = new Map<string, string | null>();
          const gebunden = await rechnerPerson(ctx, zugang, trx);
          const sitzungen: SitzungEingang[] = [];
          const vorbereitet: {
            a: AgentAnfrage;
            ts: Date;
            tag: string;
            personId: string | null;
            projektId: string | null;
          }[] = [];
          for (const { a, ts } of abo) {
            const tag = tagIn(ctx.zeitzone, ts);
            // Person aus der Rechnerbindung, sonst über die Konto-UUID des Auth-Hinweises.
            const personId =
              gebunden ??
              (await personAufloesen(
                trx,
                ctx,
                personSchluessel(ctx.personSalt, {
                  konto: a.auth_hinweis.account_uuid,
                  email: null,
                }),
                tag,
                personen,
              ));
            const projektId = await projektIdFuer(trx, ctx, a.projekt, projekte);
            if (!projektId) statistik.unzugeordnet++;
            sitzungen.push({
              quelle: QUELLE_B,
              sessionId: a.session_id,
              personId,
              rechnerId: zugang.rechnerId,
              projektId,
              orgUuid: a.auth_hinweis.org_uuid?.toLowerCase() ?? null,
              authKlasse: 'abo',
              ccVersion: a.cc_version,
              start: ts,
              ende: ts,
            });
            vorbereitet.push({ a, ts, tag, personId, projektId });
          }
          for (const s of sitzungenBuendeln(sitzungen))
            await sitzungSpeichern(trx, ctx.mandantId, s);
          const schluessel = (x: (typeof vorbereitet)[number]) =>
            x.a.request_id ?? `msg:${x.a.message_id}`;
          vorbereitet.sort((x, y) => schluessel(x).localeCompare(schluessel(y)));
          for (const v of vorbereitet) {
            const { a } = v;
            const r = await anfrageSpeichern(trx, ctx.mandantId, {
              quelle: QUELLE_B,
              anfrageKey: schluessel(v),
              ts: v.ts,
              tag: v.tag,
              sessionId: a.session_id,
              personId: v.personId,
              projektId: v.projektId,
              model: a.model,
              speed: a.speed,
              inferenceGeo: a.inference_geo,
              serviceTier: a.service_tier,
              querySource: null,
              istSubagent: a.ist_subagent,
              input: a.input_tokens,
              output: a.output_tokens,
              cacheRead: a.cache_read_input_tokens,
              cacheWrite: a.cache_creation_input_tokens,
              cacheWrite1h: a.cache_write_1h,
              webSearch: a.web_search_requests,
              authKlasse: 'abo',
              zaehltAlsAbo: true,
              ccKostenUsdMicros: null,
              issueSchluessel: a.issue_schluessel
                ? schluesselFiltern(a.issue_schluessel, ctx.issuePraefixe)
                : null,
            });
            if (r === 'wiederholt') ergebnis.wiederholt++;
            else ergebnis.angenommen++;
          }
          statistik.angenommen = ergebnis.angenommen;
          await statistikErhoehen(trx, ctx.mandantId, tagIn(ctx.zeitzone, jetzt), 'b', statistik);
          await nutzungVermerken(trx, zugang.tokenId, zugang.rechnerId, push.data.agent_version);
        });
        return ergebnis;
      } catch (f) {
        if (antworteBeiDbAusfall(f, antwort)) return antwort;
        throw f;
      }
    });

    kind.post(
      '/api/ingest/v1/sitzungen',
      async (anfrage: FastifyRequest, antwort: FastifyReply) => {
        const push = agentSitzungenPushSchema.safeParse(anfrage.body);
        if (!push.success) return antwort.code(400).send(schemaFehler(push.error));
        if (!push.data.sitzungen.every((s) => projektGueltig(s.projekt))) {
          return antwort
            .code(400)
            .send({ fehler: 'projekt.url_norm ist keine normalisierte Repo-URL' });
        }
        const zugang = zugangVon(anfrage);
        try {
          const ctx = await withMandant(db, zugang.mandantId, (trx) =>
            mandantKontextLaden(trx, masterKey, zugang.mandantId),
          );
          const ergebnis: AgentPushAntwort = {
            angenommen: 0,
            wiederholt: 0,
            verworfen_api: 0,
            verworfen_fremd_org: 0,
            abgelehnt: 0,
          };
          await withMandant(db, ctx.mandantId, async (trx) => {
            const personen = new Map<string, string>();
            const projekte = new Map<string, string | null>();
            const gebunden = await rechnerPerson(ctx, zugang, trx);
            const sitzungen: SitzungEingang[] = [];
            for (const s of push.data.sitzungen) {
              const zaehler = verwerfZaehler(klassifiziereHinweis(s.auth_hinweis, ctx.orgs));
              if (zaehler) {
                ergebnis[zaehler]++;
                continue;
              }
              const start = new Date(s.start);
              const ende = s.ende ? new Date(s.ende) : start;
              const personId =
                gebunden ??
                (await personAufloesen(
                  trx,
                  ctx,
                  personSchluessel(ctx.personSalt, {
                    konto: s.auth_hinweis.account_uuid,
                    email: null,
                  }),
                  tagIn(ctx.zeitzone, start),
                  personen,
                ));
              sitzungen.push({
                quelle: QUELLE_B,
                sessionId: s.session_id,
                personId,
                rechnerId: zugang.rechnerId,
                projektId: await projektIdFuer(trx, ctx, s.projekt, projekte),
                orgUuid: s.auth_hinweis.org_uuid?.toLowerCase() ?? null,
                authKlasse: 'abo',
                ccVersion: s.cc_version,
                start,
                ende,
              });
              ergebnis.angenommen++;
            }
            for (const s of sitzungenBuendeln(sitzungen))
              await sitzungSpeichern(trx, ctx.mandantId, s);
            await nutzungVermerken(trx, zugang.tokenId, zugang.rechnerId, push.data.agent_version);
          });
          return ergebnis;
        } catch (f) {
          if (antworteBeiDbAusfall(f, antwort)) return antwort;
          throw f;
        }
      },
    );
  });
}
