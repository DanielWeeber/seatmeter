// Auflösung der Web-Plugins aus dem Workspace (ohne echtes ee-Paket: Testordner mit eigener package.json).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mitQuellen, modulQuelle, pluginNamen, workspaceQuelle } from './web-plugins';

function workspace(): string {
  const wurzel = mkdtempSync(join(tmpdir(), 'seatmeter-web-plugins-'));
  writeFileSync(join(wurzel, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\n  - 'zusatz/*'\n");
  mkdirSync(join(wurzel, 'zusatz', 'web'), { recursive: true });
  writeFileSync(
    join(wurzel, 'zusatz', 'web', 'package.json'),
    JSON.stringify({ name: '@beispiel/web-plugin', source: 'src/index.tsx' }),
  );
  mkdirSync(join(wurzel, 'zusatz', 'ohne-quelle'), { recursive: true });
  writeFileSync(
    join(wurzel, 'zusatz', 'ohne-quelle', 'package.json'),
    JSON.stringify({ name: '@beispiel/ohne-quelle' }),
  );
  return wurzel;
}

describe('Web-Plugins (SEATMETER_WEB_PLUGINS)', () => {
  it('liest die Paketnamen kommagetrennt, leer = keine', () => {
    expect(pluginNamen(undefined)).toEqual([]);
    expect(pluginNamen(' a , ,b ')).toEqual(['a', 'b']);
  });

  it('findet die Quelle über pnpm-workspace.yaml und das Feld source', () => {
    const wurzel = workspace();
    expect(workspaceQuelle(wurzel, '@beispiel/web-plugin')).toBe(
      join(wurzel, 'zusatz', 'web', 'src', 'index.tsx'),
    );
    expect(() => workspaceQuelle(wurzel, '@beispiel/fehlt')).toThrow(/nicht im Workspace/);
    expect(() => workspaceQuelle(wurzel, '@beispiel/ohne-quelle')).toThrow(/source/);
  });

  it('erzeugt ein Modul mit Default-Liste', () => {
    expect(modulQuelle([])).toBe('\nexport default [];\n');
    expect(modulQuelle(['/a.tsx', '/b.tsx'])).toContain('export default [p0, p1];');
  });

  it('lässt Tailwind die Plugin-Ordner scannen', () => {
    expect(mitQuellen("@import 'tailwindcss';\nbody {}", [])).toBe(
      "@import 'tailwindcss';\nbody {}",
    );
    expect(mitQuellen("@import 'tailwindcss';\nbody {}", ['/w/zusatz/web/src'])).toBe(
      '@import \'tailwindcss\';\n@source "/w/zusatz/web/src";\nbody {}',
    );
  });
});
