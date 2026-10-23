// Antwort-Schemas der Dashboard-API (zod) für die Laufzeitprüfung im Client.
//
// Der Vertrag selbst steht in `@seatmeter/shared` (dashboard.ts): Typen wie `Uebersicht` oder
// `ProjektDetail` kommen von dort. Jedes Schema hier ist über `vertrag<T>()` an seinen Vertragstyp
// gebunden: weicht die Ausgabe des Schemas in irgendeine Richtung vom Typ ab (Feld fehlt, Feld zu
// viel, anderer Typ), schlägt `tsc` fehl. Projekte-, Preis-, Sitzkosten-, Rechner- und
// Ingest-Antworten kommen als zod-Schemas direkt aus shared (der Server prüft seine Antworten in den
// Tests mit denselben Schemas; Health in shared `health.ts`). Eigene Typen nur noch für Antworten ohne Gegenstück in shared
// (Mandant, Health, Einmalcode), dort steht der Server als Quelle dabei.
//
// Routen (Beträge in Mikro-USD, ganzzahlig; `monat` = `JJJJ-MM`):
//   GET  /api/v1/uebersicht?monat=        → Uebersicht
//   GET  /api/v1/projekte?monat=          → ProjekteAntwort { monat, auswertungsstufe, projekte }
//                                           (403 `code: 'rolle_fehlt'` nur bei /personen; in
//                                           /projekte/:id stattdessen `personen: null` + Hinweis)
//   GET  /api/v1/projekte/:id?monat=      → ProjektDetail (`:id` = UUID oder `unzugeordnet`)
//   GET  /api/v1/personen?monat=          → PersonenAntwort (`personen: null` + `personen_hinweis`)
//   GET  /api/v1/datenqualitaet?monat=    → Datenqualitaet
//   GET  /api/v1/preise                   → PreiseAntwort { zeilen: PreisDto[] };  POST (PreisEingabe)
//   GET  /api/v1/sitzkosten               → SitzkostenAntwort { zeilen };  PUT (SitzkostenEingabe)
//   GET  /api/v1/rechner                  → RechnerListe { rechner }
//   POST /api/v1/rechner/einmalcode       {bezeichnung?} → Einmalcode
//   POST /api/v1/rechner/:id/widerrufen   → 204
//   GET  /api/v1/auth/me                  → AuthMe (401 = nicht angemeldet, 404 = Modul fehlt)
//   GET  /api/v1/auth/setup               → { noetig }
//   POST /api/v1/auth/setup               {token, login, passwort}
//   POST /api/v1/auth/login               {login, passwort}
//   POST /api/v1/auth/logout              → 204
//   GET  /api/v1/auth/mandant             → Mandant (Spalten der Tabelle `mandant`)
//   GET  /api/health                      → { status, db }
//   GET  /api/health/ingest               → IngestHealth
// Zustandsändernde Anfragen (außer login/setup) brauchen den Header `X-Seatmeter-CSRF` (client.ts);
// Fehler kommen als `{ fehler, code? }` (FehlerCode aus shared, z. B. `csrf`, `rolle_fehlt`).
import {
  rolleSchema,
  type AbdeckungQuellen,
  type AuthAnbieter,
  type AuthMe,
  type Datenqualitaet,
  type Kennzahlen,
  type ModellZeile,
  type PersonenAntwort,
  type PersonenHinweis,
  type PersonZeile,
  type ProjektDetail,
  type ProjektZeile,
  type TagZeile,
  type TokenSummen,
  type Uebersicht,
} from '@seatmeter/shared';
import { z } from 'zod';

