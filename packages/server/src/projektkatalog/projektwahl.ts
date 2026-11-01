// Erzwungene Projektwahl: Prüf-Route für den verwalteten Hook (Mandanten- oder Rechner-Token, Antwort als kurzer
// Text, damit der Hook ohne jq auskommt) und die Auswahlseite hinter dem signierten Link (Anmeldung Pflicht).
// Der Hook sendet nie den Prompt. Die erste Wahl gilt; ändern dürfen danach nur Admin und Projektleitung
// (Routen in `routen.ts`). Im Audit steht bei der Wahl kein Konto, damit daraus kein Personenbezug zur Arbeit
// an einem Repo entsteht. Die Prüf-Route schreibt nichts: Wer das für alle lesbare Mandanten-Token hat, kann keine
// Zeilen anlegen. Die normalisierte URL steht signiert im Link, das seatmeter-Projekt entsteht erst bei der Wahl.
import {
  fehlerKoerper,
  kanonischeRepoInfo,
  projektwahlEingabeSchema,
  PROJEKTWAHL_PFAD_PRAEFIX,
  PROJEKTWAHL_PRUEF_PFAD,
  repoInfoAusUrlNorm,
  type KatalogKurz,
  type KatalogStufe,
  type ProjektwahlAntwort,
} from '@seatmeter/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { antwort, sende, type Antwort } from '../antwort.js';
import { protokolliere } from '../audit/protokoll.js';
import { alleRollen, requireAnmeldung } from '../auth/kontext.js';
import { ingestBasis } from '../ausrollen/index.js';
import type { Konfiguration } from '../config.js';
import type { Db } from '../db/db.js';
import { withMandant } from '../db/mandant.js';
import { mandantSaltsLesen } from '../ingest-gemeinsam/geheimnis.js';
import { mandantKontextLaden } from '../ingest-gemeinsam/kontext.js';
import type { IngestRatenlimit } from '../ingest-gemeinsam/ratenlimit.js';
import { projektFinden, projektZuUrlNorm } from '../ingest-gemeinsam/speichern.js';
import { sichererFehlerHandler, zugangsHook, zugangVon } from '../ingest-gemeinsam/zugang.js';
import { projektAnzeigename } from '../issues/routen.js';
import type { PluginKontext } from '../plugin.js';
import { aktiveProjekte, katalogProjektLaden, projekteLaden, type KatalogTrx } from './daten.js';
import { linkTokenErzeugen, linkTokenPruefen, type LinkInhalt } from './link.js';
import { AUDIT_KATALOG } from './audit.js';
import { projektwahlHinderung } from './stufe.js';

/** Körpergrenze der Prüf-Route: nur Sitzungs-ID und Repo-URL. */
const PRUEF_KOERPER_MAX = 4096;

const pruefSchema = z.object({
  sitzung: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  repo: z.string().max(1000).optional(),
});

/** Nur lesen: Projekt-ID zur normalisierten URL; `null`, solange das Repo in seatmeter unbekannt ist. */
async function repoProjektId(
  trx: KatalogTrx,
  masterKey: Buffer,
  mandantId: string,
  urlNorm: string,
): Promise<string | null> {
  const salts = await mandantSaltsLesen(trx, masterKey, mandantId);
  return salts ? projektFinden(trx, mandantId, salts.projektSalt, urlNorm) : null;
}

export interface ProjektwahlPruefOptionen {
  db: Db;
  masterKey: Buffer;
  ratenlimit: IngestRatenlimit;
  /** `SEATMETER_PUBLIC_URL` ist die Basis des Links (Dashboard, nicht der Ingest-Host). */
  konfiguration: Konfiguration;
  env?: NodeJS.ProcessEnv;
}

/** Abstand zwischen zwei Warnungen im Log, wenn die Konfiguration die Projektwahl verhindert. */
const WARNUNG_ABSTAND_MS = 5 * 60_000;

