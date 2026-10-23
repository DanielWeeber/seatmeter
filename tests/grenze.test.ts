// Lizenzgrenze (Architektur §8): packages/* darf nie aus ee/ importieren; ee/ darf den Kern nutzen.
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const wurzel = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: wurzel });

async function verstoesse(code: string, datei: string): Promise<string[]> {
  const [ergebnis] = await eslint.lintText(code, { filePath: `${wurzel}${datei}` });
  return (ergebnis?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('Lizenzgrenze packages/* ↔ ee/', () => {
  it.each([
    "import plugin from '@seatmeter/ee-server';\nexport default plugin;\n",
    "import plugin from '@seatmeter/ee-web';\nexport default plugin;\n",
    "import { x } from '@seatmeter/ee-server/dist/index.js';\nexport { x };\n",
    "import plugin from '../../../ee/server/src/index.js';\nexport default plugin;\n",
    "export { default } from '../../../ee/web/src/index.js';\n",
  ])('packages/server verbietet: %s', async (code) => {
    expect(await verstoesse(code, 'packages/server/src/verboten.ts')).toHaveLength(1);
  });

  it('gilt für alle Kernpakete', async () => {
    for (const paket of ['shared', 'web', 'agent']) {
      const code = "import plugin from '@seatmeter/ee-server';\nexport default plugin;\n";
      expect(await verstoesse(code, `packages/${paket}/src/verboten.ts`)).toHaveLength(1);
    }
  });

  it('erlaubt Kern-Importe in packages/* und Kern-Importe in ee/', async () => {
    const kern = "import { PREIS_SEED } from '@seatmeter/shared';\nexport default PREIS_SEED;\n";
    expect(await verstoesse(kern, 'packages/server/src/erlaubt.ts')).toEqual([]);
    const ee =
      "import type { SeatmeterPlugin } from '@seatmeter/server';\nexport type P = SeatmeterPlugin;\n";
    expect(await verstoesse(ee, 'ee/server/src/erlaubt.ts')).toEqual([]);
  });

  it('der echte Kern-Code importiert nichts aus ee/', async () => {
    const ergebnisse = await eslint.lintFiles(['packages/*/src/**/*.{ts,tsx}']);
    const treffer = ergebnisse.flatMap((e) =>
      e.messages.filter((m) => m.ruleId === 'no-restricted-imports').map(() => e.filePath),
    );
    expect(treffer).toEqual([]);
  });
});
