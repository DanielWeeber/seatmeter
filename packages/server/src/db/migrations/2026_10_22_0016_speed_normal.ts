// Ein Wert für „kein Fast-Modus“ (Phase-1c-Nacharbeit): Quelle A meldet `normal`, die Transkripte von
// Quelle B `standard`. Seit dieser Migration bildet der Ingest `standard` auf `normal` ab
// (`normalisiereSpeed` in shared); hier werden die schon gespeicherten Zeilen angeglichen.
// `tag_aggregat`: `standard`-Zeilen werden in die `normal`-Zeile desselben Schlüssels eingerechnet
// (wie die Zusammenfassung ohne Person im Modul aufbewahrung). Wiederholbar, nur vorwärts.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE anfrage SET speed = 'normal' WHERE speed = 'standard'`.execute(db);
  await sql`
    INSERT INTO tag_aggregat (mandant_id, tag, person_id, projekt_id, model, speed, auth_klasse,
      input, output, cache_read, cache_write, cache_write_1h, web_search, anfragen,
      schatten_usd_micros, preis_version, abo_anteil)
    SELECT mandant_id, tag, person_id, projekt_id, model, 'normal', auth_klasse,
      input, output, cache_read, cache_write, cache_write_1h, web_search, anfragen,
      schatten_usd_micros, preis_version, abo_anteil
    FROM tag_aggregat WHERE speed = 'standard'
    ON CONFLICT (mandant_id, tag, person_id, projekt_id, model, speed, auth_klasse) DO UPDATE SET
      input = tag_aggregat.input + excluded.input,
      output = tag_aggregat.output + excluded.output,
      cache_read = tag_aggregat.cache_read + excluded.cache_read,
      cache_write = tag_aggregat.cache_write + excluded.cache_write,
      cache_write_1h = tag_aggregat.cache_write_1h + excluded.cache_write_1h,
      web_search = tag_aggregat.web_search + excluded.web_search,
      anfragen = tag_aggregat.anfragen + excluded.anfragen,
      schatten_usd_micros = tag_aggregat.schatten_usd_micros + excluded.schatten_usd_micros,
      preis_version = coalesce(tag_aggregat.preis_version, excluded.preis_version)`.execute(db);
  await sql`DELETE FROM tag_aggregat WHERE speed = 'standard'`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error('Migrationen laufen nur vorwärts (Architektur §9); Rückweg = Restore.');
}
