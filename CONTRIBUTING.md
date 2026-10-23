# Mitwirken an seatmeter

Danke für dein Interesse. Issues und Pull Requests auf GitHub sind willkommen: Fehlerberichte, Verbesserungen an Doku und Code, neue Tests.

## So läuft es

- Das GitHub-Repository ist ein automatisch erzeugter Export; entwickelt wird im Forgejo von weeberwrk. Einen angenommenen Pull Request übernimmt weeberwrk dort (mit dir als Autor bzw. Co-Autor), mit dem nächsten Export erscheint die Änderung hier und der Pull Request wird geschlossen.
- Größere Änderungen bitte zuerst als Issue beschreiben, damit wir die Richtung abstimmen, bevor du Zeit investierst.
- Kein DCO und keine CLA: Kein `Signed-off-by` nötig. Mit dem Einreichen stellst du deinen Beitrag unter die Apache License 2.0 (Abschnitt 5 der [Lizenz](LICENSE)).
- Sicherheitslücken bitte nicht als öffentliches Issue melden, sondern vertraulich über die Kontaktangaben auf https://www.weeberwrk.de

## Regeln für Code

- **Werkzeuge im Container:** `docker compose -f deploy/compose.dev.yml run --rm dev pnpm <befehl>` (Details im [README](README.md#entwicklung)); Node und pnpm müssen nicht installiert sein.
- **Code-Stil:** `pnpm lint` (ESLint) und `pnpm format:check` (Prettier) müssen sauber sein; `pnpm format` formatiert. TypeScript im Modus `strict`.
- **Tests sind Pflicht:** Jede Änderung bringt Tests mit (Vitest); `pnpm test` läuft gegen Postgres 18 aus der Entwicklungsumgebung. Vor dem Pull Request lint, format:check, typecheck, test und build ausführen; die CI prüft dasselbe.
- **Sprache:** Bezeichner folgen den deutschen Tabellen- und Feldnamen aus [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) (z. B. `anfrage`, `mandant`, `projekt`), sonst englisch. Doku, Code-Kommentare und Texte im Dashboard sind deutsch.
- **Module:** Jedes Server-Modul hat einen Ordner `packages/server/src/<modul>/` mit `README.md` als Vertrag (Routen, Jobs). Neue Migration = neue Datei `JJJJ_MM_TT_NNNN_thema.ts`, Eintrag in `db/migrations/index.ts` und Typen in `db/schema.ts`. Mandantenzugriffe nur über `withMandant`.
- **Abhängigkeiten:** exakte Versionen (`save-exact`) und die aktualisierte `pnpm-lock.yaml` mit einreichen.
- **Daten:** keine echten personenbezogenen Daten, Geheimnisse oder internen Hostnamen in Code, Fixtures oder Commits; Beispiele mit `example.com`. Pseudonymisierung ist Standard und bleibt es.
