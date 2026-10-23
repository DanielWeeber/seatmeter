// Phase 3 Kalkulation (Architektur §3.1 `kurs`, `monatsabschluss`, §5): Kursquelle `ezb`/`manuell` mit
// Kennzeichen „vorläufig“, Monatsabschluss mit Tokens, US-Cent und den Einstellungen des Abschlusses.
// Kurs und EUR-Wert im Abschluss dürfen fehlen (kein Kurs zum Abschlusszeitpunkt). Nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `ALTER TABLE kurs DROP CONSTRAINT IF EXISTS kurs_quelle_check;
       UPDATE kurs SET quelle = 'manuell' WHERE quelle = 'mandant';
       ALTER TABLE kurs ADD CONSTRAINT kurs_quelle_check CHECK (quelle IN ('ezb', 'manuell'));
       ALTER TABLE kurs ADD COLUMN vorlaeufig boolean NOT NULL DEFAULT false;
       ALTER TABLE kurs ADD COLUMN aktualisiert timestamptz NOT NULL DEFAULT now();

       ALTER TABLE monatsabschluss ALTER COLUMN kurs DROP NOT NULL;
       ALTER TABLE monatsabschluss ALTER COLUMN projektpreis_eur_cent DROP NOT NULL;
       ALTER TABLE monatsabschluss ALTER COLUMN projektpreis_eur_cent DROP DEFAULT;
       ALTER TABLE monatsabschluss
         ADD COLUMN projektpreis_usd_cent bigint NOT NULL DEFAULT 0,
         ADD COLUMN input bigint NOT NULL DEFAULT 0,
         ADD COLUMN output bigint NOT NULL DEFAULT 0,
         ADD COLUMN cache_read bigint NOT NULL DEFAULT 0,
         ADD COLUMN cache_write bigint NOT NULL DEFAULT 0,
         ADD COLUMN cache_write_1h bigint NOT NULL DEFAULT 0,
         ADD COLUMN web_search bigint NOT NULL DEFAULT 0,
         ADD COLUMN anfragen bigint NOT NULL DEFAULT 0,
         ADD COLUMN kurs_quelle text CHECK (kurs_quelle IN ('ezb', 'manuell')),
         ADD COLUMN kurs_vorlaeufig boolean NOT NULL DEFAULT false,
         ADD COLUMN sitzkosten_verteilung text CHECK (sitzkosten_verteilung IN ('person', 'gleich', 'pool')),
         ADD COLUMN code_anteil_sitz numeric(6, 4),
         ADD COLUMN schatten_faktor numeric(6, 4),
         ADD COLUMN cache_write_annahme text CHECK (cache_write_annahme IN ('5m', '1h')),
         ADD COLUMN ueberschreitung_abgezogen boolean NOT NULL DEFAULT false,
         ADD COLUMN erzwungen boolean NOT NULL DEFAULT false;`,
    )
    .execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
