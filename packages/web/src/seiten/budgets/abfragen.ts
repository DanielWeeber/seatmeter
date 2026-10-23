// TanStack-Query-Hooks der Budgets, Alarme und Alarmkanäle.
import { useApi } from '../../api/client';
import { alarmListeSchema, budgetListeSchema, kanalListeSchema } from '@seatmeter/shared';
import { useQuery } from '@tanstack/react-query';

const mitMonat = (pfad: string, monat: string) => `${pfad}?monat=${encodeURIComponent(monat)}`;

export function useBudgets(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['budgets', monat],
    queryFn: () => api.get(mitMonat('/api/v1/budgets', monat), budgetListeSchema),
  });
}

export function useAlarme(monat: string, nurOffen: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ['alarme', monat, nurOffen],
    queryFn: () =>
      api.get(
        `${mitMonat('/api/v1/alarme', monat)}${nurOffen ? '&offen=1' : ''}`,
        alarmListeSchema,
      ),
  });
}

export function useKanaele() {
  const api = useApi();
  return useQuery({
    queryKey: ['alarmkanal'],
    queryFn: () => api.get('/api/v1/alarmkanal', kanalListeSchema),
  });
}
