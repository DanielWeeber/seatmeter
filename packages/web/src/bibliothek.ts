// Bausteine des Dashboards für Web-Plugins (ee/web nutzt den Kern, nie umgekehrt; Architektur §8).
// Einstieg `@seatmeter/web/bibliothek` (package.json „exports“); Quelltext, gebaut wird mit dem Dashboard.
export { App } from './App';
export * from './api/client';
export { useKalkulation, useMandant, useProjekte } from './api/abfragen';
export { projekteSchema, type ProjekteAntwort } from './api/typen';
export * from './komponenten/Abfrage';
export * from './komponenten/Bausteine';
export * from './komponenten/Formular';
export * from './format';
export * from './monat';
export * from './plugins';
export { useAuth } from './auth/AuthTor';
