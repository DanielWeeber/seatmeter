// Virtuelles Modul aus vite.config.ts: die per SEATMETER_WEB_PLUGINS gewählten Web-Plugins (sonst leer).
declare module 'virtual:seatmeter-web-plugins' {
  import type { WebPlugin } from './plugins';

  const plugins: WebPlugin[];
  export default plugins;
}
