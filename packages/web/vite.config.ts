// Vite-Konfiguration des Dashboards; dient Vitest zugleich als Projektkonfiguration.
// Web-Plugins (ee) nur beim Bauen mit SEATMETER_WEB_PLUGINS=<paket,…> (siehe web-plugins.ts),
// Ausgabe dann nach SEATMETER_WEB_OUT (Standard dist).
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { pluginNamen, seatmeterWebPlugins } from './web-plugins';

const wurzel = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [
    seatmeterWebPlugins(wurzel, pluginNamen(process.env.SEATMETER_WEB_PLUGINS)),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@seatmeter/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
    // Plugins bringen dieselben Bibliotheken mit; nur eine Kopie im Bündel (ein React, ein Query-Client).
    dedupe: ['react', 'react-dom', 'react-router', '@tanstack/react-query', 'zod'],
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.SEATMETER_API_URL ?? 'http://localhost:8080' },
  },
  build: { outDir: process.env.SEATMETER_WEB_OUT ?? 'dist', emptyOutDir: true },
  test: {
    name: 'web',
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}', 'web-plugins.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
