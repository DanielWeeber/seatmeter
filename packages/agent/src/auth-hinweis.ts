// Auth-Hinweis für Quelle B (Architektur §2.2, §4): `api`, wenn API-Key- oder Provider-Variablen
// gesetzt sind oder `apiKeyHelper` in den Settings steht; sonst `oauth` mit Org- und Konto-UUID aus
// `~/.claude.json` → `oauthAccount` (undokumentiert). Aus dieser Datei werden nur
// `organizationUuid` und `accountUuid` übernommen (keine E-Mail, kein Name).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthHinweis } from '@seatmeter/shared';
import type { Umgebung } from './umgebung.js';

const API_VARIABLEN = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOderNull(x: unknown): string | null {
  return typeof x === 'string' && UUID.test(x) ? x.toLowerCase() : null;
}

/** Liest aus `oauthAccount` nur Org- und Konto-UUID; andere Felder (E-Mail, Name) bleiben unberührt. */
function oauthKonto(pfad: string): { org: string | null; konto: string | null } {
  try {
    const d = JSON.parse(readFileSync(pfad, 'utf8')) as { oauthAccount?: unknown };
    const o =
      typeof d.oauthAccount === 'object' && d.oauthAccount !== null
        ? (d.oauthAccount as { organizationUuid?: unknown; accountUuid?: unknown })
        : null;
    return { org: uuidOderNull(o?.organizationUuid), konto: uuidOderNull(o?.accountUuid) };
  } catch {
    return { org: null, konto: null };
  }
}

function hatApiKeyHelper(pfad: string): boolean {
  try {
    const d = JSON.parse(readFileSync(pfad, 'utf8')) as Record<string, unknown>;
    return typeof d.apiKeyHelper === 'string' && d.apiKeyHelper !== '';
  } catch {
    return false;
  }
}

function managedSettings(u: Umgebung): string {
  if (u.plattform === 'darwin')
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (u.plattform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

export function authHinweis(u: Umgebung, env: NodeJS.ProcessEnv = u.env): AuthHinweis {
  const api =
    API_VARIABLEN.some((v) => (env[v] ?? '') !== '' && env[v] !== '0') ||
    (env.ANTHROPIC_BASE_URL !== undefined &&
      env.ANTHROPIC_BASE_URL !== '' &&
      !/^https:\/\/api\.anthropic\.com\/?$/.test(env.ANTHROPIC_BASE_URL)) ||
    hatApiKeyHelper(join(u.claudeDir, 'settings.json')) ||
    hatApiKeyHelper(managedSettings(u));
  if (api) return { klasse: 'api', org_uuid: null, account_uuid: null };
  const { org, konto } = oauthKonto(u.claudeJson);
  return { klasse: 'oauth', org_uuid: org, account_uuid: konto };
}
