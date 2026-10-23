# Modul `static`

Liefert das Dashboard-Build (`packages/web/dist`) aus, wenn `SEATMETER_WEB_DIST` gesetzt ist (im Image `/app/web`): GET/HEAD `/*` als letzte Route, vorhandene Dateien direkt (`/assets/*` ein Jahr Cache, sonst `no-cache`), alle übrigen Pfade ohne Dateiendung als `index.html` (Client-Routing). `/api/*` und `/otlp/*` bekommen nie die SPA, sondern 404 (JSON). Keine eigenen Daten, keine Jobs.
