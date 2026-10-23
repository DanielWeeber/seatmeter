// Konfiguration aus der Umgebung, mit zod geprüft. Werte werden nie geloggt.
import { ROLLEN } from '@seatmeter/shared';
import { z } from 'zod';

/** Leere Umgebungsvariablen gelten als nicht gesetzt. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((wert) => (wert === '' ? undefined : wert), schema.optional());

const masterKey = z
  .string()
  .min(1)
  .transform((wert, ctx) => {
    const hex = /^[0-9a-f]{64}$/i.test(wert);
    const bytes = Buffer.from(wert, hex ? 'hex' : 'base64');
    if (bytes.length !== 32) {
      ctx.addIssue({
        code: 'custom',
        message: 'SEATMETER_MASTER_KEY muss 32 Byte haben (Base64 oder Hex)',
      });
      return z.NEVER;
    }
    return bytes;
  });

/** Ratenlimit als Token-Bucket: `proMinute` = Dauerrate, `stoss` = Kapazität (so viele Anfragen am Stück). */
export interface Grenze {
  proMinute: number;
  stoss: number;
}

/** Liest `<anfragen_pro_minute>/<stoss>` (z. B. `300/60`) oder nur `<anfragen_pro_minute>` (Stoß = Minutenwert). */
export function grenzeLesen(text: string): Grenze | null {
  const t = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)\s*)?$/.exec(text);
  if (!t) return null;
  const proMinute = Number(t[1]);
  const stoss = t[2] === undefined ? Math.max(1, Math.round(proMinute)) : Number(t[2]);
  if (!(proMinute > 0) || proMinute > 1_000_000 || stoss < 1 || stoss > 1_000_000) return null;
  return { proMinute, stoss };
}

const grenze = (standard: string) =>
  z
    .preprocess((wert) => (wert === '' ? undefined : wert), z.string().default(standard))
    .transform((wert, ctx) => {
      const g = grenzeLesen(wert);
      if (!g) {
        ctx.addIssue({
          code: 'custom',
          message: 'Ratenlimit als <anfragen_pro_minute>/<stoss>, z. B. 300/60',
        });
        return z.NEVER;
      }
      return g;
    });

/**
 * `SEATMETER_TRUST_PROXY`: leer/`aus` = Client-IP ist die Socket-Adresse; Zahl = so vielen Proxy-Stufen
 * vertrauen (X-Forwarded-For); sonst kommagetrennte IPs/CIDRs der vertrauenswürdigen Proxys.
 */
const trustProxy = z
  .preprocess(
    (wert) => (wert === '' || wert === undefined ? 'aus' : wert),
    z.string().trim().min(1),
  )
  .transform((wert, ctx): false | number | string[] => {
    if (['aus', 'false', '0', 'nein'].includes(wert.toLowerCase())) return false;
    if (/^\d+$/.test(wert)) {
      const n = Number(wert);
      if (n >= 1 && n <= 10) return n;
    } else {
      const liste = wert
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const ipOderCidr = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)(\/\d{1,3})?$/i;
      if (liste.length > 0 && liste.every((t) => ipOderCidr.test(t))) return liste;
    }
    ctx.addIssue({
      code: 'custom',
      message: 'SEATMETER_TRUST_PROXY: aus, Anzahl der Proxy-Stufen (1–10) oder IPs/CIDRs',
    });
    return z.NEVER;
  });

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

/** Ziel einer OIDC-Gruppe: Rolle in einem Mandanten (per Slug) oder Plattform-Admin (wirkt nur mit ee). */
export const gruppenZielSchema = z.union([
  z.strictObject({
    mandant: slug,
    rolle: z.enum(ROLLEN),
    projekt_ids: z.array(z.uuid()).optional(),
  }),
  z.strictObject({ plattform_admin: z.literal(true) }),
]);
export type GruppenZiel = z.output<typeof gruppenZielSchema>;

/** `SEATMETER_OIDC_GRUPPEN`: `{ "<gruppe>": Ziel | Ziel[] }`. */
export const gruppenSchema = z.record(
  z.string().min(1),
  z
    .union([gruppenZielSchema, z.array(gruppenZielSchema)])
    .transform((z) => (Array.isArray(z) ? z : [z])),
);
export type GruppenZuordnung = z.output<typeof gruppenSchema>;

const gruppenJson = z.string().transform((text, ctx) => {
  let roh: unknown;
  try {
    roh = JSON.parse(text);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'kein gültiges JSON' });
    return z.NEVER;
  }
  const g = gruppenSchema.safeParse(roh);
  if (!g.success) {
    ctx.addIssue({
      code: 'custom',
      message: 'Aufbau { "<gruppe>": { mandant, rolle } | { plattform_admin: true } }',
    });
    return z.NEVER;
  }
  return g.data;
});