export type {
  AbdeckungQuellen,
  AuthAnbieter,
  AuthMe,
  EeStatus,
  Datenqualitaet,
  Kennzahlen,
  ModellZeile,
  PersonenAntwort,
  PersonenHinweis,
  PersonZeile,
  PreisDto,
  PreiseAntwort,
  ProjektDetail,
  ProjekteAntwort,
  ProjektZeile,
  RechnerListe,
  Rolle,
  SitzkostenAntwort,
  SitzkostenEingabe,
  SitzkostenZeile,
  TagZeile,
  TokenSummen,
  Uebersicht,
  FehlerCode,
  IngestHealth,
  IngestQuelleStatus,
  IssueProjektZeile,
  IssuesAntwort,
  IssueZeile,
  ProjektIssuesAntwort,
} from '@seatmeter/shared';
export type { RechnerZeile as Rechner } from '@seatmeter/shared';
export {
  ABRECHNUNGEN,
  ROLLEN,
  SITZ_STANDARDKOSTEN,
  SITZ_TYP_NAMEN,
  SITZ_TYPEN,
  ingestHealthSchema,
  preisDtoSchema,
  preisEingabeSchema,
  rechnerListeSchema,
  rechnerZeileSchema as rechnerSchema,
  sitzkostenEingabeSchema,
  sitzkostenZeileSchema,
} from '@seatmeter/shared';
export {
  issuesAntwortSchema as issuesSchema,
  projektIssuesAntwortSchema as projektIssuesSchema,
  preiseAntwortSchema as preiseSchema,
  projekteAntwortSchema as projekteSchema,
  sitzkostenAntwortSchema as sitzkostenSchema,
} from '@seatmeter/shared';

/** `true`, wenn A und B gegenseitig zuweisbar sind (kein Feld fehlt oder ist zu viel). */
type Gleich<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Bindet ein zod-Schema an einen Vertragstyp: Der Aufruf kompiliert nur, wenn die Ausgabe des
 * Schemas genau dem Typ entspricht (sonst verlangt die Signatur ein zweites Argument).
 */
function vertrag<T>() {
  return <S extends z.ZodType>(
    schema: S,
    ..._abweichung: Gleich<z.output<S>, T> extends true
      ? []
      : [fehler: 'Schema weicht vom Vertragstyp in @seatmeter/shared ab']
  ): z.ZodType<T> => schema as unknown as z.ZodType<T>;
}

/** Ganzzahl; Postgres liefert bigint/numeric mitunter als Text, daher auch numerische Strings. */
const zahl = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);
const monat = z.string().regex(/^\d{4}-\d{2}$/);
const tag = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const personenHinweisSchema = vertrag<PersonenHinweis>()(
  z.enum(['Auswertungsstufe 0', 'zu wenige Personen', 'Rolle ohne Personensicht']),
);

const tokenSummenSchema = vertrag<TokenSummen>()(
  z.object({
    input: zahl,
    output: zahl,
    cache_read: zahl,
    cache_write: zahl,
    cache_write_1h: zahl,
    web_search: zahl,
    gesamt: zahl,
  }),
);

const kennzahlenFelder = {
  tokens: tokenSummenSchema,
  anfragen: zahl,
  schatten_usd_micros: zahl,
};
export const kennzahlenSchema = vertrag<Kennzahlen>()(z.object(kennzahlenFelder));

export const modellZeileSchema = vertrag<ModellZeile>()(
  z.object({ model: z.string(), ...kennzahlenFelder }),
);
export const tagZeileSchema = vertrag<TagZeile>()(z.object({ tag, ...kennzahlenFelder }));

const abdeckungFelder = {
  anfragen: zahl,
  nur_a: zahl,
  nur_b: zahl,
  beide: zahl,
  a_prozent: zahl.nullable(),
  b_prozent: zahl.nullable(),
};
const abdeckungSchema = vertrag<AbdeckungQuellen>()(z.object(abdeckungFelder));

// GET /api/v1/uebersicht
export const uebersichtSchema = vertrag<Uebersicht>()(
  z.object({
    monat,
    ...kennzahlenFelder,
    nach_modell: z.array(modellZeileSchema),
    abdeckung: abdeckungSchema,
    gefiltert: z.object({ api: zahl, fremd_org: zahl, inhalt_verworfen: zahl }),
  }),
);

// GET /api/v1/projekte (Zeile laut shared; `id: null` = Topf „unzugeordnet“)
const projektKopfFelder = {
  id: z.string().nullable(),
  name: z.string(),
  kunde: z.string().nullable(),
  url_norm: z.string().nullable(),
  personen: zahl.nullable(),
  personen_hinweis: personenHinweisSchema.nullable(),
};
export const projektZeileSchema = vertrag<ProjektZeile>()(
  z.object({ ...projektKopfFelder, ...kennzahlenFelder }),
);

