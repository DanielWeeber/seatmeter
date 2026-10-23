# opentelemetry-proto (vendored)

Unveränderte Kopie der für den OTLP-Empfänger nötigen Dateien aus
https://github.com/open-telemetry/opentelemetry-proto, Tag `v1.11.1` (2026-09-29).
Lizenz: Apache License 2.0, Copyright The OpenTelemetry Authors (`LICENSE` in diesem Ordner, Hinweis in `NOTICE`).

Enthalten: `common`, `resource`, `logs`, `metrics` und die beiden Collector-Dienste (`collector/logs`, `collector/metrics`).

Zur Laufzeit liest der Server diese Dateien nicht; er nutzt den daraus erzeugten Deskriptor
`src/ingest-otlp/otlp-proto.generiert.ts` (Erzeugung: `scripts/proto-generieren.mjs`). Der Test
`test/otlp-proto.test.ts` bricht, wenn Deskriptor und `.proto`-Dateien auseinanderlaufen.
Aktualisieren: Dateien vom neuen Tag holen, Tag hier und im Skript nachziehen, Skript ausführen, Prettier.
