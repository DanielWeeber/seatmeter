// TanStack-Query-Hooks des Moduls Projektkatalog.
import {
  katalogEinstellungSchema,
  katalogKostenAntwortSchema,
  katalogListeSchema,
  katalogZuordnungAntwortSchema,
  projektwahlAntwortSchema,
} from '@seatmeter/shared';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/client';

export const EINSTELLUNG_SCHLUESSEL = ['projektkatalog', 'einstellung'] as const;
export const ZUORDNUNG_SCHLUESSEL = ['projektkatalog', 'zuordnung'] as const;
export const PROJEKTE_SCHLUESSEL = ['projektkatalog', 'projekte'] as const;

export function useKatalogEinstellung() {
  const api = useApi();
  return useQuery({
    queryKey: EINSTELLUNG_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/projektkatalog/einstellung', katalogEinstellungSchema),
  });
}

/** Aktive Projekte für die Auswahl. */
export function useKatalogProjekte() {
  const api = useApi();
  return useQuery({
    queryKey: PROJEKTE_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/projektkatalog/projekte', katalogListeSchema),
  });
}

/** Alle Projekte mit Status, auch inaktive, für die Übersicht. */
export function useKatalogAlleProjekte() {
  const api = useApi();
  return useQuery({
    queryKey: [...PROJEKTE_SCHLUESSEL, 'alle'],
    queryFn: () => api.get('/api/v1/projektkatalog/projekte?aktiv=0', katalogListeSchema),
  });
}

export function useKatalogZuordnung() {
  const api = useApi();
  return useQuery({
    queryKey: ZUORDNUNG_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/projektkatalog/zuordnung', katalogZuordnungAntwortSchema),
  });
}

export function useKatalogKosten(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['projektkatalog', 'kosten', monat],
    queryFn: () =>
      api.get(
        `/api/v1/projektkatalog/kosten?monat=${encodeURIComponent(monat)}`,
        katalogKostenAntwortSchema,
      ),
  });
}

export function katalogKostenCsvPfad(monat: string): string {
  return `/api/v1/projektkatalog/kosten?monat=${encodeURIComponent(monat)}&format=csv`;
}

export function projektwahlSchluessel(token: string) {
  return ['projektwahl', token] as const;
}

export function useProjektwahl(token: string) {
  const api = useApi();
  return useQuery({
    queryKey: projektwahlSchluessel(token),
    retry: false,
    queryFn: () =>
      api.get(`/api/v1/projektwahl?token=${encodeURIComponent(token)}`, projektwahlAntwortSchema),
  });
}
