// Rendert das ganze Dashboard (Auth-Tor, Layout, Routen) mit Fixture-fetch.
import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App';
import type { WebPlugin } from '../plugins';
import { fixtureFetch, json, ME_ADMIN, type Routen } from './fixtures';

export function rendereApp(pfad: string, routen: Routen, optionen: { plugins?: WebPlugin[] } = {}) {
  const { fetch, aufrufe } = fixtureFetch({ '/api/v1/auth/me': json(ME_ADMIN), ...routen });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ergebnis = render(
    <MemoryRouter initialEntries={[pfad]}>
      <App queryClient={queryClient} plugins={optionen.plugins ?? []} fetch={fetch} />
    </MemoryRouter>,
  );
  return { ...ergebnis, aufrufe, queryClient };
}
