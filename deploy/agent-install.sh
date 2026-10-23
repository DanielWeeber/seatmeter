#!/bin/sh
# Installiert den seatmeter-agent aus einem Release nach ~/.seatmeter/bin (Architektur §0, §10.3).
# Aufruf (Release-Basis = Download-Ordner eines Tags, z. B. Forgejo/GitHub):
#   curl -fsSL <release-url>/agent-install.sh | SEATMETER_RELEASE_URL=<release-url> sh
#   <release-url> = https://<forgejo-host>/<org>/seatmeter/releases/download/v<version>
# Release-Dateien: seatmeter-agent-darwin-arm64, seatmeter-agent-linux-x64 (Einzeldatei-Binaries, bun --compile,
# ohne Node), seatmeter-agent.mjs (JS-Bündel, Node ≥ 22), SHA256SUMS, agent-install.sh.
# Variablen:
#   SEATMETER_RELEASE_URL     Basis-URL des Releases (Pflicht, außer SEATMETER_AGENT_DATEI ist gesetzt)
#   SEATMETER_FORMAT          auto (Standard: Binary für macOS arm64 und Linux x64, sonst JS-Bündel) | binary | js
#   SEATMETER_DOWNLOAD_TOKEN  Lese-Token für private Repos (Header „Authorization: token …“; geht über stdin an
#                             curl, nie als Argument). Nie in Chats, Tickets oder Skripte schreiben.
#   SEATMETER_AGENT_DATEI     lokale Datei (Binary oder .mjs) statt Download
#   SEATMETER_SHA256          erwartete SHA-256-Prüfsumme (sonst aus SHA256SUMS des Releases; Pflicht beim Download)
#   SEATMETER_HOME            Zielordner (Standard ~/.seatmeter)
# Das Skript ändert keine Claude-Code-Einstellungen; Hooks bzw. Sweeper richtet erst `seatmeter-agent install` ein.
# Nach einem Update `seatmeter-agent install …` erneut ausführen, damit der Sweeper auf die neue Datei zeigt.
set -eu

ZIEL="${SEATMETER_HOME:-$HOME/.seatmeter}"
BIN="$ZIEL/bin"
FORMAT="${SEATMETER_FORMAT:-auto}"

fehler() {
  echo "seatmeter-agent-install: $*" >&2
  exit 1
}

# Format und Release-Datei wählen.
SYSTEM="$(uname -s)"
ARCH="$(uname -m)"
BINARY=""
case "$SYSTEM/$ARCH" in
  Darwin/arm64) BINARY="seatmeter-agent-darwin-arm64" ;;
  Linux/x86_64 | Linux/amd64) BINARY="seatmeter-agent-linux-x64" ;;
esac
case "$FORMAT" in
  auto) if [ -n "$BINARY" ]; then FORMAT=binary; else FORMAT=js; fi ;;
  binary) [ -n "$BINARY" ] || fehler "Kein Binary für $SYSTEM/$ARCH; SEATMETER_FORMAT=js nutzen (Node ≥ 22)." ;;
  js) ;;
  *) fehler "SEATMETER_FORMAT muss auto, binary oder js sein." ;;
esac
if [ -n "${SEATMETER_AGENT_DATEI:-}" ]; then
  case "$SEATMETER_AGENT_DATEI" in *.mjs | *.js) FORMAT=js ;; *) FORMAT=binary ;; esac
fi
if [ "$FORMAT" = binary ]; then DATEI="$BINARY"; else DATEI="seatmeter-agent.mjs"; fi

