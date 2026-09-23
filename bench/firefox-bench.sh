#!/usr/bin/env bash
# Lance un Firefox sans interface avec une copie de l'extension sur le port 8766, pour mesurer firefox-jev-mcp
# sans gêner un serveur MCP déjà ouvert dans une session Claude Code (port 8765). Profil dédié : work/profile-bench.
# Usage : ./firefox-bench.sh   (laisser tourner pendant les mesures)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
firefox="${FIREFOX_BIN:-/snap/firefox/current/usr/lib/firefox/firefox}"
cd "$here"
mkdir -p work
rm -rf work/ext-bench
cp -r ../extension work/ext-bench
sed -i 's#ws://127.0.0.1:8765#ws://127.0.0.1:8766#' work/ext-bench/background.js
exec ../node_modules/.bin/web-ext run --no-input --firefox="$firefox" --source-dir work/ext-bench \
  --firefox-profile work/profile-bench --profile-create-if-missing --keep-profile-changes --no-reload \
  --arg=-headless --start-url https://en.wikipedia.org/wiki/Titanic