/** `POST /api/ingest/v1/projektwahl`: `frei`, `zugeordnet`, `warnen <link>` oder `waehlen <link>` als Text. */
export async function projektwahlPruefRoute(
  app: FastifyInstance,
  o: ProjektwahlPruefOptionen,
): Promise<void> {
  let zuletztGewarnt = 0;
  await app.register(async (kind) => {
    kind.removeAllContentTypeParsers();
    kind.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: PRUEF_KOERPER_MAX },
      (_a, koerper, fertig) =>
        fertig(null, Object.fromEntries(new URLSearchParams(koerper as string))),
    );
    kind.setErrorHandler(sichererFehlerHandler);
    kind.addHook(
      'onRequest',
      zugangsHook({
        db: o.db,
        typen: ['mandant', 'rechner'],
        ratenlimit: o.ratenlimit,
        gruppe: 'otlp',
        quelle: 'a',
      }),
    );
    kind.post(PROJEKTWAHL_PRUEF_PFAD, async (anfrage, ant) => {
      const e = pruefSchema.safeParse(anfrage.body);
      if (!e.success) return ant.code(400).send({ fehler: 'Anfrage ungültig' });
      const zugang = zugangVon(anfrage);
      // Ist die Stufe schon aktiv und die Konfiguration passt nicht (mehr): niemanden aufhalten und nichts anbieten,
      // was nicht funktioniert oder zu viele Rechte vergibt.
      const hinderung = projektwahlHinderung(o.konfiguration, o.env);
      if (hinderung) {
        const jetzt = Date.now();
        if (jetzt - zuletztGewarnt > WARNUNG_ABSTAND_MS) {
          zuletztGewarnt = jetzt;
          anfrage.log.warn(
            { hinderung },
            'Projektwahl: Konfiguration verhindert sie, Hook lässt durch',
          );
        }
        ant.type('text/plain; charset=utf-8').header('cache-control', 'no-store');
        return 'frei\n';
      }
      let stufe = 'aus' as KatalogStufe;
      const ziel = await withMandant(o.db, zugang.mandantId, async (trx) => {
        const s = await trx.selectFrom('mandant_projektkatalog').select('stufe').executeTakeFirst();
        stufe = s?.stufe ?? 'aus';
        if (stufe === 'aus' || (await aktiveProjekte(trx)) === 0) return { art: 'frei' as const };
        // Repo-Schlüssel wie im Ingest (Alias zuerst), aber nur lesend. Kanonisch, weil der Ingest die `https://`-Form
        // bekommt: Sonst fänden Prüfung und Wahl bei manchen scp-Remotes das Projekt mit der Nutzung nicht.
        const info = e.data.repo?.trim() ? kanonischeRepoInfo(e.data.repo) : null;
        if (info) {
          const projektId = await repoProjektId(trx, o.masterKey, zugang.mandantId, info.urlNorm);
          const zuordnung = projektId
            ? await trx
                .selectFrom('projekt_katalog')
                .select('projekt_id')
                .where('projekt_id', '=', projektId)
                .executeTakeFirst()
            : undefined;
          return zuordnung
            ? { art: 'zugeordnet' as const }
            : { art: 'repo' as const, url: info.urlNorm };
        }
        const z = await trx
          .selectFrom('sitzung_katalog')
          .select('session_id')
          .where('session_id', '=', e.data.sitzung)
          .executeTakeFirst();
        return z ? { art: 'zugeordnet' as const } : { art: 'sitzung' as const };
      });
      ant.type('text/plain; charset=utf-8').header('cache-control', 'no-store');
      if (ziel.art === 'frei' || ziel.art === 'zugeordnet') return `${ziel.art}\n`;
      const token = linkTokenErzeugen(o.masterKey, {
        mandantId: zugang.mandantId,
        ...(ziel.art === 'repo' ? { repoUrl: ziel.url } : { sessionId: e.data.sitzung }),
      });
      const basis = ingestBasis(anfrage, {}, o.konfiguration.SEATMETER_PUBLIC_URL).url;
      const wort = stufe === 'warnen' ? 'warnen' : 'waehlen';
      return `${wort} ${basis}${PROJEKTWAHL_PFAD_PRAEFIX}${token}\n`;
    });
  });
}

