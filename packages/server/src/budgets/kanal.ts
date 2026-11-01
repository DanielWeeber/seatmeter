// Alarmkanäle: Webhook (JSON-POST, optional Bearer), SMTP (nodemailer) und die Vorlage
// `weeberwrk-relay` (Alarm-Relay von weeberwrk, Route `/dm` oder `/alert`, Header `X-Relay-Token`).
// Geheimnisse liegen verschlüsselt in `alarm_kanal.geheimnis` (AAD `alarm_kanal.geheimnis`) und erscheinen
// nie in Antworten, Logs oder Fehlertexten. Entwarnungen gibt es nicht: ein quittierter Alarm bleibt still.
import {
  relayKonfigSchema,
  smtpKonfigSchema,
  webhookKonfigSchema,
  type Kanal,
  type KanalTyp,
} from '@seatmeter/shared';
import { entschluessele, verschluessele } from '../krypto.js';
import nodemailer from 'nodemailer';
import type { z } from 'zod';
import type { Transaction } from 'kysely';
import type { Datenbank } from '../db/schema.js';

export const AAD_KANAL = 'alarm_kanal.geheimnis';
const ZEITLIMIT_MS = 10_000;

export type FetchFunktion = (url: string, init?: RequestInit) => Promise<Response>;

/** Minimaler SMTP-Versand (nodemailer-kompatibel), für Tests ersetzbar. */
export interface SmtpVersand {
  sendMail(mail: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
}
export type SmtpFabrik = (
  k: z.output<typeof smtpKonfigSchema>,
  passwort: string | null,
) => SmtpVersand;

export const nodemailerFabrik: SmtpFabrik = (k, passwort) =>
  nodemailer.createTransport({
    host: k.host,
    port: k.port,
    secure: k.secure,
    ...(k.benutzer ? { auth: { user: k.benutzer, pass: passwort ?? '' } } : {}),
    connectionTimeout: ZEITLIMIT_MS,
    greetingTimeout: ZEITLIMIT_MS,
    socketTimeout: ZEITLIMIT_MS,
  });

export interface ZustellOptionen {
  fetch?: FetchFunktion;
  smtp?: SmtpFabrik;
}

/** Inhalt eines Alarms für alle Kanäle (ohne Personendaten). */
export interface AlarmNachricht {
  /** Stabiler Schlüssel je Budget, Monat und Schwelle (Relay `/alert`: ein Vorfall je Schlüssel). */
  schluessel: string;
  /** Ereignisname am Webhook; Standard `seatmeter.budget_alarm`. */
  ereignis?: string;
  titel: string;
  zeilen: string[];
  link: string | null;
  daten: Record<string, unknown>;
  test?: boolean;
}

export interface KanalDaten {
  id: string;
  typ: KanalTyp;
  bezeichnung: string;
  konfig: unknown;
  geheimnis: string | null;
}

export class ZustellFehler extends Error {}

function zeitlimit(): AbortSignal {
  return AbortSignal.timeout(ZEITLIMIT_MS);
}

async function posten(
  f: FetchFunktion,
  url: string,
  koerper: unknown,
  header: Record<string, string>,
): Promise<void> {
  let antwort: Response;
  try {
    antwort = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...header },
      body: JSON.stringify(koerper),
      signal: zeitlimit(),
    });
  } catch (fehler) {
    const art =
      fehler instanceof Error && fehler.name === 'TimeoutError'
        ? 'Zeitüberschreitung'
        : 'nicht erreichbar';
    throw new ZustellFehler(`Ziel ${art}`);
  }
  if (!antwort.ok) throw new ZustellFehler(`Ziel antwortet mit HTTP ${antwort.status}`);
}

/** Markdown-Text im Zulip-Format: Kopfzeile als Link, darunter Stichpunkte (keine Satzzeichen nach URLs). */
export function relayText(n: AlarmNachricht): string {
  const kopf = n.link ? `[seatmeter (${n.titel})](${n.link})` : `seatmeter (${n.titel})`;
  return [kopf, ...n.zeilen.map((z) => `- ${z}`)].join('\n');
}