export const konfigurationSchema = z.object({
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL muss eine postgres://-URL sein'),
  SEATMETER_MASTER_KEY: masterKey,
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Optional: Verzeichnis mit dem Dashboard-Build (`packages/web/dist`); dann liefert der Server die SPA aus. */
  SEATMETER_WEB_DIST: z.string().min(1).optional(),
  /** Optional: kommagetrennte Modulnamen von Plugins (z. B. `@seatmeter/ee-server`). */
  SEATMETER_PLUGINS: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
    ),
  /** Öffentliche Dashboard-URL; bei https bekommen die Cookies `Secure`. */
  SEATMETER_PUBLIC_URL: optional(z.url()),
  /** Einrichtungs-Token vorgeben (sonst erzeugt der Server eins und schreibt es einmal ins Log). */
  SEATMETER_SETUP_TOKEN: optional(z.string().min(16).max(200)),
  /** Lebensdauer einer Dashboard-Sitzung in Stunden. */
  SEATMETER_SITZUNG_STUNDEN: z.coerce.number().int().min(1).max(720).default(12),
  /**
   * Nur hinter einem vertrauenswürdigen Proxy (z. B. Caddy forward_auth + Authelia), der diesen
   * Header von Clients entfernt: meldet den Benutzer mit gleichem Benutzernamen automatisch an.
   */
  SEATMETER_TRUST_REMOTE_USER_HEADER: optional(
    z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .transform((s) => s.toLowerCase()),
  ),
  /** Rolle für Benutzer, die der Header-Modus neu anlegt. */
  SEATMETER_AUTO_ROLLE: z.enum(ROLLEN).default('mandanten_admin'),
  /** Mandanten-slug für neu angelegte Header-Benutzer (Standard: der einzige Mandant). */
  SEATMETER_AUTO_MANDANT: optional(z.string().min(1).max(63)),
  /** `aus` schaltet den Job-Planer ab (z. B. für zusätzliche Instanzen). */
  SEATMETER_JOBS: z.enum(['an', 'aus']).default('an'),
  /** Client-IP hinter einem Reverse-Proxy aus X-Forwarded-For (sonst Socket-Adresse). */
  SEATMETER_TRUST_PROXY: trustProxy,
  // Ratenlimits der Ingest-Pfade (/otlp/v1/*, /api/ingest/v1/*, /api/agent/v1/*), je Prozess im Speicher.
  /** Je Token auf `/otlp/v1/*` (je Mandant überschreibbar: `ratenlimit_otlp`). */
  SEATMETER_RATE_OTLP: grenze('3000/300'),
  /** Je Rechner auf `/api/ingest/v1/*` und `/api/agent/v1/{config,heartbeat}` (je Mandant: `ratenlimit_agent`). */
  SEATMETER_RATE_AGENT: grenze('300/60'),
  /** Je Client-IP über alle Ingest-Pfade, vor der Token-Prüfung. */
  SEATMETER_RATE_IP: grenze('12000/1200'),
  /** Je Client-IP: Anfragen ohne gültiges Token; ist der Vorrat leer, gibt es 429 ohne DB-Abfrage. */
  SEATMETER_RATE_FEHLVERSUCHE: grenze('30/30'),
  /** Je Client-IP: jeder Versuch auf `POST /api/agent/v1/enroll`. */
  SEATMETER_RATE_ENROLL: grenze('10/10'),
  /** Je Client-IP: falsche, abgelaufene oder genutzte Einmalcodes (Brute-Force-Schutz). */
  SEATMETER_RATE_ENROLL_FEHLVERSUCHE: grenze('1/5'),
  /** Abgleich: Basis-URL der Analytics API (Standard api.anthropic.com; nur für Tests oder einen Proxy). */
  SEATMETER_ANALYTICS_URL: optional(z.url()),
  /** OIDC (globaler Anbieter des Betreibers, Referenz Authelia): Issuer-URL für die Discovery. */
  SEATMETER_OIDC_ISSUER: optional(z.url()),
  SEATMETER_OIDC_CLIENT_ID: optional(z.string().min(1).max(200)),
  SEATMETER_OIDC_CLIENT_SECRET: optional(z.string().min(1).max(500)),
  /** Rückruf-URL; Standard: SEATMETER_PUBLIC_URL + /api/v1/auth/oidc/callback (auch für SSO je Mandant). */
  SEATMETER_OIDC_REDIRECT_URI: optional(z.url()),
  SEATMETER_OIDC_SCOPES: z.string().default('openid profile email groups'),
  /** Name im Anmeldeknopf: „Mit <Bezeichnung> anmelden“. */
  SEATMETER_OIDC_BEZEICHNUNG: z.string().min(1).max(60).default('SSO'),
  /** Gruppen → Rollen (JSON); ohne Angabe bleiben Rollen beim Login unverändert. */
  SEATMETER_OIDC_GRUPPEN: optional(gruppenJson),
  /**
   * Jira: http und Ziele im internen Netz (privat, Loopback, Link-Local) erlauben, z. B. für ein Jira Data
   * Center im Firmennetz bei Selbstbetrieb. Standard aus (Schutz vor Anfragen ins Betreibernetz).
   */
  SEATMETER_JIRA_INTERN_ERLAUBT: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((w) => w === '1' || w === 'true'),
});

export type Konfiguration = z.output<typeof konfigurationSchema>;

export function ladeKonfiguration(env: NodeJS.ProcessEnv = process.env): Konfiguration {
  const ergebnis = konfigurationSchema.safeParse(env);
  if (!ergebnis.success) {
    // Nur Feldnamen und Meldungen ausgeben, nie Werte.
    const fehler = ergebnis.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Ungültige Konfiguration: ${fehler}`);
  }
  return ergebnis.data;
}
