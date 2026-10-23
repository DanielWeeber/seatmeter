// Job-Planer im Prozess (Architektur §2.3 „Jobs“): Jobs aus allen Modulen und Plugins
// (`SeatmeterPlugin.jobs`) laufen nach Cron-Ausdruck (UTC). Ein Advisory-Lock je Job verhindert
// doppelte Läufe bei mehreren Instanzen; jeder Lauf steht in `job_lauf` (nur Zähler, keine Inhalte).
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import type { JobDefinition, PluginKontext } from '../plugin.js';
import { parseCron, passt, type Cron } from './cron.js';

export { parseCron, passt } from './cron.js';

export type Ausloeser = 'plan' | 'einmal' | 'api';

export interface LaufErgebnis {
  status: 'ok' | 'fehler' | 'uebersprungen';
  ergebnis?: unknown;
  fehler?: string;
}

/**
 * Führt `fn` unter dem Advisory-Lock des Jobs aus und protokolliert den Lauf in `job_lauf`.
 * Läuft derselbe Job schon (auch in einer anderen Instanz), ist das Ergebnis `uebersprungen`.
 */
export async function imJobLauf(
  ctx: PluginKontext,
  name: string,
  ausloeser: Ausloeser,
  fn: () => Promise<unknown>,
): Promise<LaufErgebnis> {
  const { db } = ctx;
  return db.connection().execute(async (verbindung) => {
    const schluessel = `seatmeter:job:${name}`;
    const lock = await sql<{
      ok: boolean;
    }>`SELECT pg_try_advisory_lock(hashtext(${schluessel})) AS ok`.execute(verbindung);
    if (!lock.rows[0]?.ok) {
      await db
        .insertInto('job_lauf')
        .values({ job: name, ausloeser, status: 'uebersprungen', beendet: new Date() })
        .execute();
      return { status: 'uebersprungen' };
    }
    const lauf = await db
      .insertInto('job_lauf')
      .values({ job: name, ausloeser })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      const ergebnis = await fn();
      await db
        .updateTable('job_lauf')
        .set({
          status: 'ok',
          beendet: new Date(),
          ergebnis: JSON.stringify(ergebnis ?? null),
        })
        .where('id', '=', lauf.id)
        .execute();
      return { status: 'ok', ergebnis };
    } catch (fehler) {
      const meldung = fehler instanceof Error ? fehler.message : String(fehler);
      await db
        .updateTable('job_lauf')
        .set({ status: 'fehler', beendet: new Date(), fehler: meldung.slice(0, 2000) })
        .where('id', '=', lauf.id)
        .execute();
      return { status: 'fehler', fehler: meldung };
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext(${schluessel}))`.execute(verbindung);
    }
  });
}

/** Führt einen registrierten Job einmal aus (CLI `--einmal <job>`, Tests). */
export async function fuehreJobAus(
  jobs: readonly JobDefinition[],
  name: string,
  ctx: PluginKontext,
  ausloeser: Ausloeser = 'einmal',
): Promise<LaufErgebnis> {
  const job = jobs.find((j) => j.name === name);
  if (!job) {
    throw new Error(`Unbekannter Job ${name}; vorhanden: ${jobs.map((j) => j.name).join(', ')}`);
  }
  return imJobLauf(ctx, name, ausloeser, () => job.ausfuehren(ctx));
}

/** Planer: prüft zu jeder vollen Minute (UTC), welche Jobs fällig sind. */
export class JobPlaner {
  private timer: NodeJS.Timeout | null = null;
  private readonly laufend = new Map<string, Promise<unknown>>();
  private readonly plan: { job: JobDefinition; cron: Cron }[];

  constructor(
    jobs: readonly JobDefinition[],
    private readonly ctx: PluginKontext,
    private readonly log: FastifyBaseLogger,
  ) {
    const namen = new Set<string>();
    this.plan = jobs.map((job) => {
      if (namen.has(job.name)) throw new Error(`Job doppelt registriert: ${job.name}`);
      namen.add(job.name);
      return { job, cron: parseCron(job.zeitplan) };
    });
  }

  start(): void {
    this.log.info(
      { jobs: this.plan.map((p) => `${p.job.name} (${p.cron.ausdruck})`) },
      'Job-Planer gestartet',
    );
    this.planeNaechsteMinute();
  }

  private planeNaechsteMinute(): void {
    const jetzt = Date.now();
    const naechste = Math.floor(jetzt / 60_000) * 60_000 + 60_000;
    this.timer = setTimeout(() => this.tick(new Date(naechste)), naechste - jetzt + 50);
    this.timer.unref();
  }

  /** Startet alle zur Minute `zeit` fälligen Jobs (öffentlich für Tests). */
  tick(zeit: Date): string[] {
    const gestartet: string[] = [];
    for (const { job, cron } of this.plan) {
      if (!passt(cron, zeit) || this.laufend.has(job.name)) continue;
      gestartet.push(job.name);
      const lauf = imJobLauf(this.ctx, job.name, 'plan', () => job.ausfuehren(this.ctx))
        .then((e) => {
          if (e.status === 'fehler')
            this.log.error({ job: job.name, fehler: e.fehler }, 'Job fehlgeschlagen');
          else this.log.info({ job: job.name, status: e.status }, 'Job beendet');
        })
        .catch((fehler: unknown) =>
          this.log.error({ job: job.name, fehler: String(fehler) }, 'Job-Lauf abgebrochen'),
        )
        .finally(() => this.laufend.delete(job.name));
      this.laufend.set(job.name, lauf);
    }
    if (this.timer !== null) this.planeNaechsteMinute();
    return gestartet;
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.laufend.values()]);
  }
}