/** Pfad-Kennung des Topfs „unzugeordnet“ (Projekt-ID `null`) für Detail-Route und Link. */
export const UNZUGEORDNET = 'unzugeordnet';

export const personZeileSchema = vertrag<PersonZeile>()(
  z.object({
    id: z.string(),
    pseudonym: z.string(),
    klarname: z.object({ email: z.string().nullable(), name: z.string().nullable() }).nullable(),
    ...kennzahlenFelder,
    nach_tag: z.array(tagZeileSchema).optional(),
  }),
);

// GET /api/v1/projekte/:id
export const projektDetailSchema = vertrag<ProjektDetail>()(
  z.object({
    monat,
    projekt: z.object(projektKopfFelder),
    ...kennzahlenFelder,
    nach_modell: z.array(modellZeileSchema),
    nach_tag: z.array(tagZeileSchema),
    auswertungsstufe: zahl,
    personen: z.array(personZeileSchema).nullable(),
    personen_hinweis: personenHinweisSchema.nullable(),
  }),
);

// GET /api/v1/personen
export const personenSchema = vertrag<PersonenAntwort>()(
  z.object({
    monat,
    auswertungsstufe: zahl,
    klarnamen_aktiv: z.boolean(),
    personen: z.array(personZeileSchema).nullable(),
    personen_hinweis: personenHinweisSchema.nullable(),
  }),
);

// GET /api/v1/datenqualitaet
export const datenqualitaetSchema = vertrag<Datenqualitaet>()(
  z.object({
    monat,
    abdeckung: z.object({ ...abdeckungFelder, heuristisch: zahl, abweichung_ab: zahl }),
    unzugeordnet: z.object({ tokens: zahl, anfragen: zahl, tokens_prozent: zahl.nullable() }),
    modelle_ohne_preis: z.array(z.string()),
    ingest: z.array(
      z.object({
        quelle: z.enum(['a', 'b', 'c']),
        angenommen: zahl,
        verworfen_inhalt: zahl,
        verworfen_api: zahl,
        verworfen_fremd_org: zahl,
        unzugeordnet: zahl,
      }),
    ),
    kontrollsumme: z.object({
      sitzungen: zahl,
      sitzungen_abweichend: zahl,
      tokens_kontrolle: zahl,
      tokens_gezaehlt: zahl,
      prozent: zahl.nullable(),
    }),
  }),
);

// GET /api/v1/auth/me
export const authMeSchema = vertrag<AuthMe>()(
  z.object({
    benutzer: z.object({ id: z.string(), benutzername: z.string(), login: z.string() }),
    mandant_id: z.string().nullable(),
    mandant: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    provider: z.string(),
    rollen: z.array(rolleSchema),
    mandanten: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        rollen: z.array(rolleSchema),
      }),
    ),
    csrf: z.string().nullable(),
    ee: z
      .object({
        aktiv: z.boolean(),
        module: z.array(z.string()),
        gueltig_bis: z.string().nullable(),
        warnung: z.string().nullable(),
      })
      .optional(),
    plattform_admin: z.boolean().optional(),
  }),
);

// GET /api/v1/auth/anbieter
export const authAnbieterSchema = vertrag<AuthAnbieter>()(
  z.object({
    anbieter: z.array(
      z.object({ name: z.string(), titel: z.string(), start: z.string().nullable() }),
    ),
    // Nur bei ?email= / ?mandant= (ee, SSO je Mandant); alte Server lassen das Feld weg.
    oidc: z.object({ bezeichnung: z.string(), start_url: z.string() }).nullable().optional(),
  }),
);

// ---------------------------------------------------------------------------------------------
// Antworten ohne Typ in shared (Quelle jeweils der Server; nachsichtig, weil nicht im Vertrag).

const zahlOderNull = zahl.nullish().transform((w) => w ?? null);
const textOderNull = z
  .string()
  .nullish()
  .transform((w) => w ?? null);

// POST /api/v1/rechner/einmalcode
export const einmalcodeSchema = z.looseObject({ code: z.string().min(1), laeuft_ab: z.string() });
export type Einmalcode = z.infer<typeof einmalcodeSchema>;