/** Stellt eine Nachricht über einen Kanal zu; wirft `ZustellFehler` mit einem Text ohne Geheimnisse. */
export async function zustellen(
  kanal: KanalDaten,
  n: AlarmNachricht,
  o: ZustellOptionen = {},
): Promise<string> {
  const f = o.fetch ?? fetch;
  switch (kanal.typ) {
    case 'webhook': {
      const k = webhookKonfigSchema.parse(kanal.konfig);
      await posten(
        f,
        k.url,
        {
          ereignis: n.test ? 'seatmeter.test' : (n.ereignis ?? 'seatmeter.budget_alarm'),
          titel: n.titel,
          text: n.zeilen.join('\n'),
          link: n.link,
          schluessel: n.schluessel,
          ...n.daten,
        },
        kanal.geheimnis ? { authorization: `Bearer ${kanal.geheimnis}` } : {},
      );
      return 'Webhook zugestellt';
    }
    case 'weeberwrk-relay': {
      const k = relayKonfigSchema.parse(kanal.konfig);
      if (!kanal.geheimnis) throw new ZustellFehler('Relay-Token fehlt');
      const basis = k.url.replace(/\/+$/, '');
      const bot = k.bot ? { bot: k.bot } : {};
      const koerper =
        k.pfad === '/dm'
          ? { text: relayText(n), prio: k.prio, ...bot, ...(n.test ? { test: true } : {}) }
          : {
              key: n.schluessel,
              titel: `seatmeter – ${n.titel}`,
              fehler: n.zeilen.join('; '),
              link: n.link ?? undefined,
              prio: k.prio,
              topic: 'seatmeter',
              ttl_min: 1440,
              ttl_aktion: 'expire',
              ...bot,
            };
      await posten(f, `${basis}${k.pfad}`, koerper, { 'x-relay-token': kanal.geheimnis });
      return n.test && k.pfad === '/dm'
        ? 'Relay erreicht (Testmodus, keine Nachricht)'
        : 'Relay zugestellt';
    }
    case 'smtp': {
      const k = smtpKonfigSchema.parse(kanal.konfig);
      const versand = (o.smtp ?? nodemailerFabrik)(k, kanal.geheimnis);
      try {
        await versand.sendMail({
          from: k.von,
          to: k.an,
          subject: `seatmeter: ${n.titel}`,
          text: [...n.zeilen, ...(n.link ? ['', n.link] : [])].join('\n'),
        });
      } catch (fehler) {
        const code =
          typeof fehler === 'object' && fehler !== null && 'code' in fehler
            ? String((fehler as { code: unknown }).code)
            : 'unbekannt';
        throw new ZustellFehler(`SMTP-Versand fehlgeschlagen (${code})`);
      }
      return 'E-Mail versendet';
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Speicherung

type KanalZeile = {
  id: string;
  typ: KanalTyp;
  bezeichnung: string;
  aktiv: boolean;
  konfig: unknown;
  geheimnis: Buffer | null;
  erstellt: Date;
  geaendert: Date;
};

export function kanalDto(z: KanalZeile): Kanal {
  return {
    id: z.id,
    typ: z.typ,
    bezeichnung: z.bezeichnung,
    aktiv: z.aktiv,
    konfig: (z.konfig ?? {}) as Record<string, unknown>,
    geheimnis_gesetzt: z.geheimnis !== null,
    erstellt: new Date(z.erstellt).toISOString(),
    geaendert: new Date(z.geaendert).toISOString(),
  };
}

export async function ladeKanaele(
  trx: Transaction<Datenbank>,
  nurAktiv = false,
): Promise<KanalZeile[]> {
  let q = trx
    .selectFrom('alarm_kanal')
    .select(['id', 'typ', 'bezeichnung', 'aktiv', 'konfig', 'geheimnis', 'erstellt', 'geaendert'])
    .orderBy('erstellt');
  if (nurAktiv) q = q.where('aktiv', '=', true);
  return q.execute();
}

export function verschluesseleGeheimnis(masterKey: Buffer, geheimnis: string): Buffer {
  return verschluessele(masterKey, geheimnis, AAD_KANAL);
}

export function kanalDaten(masterKey: Buffer, z: KanalZeile): KanalDaten {
  return {
    id: z.id,
    typ: z.typ,
    bezeichnung: z.bezeichnung,
    konfig: z.konfig,
    geheimnis: z.geheimnis
      ? entschluessele(masterKey, z.geheimnis, AAD_KANAL).toString('utf8')
      : null,
  };
}
