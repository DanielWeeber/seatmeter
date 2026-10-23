// TanStack-Query-Hooks des Abgleichs.
import { abgleichLaeufeSchema, abgleichStatusSchema } from '@seatmeter/shared';
import { useApi } from '../../api/client';
import { useQuery } from '@tanstack/react-query';

export const STATUS_SCHLUESSEL = ['abgleich', 'status'] as const;
export const LAEUFE_SCHLUESSEL = ['abgleich', 'laeufe'] as const;

export function useAbgleichStatus() {
  const api = useApi();
  return useQuery({
    queryKey: STATUS_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/abgleich', abgleichStatusSchema),
  });
}

export function useAbgleichLaeufe() {
  const api = useApi();
  return useQuery({
    queryKey: LAEUFE_SCHLUESSEL,
    queryFn: () => api.get('/api/v1/abgleich/laeufe', abgleichLaeufeSchema),
  });
}
