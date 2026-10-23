# Agent-Fixtures (von Hand erstellt)

Synthetische Claude-Code-Transkripte im Aufbau von `~/.claude/projects/<ordner>/<session>.jsonl`
(Assistant-Zeilen mit `requestId`, `message.id`, `message.usage` samt 5m/1h-Aufteilung,
`isSidechain`, `cwd`, `gitBranch`). Alle Werte sind erfunden; Inhalte tragen das Merkmal
`GEHEIMER-…`, damit Tests prüfen können, dass sie nie in der Warteschlange oder im Push landen.

Platzhalter `{{T+n}}` ersetzt `test/hilfen.ts` durch „Basiszeit + n Sekunden“ (ISO-8601).

| Datei | Inhalt |
|---|---|
| `-home-dev-kunden-alpha/aaaaaaaa-…jsonl` | Nutzer-Zeile; `msg_01FIX` in zwei Streaming-Zeilen (letzte gilt); `msg_02FIX` mit 5m/1h und Websuche; `msg_03FIX` mit anderem `cwd` (zweites Repo); `msg_04FIX` ohne `requestId`; synthetische Fehlerzeile; kaputte Zeile; `msg_06FIX` mit `cwd` außerhalb des Filters |
| `-home-dev-kunden-alpha/aaaaaaaa-…/subagents/agent-a1.jsonl` | Subagent (`isSidechain`), `msg_S1FIX` |
| `-home-dev-privat/bbbbbbbb-…jsonl` | Sitzung außerhalb des Filters (Ordner wird gar nicht gelesen) |

Erwartete Summen der eingeschlossenen Anfragen (5 Stück): input 41, output 271, cache_read 2800,
cache_creation 950 (5m 550, 1h 400).
