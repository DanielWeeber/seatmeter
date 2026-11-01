// Schnipsel-Bausteine der Seite „Ausrollen“: gültiges JSON, Token nur im festen Header, Quoting im
// Start-Wrapper und in den Agent-Befehlen.
import {
  AGENT_STANDARD_PFAD,
  PROJEKTWAHL_PRUEF_PFAD,
  PROJEKTWAHL_TOKEN_VARIABLE,
} from '@seatmeter/shared';
import { describe, expect, it } from 'vitest';
import { AUSROLLEN } from '../../test/fixtures';
import {
  agentInstallBefehl,
  benutzerEinstellungen,
  casePfadMuster,
  enrollBefehl,
  helperBefehl,
  installSweeperBefehl,
  managedSettings,
  pfadeLesen,
  pfadWort,
  serverManagedSettings,
  shEinfach,
  startWrapper,
  TOKEN_PLATZHALTER,
  type KopfzeilenArt,
  type SchnipselOptionen,
} from './schnipsel';

const k = AUSROLLEN;
const ORGS = k.orgs.map((o) => o.org_uuid);
const TOKEN = 'smi_beispiel0123456789';

describe('Hook der Projektwahl in den Einstellungen', () => {
  const basis: SchnipselOptionen = {
    kopfzeilen: 'fest',
    token: TOKEN,
    agentPfad: AGENT_STANDARD_PFAD,
    orgFestlegen: false,
  };
  const lese = (s: string) =>
    JSON.parse(s) as {
      env: Record<string, string>;
      hooks?: { UserPromptSubmit: { hooks: { command: string; timeout: number }[] }[] };
    };

  it('fehlt ohne Option', () => {
    expect(lese(managedSettings(k, basis)).hooks).toBeUndefined();
    expect(lese(managedSettings(k, basis)).env[PROJEKTWAHL_TOKEN_VARIABLE]).toBeUndefined();
  });

  it('steht in MDM und Server-Managed Settings, mit Token in eigener Variable', () => {
    for (const s of [managedSettings, serverManagedSettings]) {
      const e = lese(s(k, { ...basis, projektwahl: true }));
      const h = e.hooks?.UserPromptSubmit[0]?.hooks[0];
      expect(h?.command).toContain(`${k.ingest_url}${PROJEKTWAHL_PRUEF_PFAD}`);
      expect(h?.command).not.toContain(TOKEN);
      expect(h?.timeout).toBe(5);
      expect(e.env[PROJEKTWAHL_TOKEN_VARIABLE]).toBe(TOKEN);
    }
  });

  it('fester Header ohne frisches Token: Platzhalter', () => {
    const e = lese(managedSettings(k, { ...basis, token: null, projektwahl: true }));
    expect(e.env[PROJEKTWAHL_TOKEN_VARIABLE]).toBe(TOKEN_PLATZHALTER);
  });

  it('mit Helper: Rechner-Token über den Agenten, keine Token-Variable', () => {
    const e = lese(
      managedSettings(k, { ...basis, kopfzeilen: 'helper', token: null, projektwahl: true }),
    );
    expect(e.env[PROJEKTWAHL_TOKEN_VARIABLE]).toBeUndefined();
    expect(e.hooks?.UserPromptSubmit[0]?.hooks[0]?.command).toContain('otel-headers');
  });

  it('nie in den Benutzer-Einstellungen: dort ließe er sich entfernen', () => {
    const e = lese(benutzerEinstellungen(k, { ...basis, projektwahl: true }));
    expect(e.hooks).toBeUndefined();
    expect(e.env[PROJEKTWAHL_TOKEN_VARIABLE]).toBeUndefined();
  });
});

function optionen(teil: Partial<SchnipselOptionen> = {}): SchnipselOptionen {
  return {
    kopfzeilen: 'helper',
    token: null,
    agentPfad: AGENT_STANDARD_PFAD,
    orgFestlegen: true,
    ...teil,
  };
}

