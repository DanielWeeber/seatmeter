// ESLint (flat config) für das ganze Monorepo.
// Lizenzgrenze: packages/* (Apache-2.0) darf nie aus ee/ importieren (Architektur §8).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const eeGrenze = {
  patterns: [
    {
      group: ['@seatmeter/ee-*', '@seatmeter/ee-*/**'],
      message: 'packages/* darf nicht aus ee/ importieren (Lizenzgrenze, Architektur §8).',
    },
    {
      regex: '(^|/)ee(/|$)',
      message: 'packages/* darf nicht aus ee/ importieren (Lizenzgrenze, Architektur §8).',
    },
  ],
};

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/dist-ee/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.beads/**',
      '.agents/**',
      '.codex/**',
      '.cursor/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/web/src/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['packages/**'],
    rules: {
      'no-restricted-imports': ['error', eeGrenze],
    },
  },
);
