import { describe, expect, it } from 'vitest';
import { agentPushSchema, PUSH_MAX_EINTRAEGE, type AgentAnfrage } from './agent-push.js';
import { anfrageSchema, normalisiereSpeed, SPEED_NORMAL } from './anfrage.js';
import { agentKonfigurationSchema, enrollmentAntwortSchema } from './enrollment.js';

const agentAnfrage: AgentAnfrage = {
  request_id: 'req_011CTestAbc',
  message_id: 'msg_01TestXyz',
  session_id: '6f1c2b0e-0000-4000-8000-000000000001',
  ts: '2026-10-22T08:15:00.000Z',
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: 200,
  cache_read_input_tokens: 30_000,
  cache_creation_input_tokens: 1_000,
  cache_write_5m: 0,
  cache_write_1h: 1_000,
  web_search_requests: 0,
  speed: 'normal',
  service_tier: 'standard',
  inference_geo: 'global',
  ist_subagent: false,
  cc_version: '2.1.300',
  projekt: {
    url_norm: 'https://github.com/owner/repo',
    provider: 'github',
    owner: 'owner',
    repo_name: 'repo',
  },
  auth_hinweis: { klasse: 'oauth', org_uuid: null, account_uuid: null },
};

describe('Agent-Push (Architektur §2.2)', () => {
  it('nimmt einen gültigen Push an', () => {
    expect(
      agentPushSchema.parse({ agent_version: '0.1.0', anfragen: [agentAnfrage] }),
    ).toBeTruthy();
  });

  it.each(['cwd', 'transcript_path', 'hostname', 'content', 'git_branch', 'email'])(
    'lehnt Feld %s ab',
    (feld) => {
      const r = agentPushSchema.safeParse({
        agent_version: '0.1.0',
        anfragen: [{ ...agentAnfrage, [feld]: 'x' }],
      });
      expect(r.success).toBe(false);
    },
  );

  it('lehnt Inhalte im Projekt-Objekt ab', () => {
    const r = agentPushSchema.safeParse({
      agent_version: '0.1.0',
      anfragen: [{ ...agentAnfrage, projekt: { ...agentAnfrage.projekt, pfad: '/home/x' } }],
    });
    expect(r.success).toBe(false);
  });

  it('bildet speed „standard“ (Transkript) auf „normal“ ab, fast und null bleiben', () => {
    const speed = (wert: string | null) =>
      agentPushSchema.parse({
        agent_version: '0.1.0',
        anfragen: [{ ...agentAnfrage, speed: wert }],
      }).anfragen[0]?.speed;
    expect(speed('standard')).toBe('normal');
    expect(speed('normal')).toBe('normal');
    expect(speed('fast')).toBe('fast');
    expect(speed(null)).toBeNull();
    expect(normalisiereSpeed('standard')).toBe(SPEED_NORMAL);
  });

  it('nimmt issue_schluessel an (optional, Muster, höchstens 20); git_branch bleibt verboten', () => {
    const push = (issue_schluessel: unknown) =>
      agentPushSchema.safeParse({
        agent_version: '0.1.3',
        anfragen: [{ ...agentAnfrage, issue_schluessel }],
      });
    expect(push(['ABC-123', 'X2-7']).success).toBe(true);
    expect(push([]).success).toBe(true);
    expect(
      agentPushSchema.safeParse({ agent_version: '0.1.2', anfragen: [agentAnfrage] }).success,
    ).toBe(true);
    expect(push(['abc-123']).success).toBe(false);
    expect(push(['feature/ABC-123']).success).toBe(false);
    expect(push(['A-1']).success).toBe(false);
    expect(push('ABC-123').success).toBe(false);
    expect(push(Array.from({ length: 21 }, (_x, i) => `ABC-${i + 1}`)).success).toBe(false);
    expect(push(Array.from({ length: 20 }, (_x, i) => `ABC-${i + 1}`)).success).toBe(true);
    const mitBranch = agentPushSchema.safeParse({
      agent_version: '0.1.3',
      anfragen: [{ ...agentAnfrage, issue_schluessel: ['ABC-1'], git_branch: 'feature/ABC-1' }],
    });
    expect(mitBranch.success).toBe(false);
  });

  it('begrenzt den Batch auf 1000 Einträge', () => {
    const anfragen = Array.from({ length: PUSH_MAX_EINTRAEGE + 1 }, () => agentAnfrage);
    expect(agentPushSchema.safeParse({ agent_version: '0.1.0', anfragen }).success).toBe(false);
  });
});

describe('Anfrage (Architektur §3.1)', () => {
  it('prüft den normalisierten Datensatz', () => {
    const a = anfrageSchema.parse({
      mandant_id: '01900000-0000-7000-8000-000000000001',
      anfrage_key: 'req_011CTestAbc',
      ts: '2026-10-22T08:15:00Z',
      tag: '2026-10-22',
      session_id: 's1',
      person_id: null,
      projekt_id: null,
      model: 'claude-sonnet-5-5',
      speed: null,
      inference_geo: null,
      service_tier: null,
      query_source: 'main',
      ist_subagent: false,
      input: 1,
      output: 2,
      cache_read: 3,
      cache_write: 4,
      cache_write_1h: null,
      web_search: 0,
      quellen: 1,
      auth_klasse: 'abo',
      zaehlt_als_abo: true,
      cc_kosten_usd_micros: null,
      abweichung_ab: false,
    });
    expect(a.ts).toBeInstanceOf(Date);
  });

  it('lehnt negative Tokens und unbekannte Auth-Klassen ab', () => {
    expect(anfrageSchema.shape.input.safeParse(-1).success).toBe(false);
    expect(anfrageSchema.shape.auth_klasse.safeParse('privat').success).toBe(false);
  });
});

describe('Enrollment (Architektur §2.2, §6)', () => {
  it('setzt Standardwerte der Agent-Konfiguration', () => {
    const k = agentKonfigurationSchema.parse({ server_url: 'https://ingest.example.org' });
    expect(k).toMatchObject({ modus: 'hooks', sweeper_intervall_min: 10, rueckfuellung_tage: 30 });
  });

  it('verlangt das Präfix smr_ für Rechner-Token', () => {
    const basis = {
      rechner_id: '01900000-0000-7000-8000-000000000002',
      konfiguration: { server_url: 'https://ingest.example.org' },
    };
    expect(enrollmentAntwortSchema.safeParse({ ...basis, token: 'smr_abc' }).success).toBe(true);
    expect(enrollmentAntwortSchema.safeParse({ ...basis, token: 'smi_abc' }).success).toBe(false);
  });
});
