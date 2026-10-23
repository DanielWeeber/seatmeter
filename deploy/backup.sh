#!/bin/sh
# seatmeter: nächtliches Datenbank-Backup (pg_dump -Fc, komprimiert) aus dem laufenden Postgres-Container, 14 Tage lokal.
# Aufruf aus cron, z. B.  0 4 * * * root /pfad/backup.sh
# Umgebung bzw. backup.env neben dem Skript (alle optional):
#   SEATMETER_BACKUP_DIR    Zielordner                          (Standard /var/backups/seatmeter)
#   SEATMETER_DB_CONTAINER  Name des Postgres-Containers         (Standard seatmeter-postgres-1)
#   SEATMETER_BACKUP_TAGE   Aufbewahrung in Tagen                (Standard 14)
#   SEATMETER_BACKUP_HOOK   ausführbare Datei, aufgerufen mit "ok" bzw. "fail <Text>" (Heartbeat/Alarm)
# Der Master-Schlüssel (SEATMETER_MASTER_KEY) steckt NICHT im Dump und muss getrennt gesichert sein.
# Wiederherstellung: deploy/README.md, Abschnitt „Backup und Wiederherstellung“.
set -eu
# Optional: Einstellungen neben dem Skript (backup.env, ohne Secrets), z. B. auf dem Host
KONF="$(dirname "$0")/backup.env"
# shellcheck disable=SC1090
[ ! -f "$KONF" ] || . "$KONF"
ZIEL="${SEATMETER_BACKUP_DIR:-/var/backups/seatmeter}"
DB="${SEATMETER_DB_CONTAINER:-seatmeter-postgres-1}"
TAGE="${SEATMETER_BACKUP_TAGE:-14}"
HOOK="${SEATMETER_BACKUP_HOOK:-}"
STEMPEL=$(date +%F)
DATEI="$ZIEL/seatmeter-$STEMPEL.dump"

melde() { [ -z "$HOOK" ] || "$HOOK" "$@" || true; }
fehler() { echo "seatmeter-Backup fehlgeschlagen: $1" >&2; melde fail "$1"; exit 1; }

umask 077
mkdir -p "$ZIEL" || fehler "Zielordner $ZIEL nicht anlegbar"
docker exec "$DB" pg_dump -U seatmeter -d seatmeter -Fc -Z 6 >"$DATEI.tmp" 2>"$DATEI.err" || {
  M=$(head -c 300 "$DATEI.err" | tr '\n' ' ')
  rm -f "$DATEI.tmp" "$DATEI.err"
  fehler "pg_dump: $M"
}
rm -f "$DATEI.err"
[ -s "$DATEI.tmp" ] || { rm -f "$DATEI.tmp"; fehler "Dump ist leer"; }
# Lesbarkeit prüfen (Inhaltsverzeichnis des Dumps), bevor der alte Stand rotiert wird
docker exec -i "$DB" pg_restore -l >/dev/null <"$DATEI.tmp" || { rm -f "$DATEI.tmp"; fehler "Dump nicht lesbar (pg_restore -l)"; }
mv "$DATEI.tmp" "$DATEI"
find "$ZIEL" -maxdepth 1 -name 'seatmeter-*.dump' -mtime +"$TAGE" -delete
echo "seatmeter-Backup ok: $DATEI ($(du -h "$DATEI" | cut -f1))"
melde ok
