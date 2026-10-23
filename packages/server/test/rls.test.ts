import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { erstelleDb, type Db } from '../src/db/db.js';
import { withMandant } from '../src/db/mandant.js';

describe('Row-Level-Security: Mandant A sieht nichts von B (Architektur §6)', () => {
  let db: Db;
  const a = randomUUID();
  const b = randomUUID();
  const personA = randomUUID();

  beforeAll(async () => {
    db = erstelleDb(inject('testDatenbankUrl'), 4);
    // Testdaten als Eigentümer anlegen (umgeht RLS).
    await db
      .insertInto('mandant')
      .values([
        { id: a, name: 'Mandant A', slug: `a-${a}` },
        { id: b, name: 'Mandant B', slug: `b-${b}` },
      ])
      .execute();
    await db
      .insertInto('person')
      .values({ id: personA, mandant_id: a, pseudonym: 'P-AAAAAA', key_konto: randomBytes(32) })
      .execute();
    await db
      .insertInto('anfrage')
      .values({
        mandant_id: a,
        anfrage_key: `req_${randomUUID()}`,
        ts: new Date(),
        tag: new Date().toISOString().slice(0, 10),
        model: 'claude-opus-5-5',
        input: 10,
        output: 20,
        cache_read: 0,
        cache_write: 0,
      })
      .execute();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('Zeile von A ist mit app.mandant_id = B unsichtbar', async () => {
    const alsB = await withMandant(db, b, (trx) =>
      trx.selectFrom('person').select('id').where('id', '=', personA).execute(),
    );
    expect(alsB).toEqual([]);
    const alsA = await withMandant(db, a, (trx) =>
      trx.selectFrom('person').select('id').where('id', '=', personA).execute(),
    );
    expect(alsA).toEqual([{ id: personA }]);
  });

  it('gilt auch für die partitionierte Tabelle anfrage', async () => {
    const zaehle = (m: string) =>
      withMandant(db, m, (trx) =>
        trx
          .selectFrom('anfrage')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .executeTakeFirstOrThrow(),
      );
    expect(Number((await zaehle(b)).n)).toBe(0);
    expect(Number((await zaehle(a)).n)).toBe(1);
  });

  it('mandant zeigt nur den eigenen Datensatz', async () => {
    const zeilen = await withMandant(db, b, (trx) =>
      trx.selectFrom('mandant').select('id').execute(),
    );
    expect(zeilen).toEqual([{ id: b }]);
  });

  it('B kann keine Zeile für A schreiben', async () => {
    await expect(
      withMandant(db, b, (trx) =>
        trx
          .insertInto('person')
          .values({ mandant_id: a, pseudonym: 'P-BBBBBB', key_konto: randomBytes(32) })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('ohne Mandant ist nichts sichtbar', async () => {
    const zeilen = await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE seatmeter_app`.execute(trx);
      return trx.selectFrom('person').select('id').execute();
    });
    expect(zeilen).toEqual([]);
  });

  it('Partitionen sind für die Anwendungsrolle nicht direkt lesbar', async () => {
    const partition = `anfrage_${new Date().getUTCFullYear()}_${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(
      withMandant(db, a, (trx) => sql.raw(`SELECT count(*) FROM ${partition}`).execute(trx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('globale Preise sind lesbar, aber nicht änderbar', async () => {
    await db
      .insertInto('preis')
      .values({
        mandant_id: null,
        modell_praefix: `test-${a}`,
        gueltig_ab: '2026-01-01',
        input: 1,
        output: 1,
        cache_read: 1,
        cache_write_5m: 1,
        cache_write_1h: 1,
        quelle_url: 'https://example.org',
        geprueft_am: '2026-10-22',
      })
      .execute();
    const gelesen = await withMandant(db, b, (trx) =>
      trx
        .selectFrom('preis')
        .select('modell_praefix')
        .where('modell_praefix', '=', `test-${a}`)
        .execute(),
    );
    expect(gelesen).toHaveLength(1);
    const geaendert = await withMandant(db, b, (trx) =>
      trx
        .updateTable('preis')
        .set({ input: 99 })
        .where('modell_praefix', '=', `test-${a}`)
        .executeTakeFirst(),
    );
    expect(Number(geaendert.numUpdatedRows)).toBe(0);
  });

  it('withMandant lehnt ungültige Mandanten-IDs ab', async () => {
    await expect(withMandant(db, "x'; DROP TABLE person; --", async () => 1)).rejects.toThrow();
  });
});