NODE=""
if [ "$FORMAT" = js ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || fehler "Node.js ≥ 22 fehlt (https://nodejs.org) – oder ein Binary-Release nutzen."
  "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
    fehler "Node.js ist zu alt ($("$NODE" --version)); benötigt wird ≥ 22."
fi

laden() { # $1 = URL, $2 = Zieldatei
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${SEATMETER_DOWNLOAD_TOKEN:-}" ]; then
      printf 'header = "Authorization: token %s"\n' "$SEATMETER_DOWNLOAD_TOKEN" |
        curl -fsSL --proto '=https' -K - -o "$2" "$1"
    else
      curl -fsSL --proto '=https' -o "$2" "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    [ -z "${SEATMETER_DOWNLOAD_TOKEN:-}" ] || fehler "SEATMETER_DOWNLOAD_TOKEN braucht curl."
    wget -q -O "$2" "$1"
  else
    fehler "curl oder wget fehlt."
  fi
}

# Private Repos leiten ohne Token auf die Anmeldeseite um (HTTP 200 mit HTML statt der Datei).
kein_html() { # $1 = Datei
  if head -c 512 "$1" | grep -qi '<!doctype html\|<html'; then
    fehler "Antwort ist eine HTML-Seite statt der Datei (Anmeldung?). Privates Repo: SEATMETER_DOWNLOAD_TOKEN setzen."
  fi
}

pruefsumme() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$BIN"
chmod 700 "$ZIEL"
TMP="$BIN/.seatmeter-agent.neu"
SUMMEN="$BIN/.SHA256SUMS.neu"
trap 'rm -f "$TMP" "$SUMMEN"' EXIT

ERWARTET="${SEATMETER_SHA256:-}"
if [ -n "${SEATMETER_AGENT_DATEI:-}" ]; then
  cp "$SEATMETER_AGENT_DATEI" "$TMP"
else
  URL="${SEATMETER_RELEASE_URL:-}"
  case "$URL" in
    "" | *"<"*) fehler "SEATMETER_RELEASE_URL setzen (Download-Ordner des Releases, z. B. …/releases/download/v0.1.0)." ;;
    https://*) ;;
    *) fehler "SEATMETER_RELEASE_URL muss mit https:// beginnen." ;;
  esac
  URL="${URL%/}"
  laden "$URL/$DATEI" "$TMP" || fehler "Download fehlgeschlagen: $URL/$DATEI (privates Repo? SEATMETER_DOWNLOAD_TOKEN setzen)"
  kein_html "$TMP"
  if [ -z "$ERWARTET" ]; then
    laden "$URL/SHA256SUMS" "$SUMMEN" || fehler "SHA256SUMS fehlt im Release."
    kein_html "$SUMMEN"
    ERWARTET="$(awk -v d="$DATEI" '$2 == d || $2 == "*" d { print $1 }' "$SUMMEN")"
    [ -n "$ERWARTET" ] || fehler "Keine Prüfsumme für $DATEI in SHA256SUMS."
  fi
fi

if [ -n "$ERWARTET" ]; then
  IST="$(pruefsumme "$TMP")"
  [ "$IST" = "$ERWARTET" ] || fehler "Prüfsumme stimmt nicht (erwartet $ERWARTET, ist $IST)."
fi

if [ "$FORMAT" = js ]; then
  head -c 64 "$TMP" | grep -q '^#!/usr/bin/env node' || fehler "Datei ist kein seatmeter-agent-Bündel."
  chmod 755 "$TMP"
  mv "$TMP" "$BIN/seatmeter-agent.mjs"
  # Startskript mit festem Node-Pfad (launchd/systemd kennen den PATH der Shell nicht).
  cat >"$BIN/seatmeter-agent.neu" <<SKRIPT
#!/bin/sh
exec "$NODE" "$BIN/seatmeter-agent.mjs" "\$@"
SKRIPT
  chmod 755 "$BIN/seatmeter-agent.neu"
  mv "$BIN/seatmeter-agent.neu" "$BIN/seatmeter-agent"
else
  chmod 755 "$TMP"
  # macOS: per curl geladene Dateien haben kein Quarantäne-Attribut; zur Sicherheit entfernen (ad-hoc-signiert,
  # ohne Notarisierung in v1).
  if [ "$SYSTEM" = Darwin ]; then xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true; fi
  "$TMP" --version >/dev/null 2>&1 || fehler "Binary startet nicht auf $SYSTEM/$ARCH."
  mv "$TMP" "$BIN/seatmeter-agent"
fi
trap - EXIT
rm -f "$SUMMEN"

VERSION="$("$BIN/seatmeter-agent" --version)"
cat <<HINWEIS
seatmeter-agent $VERSION installiert ($FORMAT): $BIN/seatmeter-agent

Nächste Schritte:
  1. Einmalcode im seatmeter-Dashboard unter „Rechner/Agenten“ oder „Ausrollen“ erzeugen.
  2. $BIN/seatmeter-agent enroll <EINMALCODE> --server https://<ingest-host>
  3. $BIN/seatmeter-agent install --sweeper-only --include <pfad> [--projekt-pfad <pfad>=<name>]
     (oder: install --hooks; nach einem Update erneut ausführen)
  4. $BIN/seatmeter-agent status

Optional in den PATH: export PATH="$BIN:\$PATH"
HINWEIS
