// Kalendertage als `YYYY-MM-DD` (reine Datumsrechnung in UTC, ohne Zeitzonen-Verschiebung).

const TAG_MS = 86_400_000;

export function plusTage(tag: string, n: number): string {
  return new Date(Date.parse(`${tag}T00:00:00Z`) + n * TAG_MS).toISOString().slice(0, 10);
}

/** Alle Tage von `von` bis `bis` (beide eingeschlossen). */
export function tageZwischen(von: string, bis: string): string[] {
  const aus: string[] = [];
  for (let t = von; t <= bis; t = plusTage(t, 1)) aus.push(t);
  return aus;
}

/** Heutiger Kalendertag in einer IANA-Zeitzone. */
export function heuteIn(zeitzone: string, jetzt: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zeitzone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(jetzt);
}

/** Monat `JJJJ-MM` → erster Tag und erster Tag des Folgemonats. */
export function monatsGrenzen(monat: string): { von: string; bisExklusiv: string } {
  const [jahr, mon] = monat.split('-').map(Number) as [number, number];
  const von = new Date(Date.UTC(jahr, mon - 1, 1)).toISOString().slice(0, 10);
  const bisExklusiv = new Date(Date.UTC(jahr, mon, 1)).toISOString().slice(0, 10);
  return { von, bisExklusiv };
}