type Einstellungen = {
  env: Record<string, string>;
  otelHeadersHelper?: string;
  forceLoginMethod?: string;
  forceLoginOrgUUID?: string[];
};
const lesen = (text: string) => JSON.parse(text) as Einstellungen;

const BAUER = [
  ['managedSettings', managedSettings],
  ['serverManagedSettings', serverManagedSettings],
  ['benutzerEinstellungen', benutzerEinstellungen],
] as const;
const ARTEN: KopfzeilenArt[] = ['helper', 'fest'];

describe('Einstellungs-Schnipsel (a, b, c)', () => {
  it('Fixture: OTLP-Endpunkt endet auf /otlp', () => {
    expect(k.otlp_endpoint).toBe(`${k.ingest_url}/otlp`);
    expect(k.otlp_endpoint.endsWith('/otlp')).toBe(true);
  });

  for (const [name, bauen] of BAUER)
    for (const art of ARTEN)
      it(`${name} (${art}) ist gültiges JSON mit Endpunkt und gesperrten Inhalten`, () => {
        const text = bauen(k, optionen({ kopfzeilen: art }));
        const s = lesen(text);
        expect(text.endsWith('\n')).toBe(true);
        expect(s.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
        expect(s.env.OTEL_METRICS_EXPORTER).toBe('otlp');
        expect(s.env.OTEL_LOGS_EXPORTER).toBe('otlp');
        expect(s.env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
        expect(s.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://ingest.example.org/otlp');
        expect(s.env.OTEL_METRICS_INCLUDE_REPOSITORY).toBe('true');
        for (const v of [
          'OTEL_LOG_USER_PROMPTS',
          'OTEL_LOG_ASSISTANT_RESPONSES',
          'OTEL_LOG_TOOL_DETAILS',
          'OTEL_LOG_RAW_API_BODIES',
        ])
          expect(s.env[v]).toBe('0');
      });

  it('Helper-Variante: otelHeadersHelper, kein Token und kein Header', () => {
    for (const [, bauen] of BAUER) {
      // Selbst ein übergebenes Token darf in der Helper-Variante nirgends auftauchen.
      const text = bauen(k, optionen({ kopfzeilen: 'helper', token: TOKEN }));
      const s = lesen(text);
      expect(s.otelHeadersHelper).toBe(`${AGENT_STANDARD_PFAD} otel-headers`);
      expect(s.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TOKEN_PLATZHALTER);
      expect(text).not.toContain('smi_');
    }
  });

  it('feste Variante: Platzhalter ohne Token, echtes Token nach dem Erzeugen', () => {
    for (const [, bauen] of BAUER) {
      const mitPlatzhalter = lesen(bauen(k, optionen({ kopfzeilen: 'fest' })));
      expect(mitPlatzhalter.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
        `Authorization=Bearer ${TOKEN_PLATZHALTER}`,
      );
      expect(mitPlatzhalter.otelHeadersHelper).toBeUndefined();

      const mitToken = lesen(bauen(k, optionen({ kopfzeilen: 'fest', token: TOKEN })));
      expect(mitToken.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${TOKEN}`);
      expect(JSON.stringify(mitToken)).not.toContain(TOKEN_PLATZHALTER);
    }
  });

  it('MDM: Anmeldung auf alle Orgs festlegen, abschaltbar', () => {
    const an = lesen(managedSettings(k, optionen({ orgFestlegen: true })));
    expect(an.forceLoginMethod).toBe('claudeai');
    expect(an.forceLoginOrgUUID).toEqual(ORGS);

    const aus = lesen(managedSettings(k, optionen({ orgFestlegen: false })));
    expect(aus.forceLoginMethod).toBeUndefined();
    expect(aus.forceLoginOrgUUID).toBeUndefined();

    const ohneOrgs = lesen(managedSettings({ ...k, orgs: [] }, optionen({ orgFestlegen: true })));
    expect(ohneOrgs.forceLoginMethod).toBeUndefined();
    expect(ohneOrgs.forceLoginOrgUUID).toBeUndefined();
  });

  it('Server-Managed und Benutzer-Einstellungen nie mit force*', () => {
    for (const bauen of [serverManagedSettings, benutzerEinstellungen]) {
      const s = lesen(bauen(k, optionen({ orgFestlegen: true })));
      expect(s.forceLoginMethod).toBeUndefined();
      expect(s.forceLoginOrgUUID).toBeUndefined();
    }
  });

  it('Agent-Pfad mit Leerzeichen wird für die Befehlszeile gequotet', () => {
    const s = lesen(managedSettings(k, optionen({ agentPfad: '/opt/seat meter/agent' })));
    expect(s.otelHeadersHelper).toBe('"/opt/seat meter/agent" otel-headers');
    expect(helperBefehl('~/.seatmeter/bin/seatmeter-agent')).toBe(
      '$HOME/.seatmeter/bin/seatmeter-agent otel-headers',
    );
  });
});

describe('Pfade und Quoting', () => {
  it('pfadeLesen: Leerzeilen weg, Schrägstriche am Ende weg, Duplikate einmal', () => {
    expect(pfadeLesen('$HOME/kunden/\n\n  ~/projekte  \n/srv/x//\n$HOME/kunden')).toEqual({
      pfade: ['$HOME/kunden', '~/projekte', '/srv/x'],
      fehler: [],
    });
    expect(pfadeLesen('\n  \n')).toEqual({ pfade: [], fehler: [] });
  });

  it('pfadeLesen: relative Pfade, ~user, Wurzel und Steuerzeichen abgelehnt', () => {
    const { pfade, fehler } = pfadeLesen('kunden\n~fremd/x\n/\n/a\tb\n${HOME}/ok');
    expect(pfade).toEqual(['${HOME}/ok']);
    expect(fehler).toHaveLength(4);
    expect(fehler[0]).toMatch(/^Zeile 1:/);
    expect(fehler[3]).toMatch(/^Zeile 4:/);
  });

  it('case-Muster: $HOME und ~ werden zu "$HOME", Rest wörtlich', () => {
    expect(casePfadMuster('$HOME/kunden')).toBe('"$HOME/kunden"/*');
    expect(casePfadMuster('~/kunden')).toBe('"$HOME/kunden"/*');
    expect(casePfadMuster('${HOME}')).toBe('"$HOME"/*');
    expect(casePfadMuster('/srv/Meine Kunden')).toBe('"/srv/Meine Kunden"/*');
    expect(casePfadMuster(`/srv/o'neil "x"`)).toBe(`"/srv/o'neil \\"x\\""/*`);
    expect(casePfadMuster('/srv/$x/`y`\\z')).toBe('"/srv/\\$x/\\`y\\`\\\\z"/*');
  });

  it('pfadWort: lesbar ohne Sonderzeichen, sonst doppelt gequotet mit $HOME', () => {
    expect(pfadWort(AGENT_STANDARD_PFAD)).toBe(AGENT_STANDARD_PFAD);
    expect(pfadWort('~')).toBe('$HOME');
    expect(pfadWort('~/Meine Kunden')).toBe('"$HOME/Meine Kunden"');
    expect(pfadWort('/opt/a;rm')).toBe('"/opt/a;rm"');
    expect(pfadWort('X=1/agent')).toBe('"X=1/agent"');
  });

  it('shEinfach maskiert einfache Anführungszeichen', () => {
    expect(shEinfach(`a'b`)).toBe(`'a'\\''b'`);
  });
});

describe('Start-Wrapper (d)', () => {
  const pfade = ['$HOME/kunden', '~/zweite', '/srv/Meine Kunden', `/srv/o'neil "x"`];
  const text = startWrapper(k, AGENT_STANDARD_PFAD, pfade) ?? '';

  it('baut die Funktion mit allen Pfaden im case-Muster', () => {
    expect(text).toContain('claude() {');
    expect(text).toContain('  case "$PWD/" in\n');
    expect(text).toContain(
      `    "$HOME/kunden"/*|"$HOME/zweite"/*|"/srv/Meine Kunden"/*|"/srv/o'neil \\"x\\""/*)\n`,
    );
    expect(text).toContain('    *) command claude "$@" ;;');
    expect(text.trimEnd().endsWith('}')).toBe(true);
  });

  it('gibt den Issue-Schlüssel des Branches über otel-ressource mit (nie den Branch-Namen)', () => {
    expect(text).toContain(
      '      sm_ressource=$($HOME/.seatmeter/bin/seatmeter-agent otel-ressource 2>/dev/null)\n',
    );
    expect(text).toContain(
      '      OTEL_RESOURCE_ATTRIBUTES="${sm_ressource:-${OTEL_RESOURCE_ATTRIBUTES:-}}" \\\n',
    );
    expect(text).not.toContain('rev-parse');
  });

  it('nutzt den Endpunkt und immer den Helper, nie einen Token', () => {
    expect(text).toContain("OTEL_EXPORTER_OTLP_ENDPOINT='https://ingest.example.org/otlp'");
    expect(text).toContain(
      `command claude --settings '{"otelHeadersHelper":"$HOME/.seatmeter/bin/seatmeter-agent otel-headers"}' "$@" ;;`,
    );
    expect(text).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
    expect(text).not.toContain('smi_');
    for (const v of [
      'OTEL_LOG_USER_PROMPTS=0',
      'OTEL_LOG_ASSISTANT_RESPONSES=0',
      'OTEL_LOG_TOOL_DETAILS=0',
      'OTEL_LOG_RAW_API_BODIES=0',
    ])
      expect(text).toContain(v);
  });

  it('maskiert einfache Anführungszeichen in Endpunkt und Helper-JSON', () => {
    const t =
      startWrapper(
        { ...k, otlp_endpoint: "https://ingest.example.org/o'tlp" },
        "/opt/o'neil/agent",
        ['/srv'],
      ) ?? '';
    expect(t).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT='https://ingest.example.org/o'\\''tlp'`);
    expect(t).toContain(
      `--settings '{"otelHeadersHelper":"\\"/opt/o'\\''neil/agent\\" otel-headers"}'`,
    );
  });

  it('ohne Pfade kein Wrapper', () => {
    expect(startWrapper(k, AGENT_STANDARD_PFAD, [])).toBeNull();
  });
});

describe('Agent-Befehle (e)', () => {
  it('Installation aus der Release-URL, ohne URL null', () => {
    expect(agentInstallBefehl(k)).toBe(
      'curl -fsSL https://git.example.org/beispiel/seatmeter/releases/download/v0.1.0/agent-install.sh | SEATMETER_RELEASE_URL=https://git.example.org/beispiel/seatmeter/releases/download/v0.1.0 sh',
    );
    expect(agentInstallBefehl({ ...k, agent: { ...k.agent, release_url: null } })).toBeNull();
  });

  it('enroll mit Code bzw. Platzhalter und Ingest-URL', () => {
    expect(enrollBefehl(k, AGENT_STANDARD_PFAD, 'ABCD-1234')).toBe(
      '$HOME/.seatmeter/bin/seatmeter-agent enroll ABCD-1234 --server https://ingest.example.org',
    );
    expect(enrollBefehl(k, AGENT_STANDARD_PFAD, null)).toContain('enroll <EINMALCODE> --server');
  });

  it('nur Sweeper: je Pfad ein --include, gequotet', () => {
    expect(installSweeperBefehl(AGENT_STANDARD_PFAD, ['$HOME/kunden', '/srv/Meine Kunden'])).toBe(
      '$HOME/.seatmeter/bin/seatmeter-agent install --sweeper-only --include $HOME/kunden --include "/srv/Meine Kunden"',
    );
    expect(installSweeperBefehl(AGENT_STANDARD_PFAD, [])).toContain('--include <PFAD>');
  });
});
