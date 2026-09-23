#!/usr/bin/env bash
# Course Wikipédia « Titanic » -> « Tour Eiffel », pilotée par Claude (claude -p) avec un seul serveur MCP.
# jev : nécessite ./firefox-bench.sh en cours et l'onglet sur la page Titanic (node reset-jev.mjs).
# moz : le serveur de Mozilla lance lui-même son Firefox, ouvert sur la page Titanic.
# Usage : ./race.sh <jev|moz>   (journal horodaté dans work/race/<mcp>-<HHMMSS>.log, puis node extract-races.mjs)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
firefox="${FIREFOX_BIN:-/snap/firefox/current/usr/lib/firefox/firefox}"
which=$1
mkdir -p "$here/work/race"
cd "$here/work/race"
cat > mcp-jev.json <<JSON
{"mcpServers":{"jev":{"command":"$here/../node_modules/.bin/tsx","args":["$here/../server/src/index.ts"],"env":{"JEV_BRIDGE_PORT":"8766"}}}}
JSON
cat > mcp-moz.json <<JSON
{"mcpServers":{"moz":{"command":"node","args":["$here/node_modules/@mozilla/firefox-devtools-mcp/dist/index.js","--headless","--firefoxPath","$firefox","--viewport","1366x768","--startUrl","https://en.wikipedia.org/wiki/Titanic"]}}}
JSON
BASE='The browser is already open on the English Wikipedia article "Titanic". Goal: reach the English Wikipedia article "Eiffel Tower" as fast as possible (the total time counts: your thinking plus the browser), only by clicking links inside pages. Rules: never use a search box, never type text, never open or type a URL, no back navigation. Stop as soon as the current page is the Eiffel Tower article and reply with the list of pages visited.'
if [ "$which" = jev ]; then
  PROMPT="$BASE Prefer browse_goal (autonomous navigation: a fast model picks each link) and only act manually (browser_snapshot then browser_act click) when it hands back to you. Do not use the typeText option."
  ALLOWED="mcp__jev__browse_goal mcp__jev__jev_rank mcp__jev__browser_snapshot mcp__jev__browser_act mcp__jev__browser_scroll mcp__jev__browser_read mcp__jev__browser_status"
  DENIED="mcp__jev__browser_navigate"
else
  PROMPT="$BASE"
  ALLOWED="mcp__moz__take_snapshot mcp__moz__click_by_uid mcp__moz__list_pages mcp__moz__get_page_text mcp__moz__hover_by_uid"
  DENIED="mcp__moz__navigate_page mcp__moz__new_page mcp__moz__navigate_history mcp__moz__type_text mcp__moz__fill_by_uid mcp__moz__fill_form_by_uid mcp__moz__evaluate_script mcp__moz__press_key"
fi
log="$which-$(date +%H%M%S).log"
t0=$(date +%s%3N)
# Aucun outil intégré (pas de recherche web ni de shell) : Claude ne dispose que du serveur MCP testé.
claude -p "$PROMPT" --model opus --tools "" --strict-mcp-config --mcp-config "mcp-$which.json" \
  --setting-sources project --allowedTools $ALLOWED --disallowedTools $DENIED \
  --max-turns 60 --output-format stream-json --verbose 2>&1 | node "$here/timestamp.mjs" "$t0" > "$log"
echo "$log"
