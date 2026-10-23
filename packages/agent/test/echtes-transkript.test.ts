// Prüft einen echten weeberwrk-Transkript dieses Rechners (nur lesend): Der Push-Inhalt darf weder
// `content` noch `cwd`, Pfade, Branch-Namen oder E-Mail-Adressen enthalten. Ohne passende Datei
// (CI, andere Rechner) wird der Test übersprungen. Andere Bereiche (arbeit, meyer, privat) werden
// nie angefasst: gesucht wird nur unter Ordnern `-Users-*-Claude-weeberwrk-de*`.
// `SEATMETER_ECHTE_TRANSKRIPTE` zeigt auf einen Ordner namens `projects` (z. B. im Dev-Container
// schreibgeschützt eingehängt); Standard `~/.claude/projects`.
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentAnfrageSchema } from '@seatmeter/shared';
import { wirksameKonfig } from '../src/konfig.js';
import { dateienDerSitzung, scanne } from '../src/scan.js';
import { standardUmgebung } from '../src/umgebung.js';
import { ladeAnfragen, ladeSitzungen } from '../src/warteschlange.js';
import { leererZustand } from '../src/zustand.js';
import { schreibeJson } from '../src/dateien.js';

const projekte = process.env.SEATMETER_ECHTE_TRANSKRIPTE ?? join(homedir(), '.claude', 'projects');

function kandidat(): string | null {
  let ordner: string[];
  try {
    ordner = readdirSync(projekte).filter((n) => /^-Users-[^-]+-Claude-weeberwrk-de/.test(n));
  } catch {
    return null;
  }
  const dateien = ordner.flatMap((o) =>
    readdirSync(join(projekte, o))
      .filter((d) => d.endsWith('.jsonl'))
      .map((d) => join(projekte, o, d)),
  );
  dateien.sort((a, b) => statSync(b).size - statSync(a).size);
  return dateien[0] ?? null;
}

const datei = kandidat();

describe.skipIf(!datei)('echtes weeberwrk-Transkript (nur lesend)', () => {
  it('Push-Inhalt ohne content, cwd, Pfade, Branch, E-Mail; Schema strikt gültig', () => {
    const basis = standardUmgebung({ ...process.env, HOME: homedir() });
    const agentDir = mkdtempSync(join(tmpdir(), 'seatmeter-echt-'));
    const u = { ...basis, agentDir, claudeDir: dirname(projekte), git: () => null };
    schreibeJson(join(agentDir, 'config.json'), { include_paths: ['/'], rueckfuellung_tage: 365 });
    const z = leererZustand();
    const e = scanne(u, wirksameKonfig(u), z, {
      hinweis: { klasse: 'oauth', org_uuid: null, account_uuid: null },
      nurDateien: dateienDerSitzung(datei as string),
    });
    expect(e.anfragen).toBeGreaterThan(0);
    const anfragen = ladeAnfragen(u);
    for (const a of anfragen) expect(agentAnfrageSchema.safeParse(a).success).toBe(true);
    const roh = JSON.stringify({ anfragen, sitzungen: ladeSitzungen(u) });
    for (const verboten of [
      '"content"',
      '"cwd"',
      'gitBranch',
      '/Users/',
      homedir(),
      hostname(),
      'transcript',
    ]) {
      expect(roh, verboten).not.toContain(verboten);
    }
    expect(roh).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    expect(anfragen.some((a) => (a.cache_write_1h ?? 0) + (a.cache_write_5m ?? 0) > 0)).toBe(true);
  });
});
