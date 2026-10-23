// TanStack-Query-Hook der Projekt-Hinweise.
import { hinweisListeSchema } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { useQuery } from '@tanstack/react-query';

export function useHinweise(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['hinweise', monat],
    queryFn: () =>
      api.get(`/api/v1/hinweise?monat=${encodeURIComponent(monat)}`, hinweisListeSchema),
  });
}
