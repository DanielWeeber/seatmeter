// TanStack-Query-Hooks je Route; Schlüssel und Pfade an einer Stelle.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from './client';
import {
  ausrollenKonfigurationSchema,
  betriebsratBerichtSchema,
  datenqualitaetSchema,
  einmalcodeSchema,
  healthSchema,
  ingestHealthSchema,
  kalkulationAntwortSchema,
  kurseAntwortSchema,
  mandantEinstellungenSchema,
  mandantenTokenAntwortSchema,
  mandantSchema,
  monatsabschlussSchema,
  issuesSchema,
  personenSchema,
  preiseSchema,
  projektDetailSchema,
  projektIssuesSchema,
  projekteSchema,
  rechnerListeSchema,
  sitzkostenSchema,
  uebersichtSchema,
} from './typen';

const mitMonat = (pfad: string, monat: string) => `${pfad}?monat=${encodeURIComponent(monat)}`;

export function useUebersicht(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['uebersicht', monat],
    queryFn: () => api.get(mitMonat('/api/v1/uebersicht', monat), uebersichtSchema),
  });
}

export function useProjekte(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['projekte', monat],
    queryFn: () => api.get(mitMonat('/api/v1/projekte', monat), projekteSchema),
  });
}

export function useProjekt(id: string, monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['projekt', id, monat],
    queryFn: () =>
      api.get(mitMonat(`/api/v1/projekte/${encodeURIComponent(id)}`, monat), projektDetailSchema),
  });
}

/** Kosten je Issue-Schlüssel eines Projekts. */
export function useProjektIssues(id: string, monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['projekt-issues', id, monat],
    queryFn: () =>
      api.get(
        mitMonat(`/api/v1/projekte/${encodeURIComponent(id)}/issues`, monat),
        projektIssuesSchema,
      ),
  });
}

/** Kosten je Issue-Schlüssel über alle sichtbaren Projekte. */
export function useIssues(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['issues', monat],
    queryFn: () => api.get(mitMonat('/api/v1/issues', monat), issuesSchema),
  });
}

/** CSV-Download der Issues eines Projekts bzw. aller Projekte (`id` = null). */
export function issuesCsvPfad(id: string | null, monat: string): string {
  const pfad = id === null ? '/api/v1/issues' : `/api/v1/projekte/${encodeURIComponent(id)}/issues`;
  return `${mitMonat(pfad, monat)}&format=csv`;
}

export function usePersonen(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['personen', monat],
    queryFn: () => api.get(mitMonat('/api/v1/personen', monat), personenSchema),
  });
}

export function useDatenqualitaet(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['datenqualitaet', monat],
    queryFn: () => api.get(mitMonat('/api/v1/datenqualitaet', monat), datenqualitaetSchema),
  });
}

export function usePreise() {
  const api = useApi();
  return useQuery({
    queryKey: ['preise'],
    queryFn: () => api.get('/api/v1/preise', preiseSchema),
  });
}

export function useSitzkosten() {
  const api = useApi();
  return useQuery({
    queryKey: ['sitzkosten'],
    queryFn: () => api.get('/api/v1/sitzkosten', sitzkostenSchema),
  });
}

export function useRechner() {
  const api = useApi();
  return useQuery({
    queryKey: ['rechner'],
    queryFn: () => api.get('/api/v1/rechner', rechnerListeSchema),
  });
}

export function useMandant() {
  const api = useApi();
  return useQuery({
    queryKey: ['auth', 'mandant'],
    queryFn: () => api.get('/api/v1/auth/mandant', mandantSchema),
  });
}

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: ['health'], queryFn: () => api.get('/api/health', healthSchema) });
}

export function useIngestHealth() {
  const api = useApi();
  return useQuery({
    queryKey: ['health', 'ingest'],
    queryFn: () => api.get('/api/health/ingest', ingestHealthSchema),
  });
}

export function useKalkulation(monat: string, aktiv = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['kalkulation', monat],
    queryFn: () => api.get(mitMonat('/api/v1/kalkulation', monat), kalkulationAntwortSchema),
    enabled: aktiv,
  });
}

export function useMonatsabschluss(monat: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['monatsabschluss', monat],
    queryFn: () => api.get(mitMonat('/api/v1/monatsabschluss', monat), monatsabschlussSchema),
  });
}

export function useKurse() {
  const api = useApi();
  return useQuery({
    queryKey: ['kurse'],
    queryFn: () => api.get('/api/v1/kurse', kurseAntwortSchema),
  });
}

export function useMandantEinstellungen() {
  const api = useApi();
  return useQuery({
    queryKey: ['mandant', 'einstellungen'],
    queryFn: () => api.get('/api/v1/mandant/einstellungen', mandantEinstellungenSchema),
  });
}

export function useBetriebsratBericht(monat: string, aktiv = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['berichte', 'betriebsrat', monat],
    queryFn: () =>
      api.get(
        `${mitMonat('/api/v1/berichte/betriebsrat', monat)}&format=json`,
        betriebsratBerichtSchema,
      ),
    enabled: aktiv,
  });
}

export function useAusrollen() {
  const api = useApi();
  return useQuery({
    queryKey: ['ausrollen'],
    queryFn: () => api.get('/api/v1/ausrollen', ausrollenKonfigurationSchema),
  });
}

/**
 * Neues Mandanten-Token (`smi_…`, Klartext nur in dieser Antwort). `gcTime: 0`: Das Ergebnis bleibt
 * nicht im Mutation-Cache liegen; die Seite hält es nur im React-Zustand.
 */
export function useMandantenTokenErzeugen() {
  const api = useApi();
  return useMutation({
    mutationFn: () =>
      api.post('/api/v1/ausrollen/mandanten-token', {}, mandantenTokenAntwortSchema),
    gcTime: 0,
  });
}

/** Einmalcode für `seatmeter-agent enroll` (gleiche Route wie die Seite „Rechner/Agenten“). */
export function useEinmalcodeErzeugen() {
  const api = useApi();
  return useMutation({
    mutationFn: (bezeichnung: string) =>
      api.post(
        '/api/v1/rechner/einmalcode',
        bezeichnung.trim() ? { bezeichnung: bezeichnung.trim() } : {},
        einmalcodeSchema,
      ),
    gcTime: 0,
  });
}

/** Download-Pfade der Berichte (Links mit Cookie-Sitzung, kein fetch). */
export function berichtPfad(
  bericht: 'projektabrechnung' | 'betriebsrat',
  monat: string,
  format: 'csv' | 'html' | 'json',
): string {
  return `${mitMonat(`/api/v1/berichte/${bericht}`, monat)}&format=${format}`;
}