/** Link prüfen und Mitgliedschaft im Mandanten des Links; liefert sonst die Fehlerantwort. */
async function linkAuswerten(
  request: FastifyRequest,
  ctx: PluginKontext,
  token: string,
): Promise<{ inhalt: LinkInhalt } | { fehler: Antwort }> {
  const p = linkTokenPruefen(ctx.konfiguration.SEATMETER_MASTER_KEY, token);
  if (p.art === 'ungueltig') {
    return { fehler: antwort(400, fehlerKoerper('link_ungueltig', 'Der Link ist ungültig.')) };
  }
  if (p.art === 'abgelaufen') {
    return {
      fehler: antwort(
        410,
        fehlerKoerper(
          'link_abgelaufen',
          'Der Link ist abgelaufen. Den Prompt erneut senden, dann zeigt Claude Code einen neuen.',
        ),
      ),
    };
  }
  const benutzerId = request.benutzer?.benutzerId;
  const rollen = benutzerId ? await alleRollen(request.server.seatmeterAuth, benutzerId) : [];
  if (!rollen.some((r) => r.mandant_id === p.inhalt.m)) {
    // Der Link ist echt, nur das Konto fehlt: sagen, wer das ändern kann.
    const kontakt = await withMandant(ctx.db, p.inhalt.m, (trx) =>
      trx.selectFrom('mandant_projektkatalog').select('kontakt').executeTakeFirst(),
    );
    const an = kontakt?.kontakt ?? 'die Person, die seatmeter in Ihrer Organisation betreut';
    return {
      fehler: antwort(
        403,
        fehlerKoerper(
          'kein_mitglied',
          `Dieses Konto gehört nicht zu dieser Organisation. Für den Zugang wenden Sie sich bitte an ${an}.`,
        ),
      ),
    };
  }
  return { inhalt: p.inhalt };
}

async function vorhandeneZuordnung(trx: KatalogTrx, masterKey: Buffer, inhalt: LinkInhalt) {
  let id: string | undefined;
  if (inhalt.u) {
    const projektId = await repoProjektId(trx, masterKey, inhalt.m, inhalt.u);
    id = projektId
      ? (
          await trx
            .selectFrom('projekt_katalog')
            .select('katalog_projekt_id')
            .where('projekt_id', '=', projektId)
            .executeTakeFirst()
        )?.katalog_projekt_id
      : undefined;
  } else {
    id = (
      await trx
        .selectFrom('sitzung_katalog')
        .select('katalog_projekt_id')
        .where('session_id', '=', inhalt.s ?? '')
        .executeTakeFirst()
    )?.katalog_projekt_id;
  }
  return id ? katalogProjektLaden(trx, id) : null;
}

const tokenAbfrage = z.object({ token: z.string().min(1).max(4000) });