export const setupStatusSchema = z.looseObject({ noetig: z.boolean() });

// GET /api/v1/auth/mandant (server auth/index.ts: Spalten der Tabelle `mandant`)
export const mandantSchema = z.looseObject({
  name: textOderNull,
  slug: textOderNull,
  plan: textOderNull,
  auswertungsstufe: zahlOderNull,
  klarnamen_aktiv: z
    .boolean()
    .nullish()
    .transform((w) => w ?? null),
  zeitzone: textOderNull,
  waehrung: textOderNull,
  sitzkosten_verteilung: textOderNull,
  aufbewahrung_anfrage_tage: zahlOderNull,
  aufbewahrung_aggregat_monate: zahlOderNull,
  aufbewahrung_abschluss_monate: zahlOderNull,
});
export type Mandant = z.infer<typeof mandantSchema>;

export const healthSchema = z.looseObject({ status: z.string(), db: z.string() });

// ---------------------------------------------------------------------------------------------
// Phase 3 (Kalkulation, Kurs, Einstellungen, Berichte): Vertrag und Schemas direkt aus
// `@seatmeter/shared` (dashboard.ts); der Server liefert dort nur JSON-Zahlen.
//   GET  /api/v1/kalkulation?monat=                       → KalkulationAntwort (403 für betriebsrat)
//   GET  /api/v1/monatsabschluss?monat=                   → Monatsabschluss
//   POST /api/v1/jobs/kalkulation/monatsabschluss?monat=&erzwingen=1 → AbschlussErgebnis
//   GET  /api/v1/kurse                                    → KurseAntwort (neuester Monat zuerst)
//   PUT  /api/v1/kurs?monat=  {usd_eur}                   → Kurs
//   POST /api/v1/jobs/kurs/ezb                            → EzbErgebnis
//   GET/PUT /api/v1/mandant/einstellungen                 → MandantEinstellungen (PUT: nur Änderungen)
//   GET  /api/v1/berichte/projektabrechnung?monat=&format=csv|json
//   GET  /api/v1/berichte/betriebsrat?monat=&format=json|html|csv → BetriebsratBericht (json)
export {
  betriebsratBerichtSchema,
  kalkulationAntwortSchema,
  kurseAntwortSchema,
  kursEingabeSchema,
  kursSchema,
  mandantEinstellungenEingabeSchema,
  mandantEinstellungenSchema,
  monatsabschlussSchema,
  projektabrechnungSchema,
  CACHE_WRITE_ANNAHMEN,
  SITZKOSTEN_VERTEILUNGEN,
  TOEPFE,
  WAEHRUNGEN,
} from '@seatmeter/shared';
export type {
  BetriebsratBericht,
  KalkulationAntwort,
  Kurs,
  KurseAntwort,
  MandantEinstellungen,
  Monatsabschluss,
  Projektabrechnung,
  ProjektpreisZeile,
  SitzkostenVerteilung,
  Topf,
} from '@seatmeter/shared';

// POST /api/v1/jobs/kalkulation/monatsabschluss (server kalkulation)
export const abschlussErgebnisSchema = z.looseObject({
  monat: z.string(),
  status: z.enum(['angelegt', 'vorhanden', 'ueberschrieben']),
  zeilen: zahl,
});
export type AbschlussErgebnis = z.infer<typeof abschlussErgebnisSchema>;

// POST /api/v1/jobs/kurs/ezb (server kalkulation, Job kurs.ezb)
export const ezbErgebnisSchema = z.looseObject({ monate: zahl });

// ---------------------------------------------------------------------------------------------
// Phase 5 (Ausrollen, server ausrollen/index.ts; nur Mandanten-Admins, sonst 403):
//   GET  /api/v1/ausrollen                   → AusrollenKonfiguration (nie mit Token)
//   POST /api/v1/ausrollen/mandanten-token   → 201 MandantenTokenAntwort (Klartext nur einmal)
export {
  AGENT_STANDARD_PFAD,
  ausrollenKonfigurationSchema,
  mandantenTokenAntwortSchema,
} from '@seatmeter/shared';
export type {
  AusrollenKonfiguration,
  AusrollenOrg,
  MandantenTokenAntwort,
} from '@seatmeter/shared';
