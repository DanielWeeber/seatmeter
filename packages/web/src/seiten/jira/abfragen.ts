// TanStack-Query-Hooks des Jira-Moduls (Schlüssel mit Präfix `ee`).
import {
  jiraKostenAntwortSchema,
  jiraProjekteAntwortSchema,
  jiraVerbindungSchema,
  jiraZuordnungAntwortSchema,
} from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { useQuery } from '@tanstack/react-query';

export const VERBINDUNG_SCHLUESSEL = ['jira', 'verbindung'] as const;
export const ZUORDNUNG_SCHLUESSEL = ['jira', 'zuordnung'] as const;
export const PROJEKTE_SCHLUESSEL = ['jira', 'projekte'] as const;

export function useJiraVerbindung() {
  const api = useApi();
  return useQuery({
    queryKey: VERBINDUNG_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/jira/verbindung', jiraVerbindungSchema),
  });
}

export function useJiraZuordnung() {
  const api = useApi();
  return useQuery({
    queryKey: ZUORDNUNG_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/jira/zuordnung', jiraZuordnungAntwortSchema),
  });
}

/** Projektliste aus Jira; nur mit aktiver Verbindung. */
export function useJiraProjekte(aktiv: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: PROJEKTE_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/jira/projekte', jiraProjekteAntwortSchema),
    enabled: aktiv,
    staleTime: 5 * 60_000,
  });
}

export function useJiraKosten(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['jira', 'kosten', monat],
    queryFn: () =>
      api.get(`/api/v1/jira/kosten?monat=${encodeURIComponent(monat)}`, jiraKostenAntwortSchema),
  });
}

export function jiraKostenCsvPfad(monat: string): string {
  return `/api/v1/jira/kosten?monat=${encodeURIComponent(monat)}&format=csv`;
}