/** Auswahlseite: jede Rolle im Mandanten des Links, auch die Rolle `entwickler` und ohne aktiven Mandanten. */
export function projektwahlRouten(app: FastifyInstance, ctx: PluginKontext) {
  const { db } = ctx;
  const masterKey = ctx.konfiguration.SEATMETER_MASTER_KEY;

  app.get('/api/v1/projektwahl', { preHandler: requireAnmeldung }, async (request, reply) => {
    const q = tokenAbfrage.safeParse(request.query);
    if (!q.success) return reply.code(400).send(fehlerKoerper('link_ungueltig', 'Link fehlt.'));
    const link = await linkAuswerten(request, ctx, q.data.token);
    if ('fehler' in link) return sende(reply, link.fehler);
    const { inhalt } = link;
    const r = await withMandant(db, inhalt.m, async (trx) => {
      let ziel: ProjektwahlAntwort['ziel'] = { art: 'sitzung' };
      if (inhalt.u) {
        const projektId = await repoProjektId(trx, masterKey, inhalt.m, inhalt.u);
        const p = projektId
          ? await trx
              .selectFrom('projekt')
              .select(['id', 'anzeigename', 'repo_name', 'owner', 'url_norm'])
              .where('id', '=', projektId)
              .executeTakeFirst()
          : undefined;
        const info = repoInfoAusUrlNorm(inhalt.u);
        ziel = {
          art: 'repo',
          name: projektAnzeigename(
            p ?? {
              id: '',
              anzeigename: null,
              repo_name: info?.repoName ?? null,
              owner: info?.owner ?? null,
              url_norm: inhalt.u,
            },
          ),
        };
      }
      const projekte: KatalogKurz[] = (await projekteLaden(trx, true)).map((p) => ({
        id: p.id,
        externe_id: p.externe_id,
        nummer: p.nummer,
        name: p.name,
        pfad: p.pfad,
        parent_externe_id: p.parent_externe_id,
        kunde: p.kunde,
        aktiv: p.aktiv,
      }));
      const koerper: ProjektwahlAntwort = {
        ziel,
        gueltig_bis: new Date(inhalt.e * 1000).toISOString(),
        projekte,
        zugeordnet: await vorhandeneZuordnung(trx, masterKey, inhalt),
      };
      return antwort(200, koerper);
    });
    return sende(reply.header('cache-control', 'no-store'), r);
  });

  app.post('/api/v1/projektwahl', { preHandler: requireAnmeldung }, async (request, reply) => {
    const e = projektwahlEingabeSchema.safeParse(request.body);
    if (!e.success) return reply.code(400).send({ fehler: 'Eingabe ungültig.' });
    const link = await linkAuswerten(request, ctx, e.data.token);
    if ('fehler' in link) return sende(reply, link.fehler);
    const { inhalt } = link;
    const r = await withMandant(db, inhalt.m, async (trx) => {
      const k = await katalogProjektLaden(trx, e.data.katalog_projekt_id);
      if (!k?.aktiv) return antwort(400, { fehler: 'Projekt nicht in der Liste.' });
      // Das Repo wird erst hier zum seatmeter-Projekt. Schlüssel genau aus der signierten URL, ohne sie noch einmal zu
      // normalisieren: Die Prüf-Route liest denselben, sonst bliebe das Repo trotz Wahl gesperrt.
      let projektId: string | null = null;
      if (inhalt.u) {
        const kontext = await mandantKontextLaden(trx, masterKey, inhalt.m);
        projektId = await projektZuUrlNorm(trx, kontext, inhalt.u);
        if (!projektId) return antwort(400, { fehler: 'Repo nicht erkannt.' });
      }
      // Erste Wahl gewinnt, auch bei gleichzeitigen Anfragen (ON CONFLICT DO NOTHING).
      const neu = projektId
        ? await trx
            .insertInto('projekt_katalog')
            .values({ mandant_id: inhalt.m, projekt_id: projektId, katalog_projekt_id: k.id })
            .onConflict((oc) => oc.column('projekt_id').doNothing())
            .returning('projekt_id as id')
            .executeTakeFirst()
        : await trx
            .insertInto('sitzung_katalog')
            .values({ mandant_id: inhalt.m, session_id: inhalt.s ?? '', katalog_projekt_id: k.id })
            .onConflict((oc) => oc.columns(['mandant_id', 'session_id']).doNothing())
            .returning('session_id as id')
            .executeTakeFirst();
      if (!neu) {
        return antwort(409, {
          ...fehlerKoerper(
            'bereits_zugeordnet',
            'Schon zugeordnet; ändern dürfen Admin und Projektleitung.',
          ),
          zugeordnet: await vorhandeneZuordnung(trx, masterKey, inhalt),
        });
      }
      await protokolliere(trx, {
        benutzerId: null,
        aktion: AUDIT_KATALOG.projektGewaehlt,
        objekt: `${projektId ? `projekt:${projektId}` : 'sitzung ohne Repo'} katalog:${k.externe_id}`,
      });
      return antwort(200, { zugeordnet: k });
    });
    return sende(reply, r);
  });
}
