# Benchmark

Deux mesures, toutes deux reproductibles avec les scripts de ce dossier.

## 1. Course Wikipédia, avec Claude

Claude (Opus 5.5, en mode non interactif `claude -p`) reçoit le même prompt avec un seul serveur MCP : partir de
l'article Wikipédia « Titanic » et atteindre « Tour Eiffel » en cliquant uniquement sur des liens. Il n'a aucun
autre outil (ni recherche web, ni shell), et les outils de saisie, de navigation par URL et de retour arrière
lui sont retirés. Les deux courses (firefox-jev-mcp et Mozilla firefox-devtools-mcp) sont lancées en parallèle,
chacune avec son propre Firefox 155 sans interface. Le temps compté va du lancement de `claude -p` à sa réponse
finale : réflexion de Claude, navigateur, Jev et démarrage compris.

```bash
cd bench && npm install
./firefox-bench.sh &                       # Firefox de banc pour firefox-jev-mcp (port 8766)
node reset-jev.mjs                         # onglet sur la page Titanic
./race.sh jev & ./race.sh moz & wait       # journaux dans work/race/
node extract-races.mjs                     # résumé dans data/races.json
```

## 2. Actions de base, sans LLM

Un client MCP appelle directement chaque serveur sur 4 pages réelles (books.toscrape.com, Hacker News, article
Wikipédia « Firefox » et recherche Wikipédia) : navigation, snapshot, clic ou saisie jusqu'à l'arrivée sur la
page suivante, puis nouveau snapshot. 5 passages par serveur ; le premier sert de chauffe et n'est pas compté.

```bash
node bench.mjs jev 5          # nécessite ./firefox-bench.sh
node bench.mjs mozilla 5      # les autres serveurs lancent leur propre navigateur
node bench.mjs playwright 5
node bench.mjs chrome 5
node bench.mjs playwright-chrome 5
```

## Graphiques

```bash
node charts/make-charts.mjs   # lit data/, écrit charts/*.png (nécessite Google Chrome pour le rendu)
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `data/races.json` | Courses Wikipédia : temps, tours et tokens de Claude, appels et tokens de Jev, déroulé des appels d'outils |
| `data/results-*.json` | Actions de base, mesure par mesure |
| `servers.mjs` | Lancement des serveurs MCP comparés |
| `bench.mjs` | Mesure des actions de base |
| `race.sh`, `timestamp.mjs` | Une course pilotée par `claude -p`, journal horodaté |
| `extract-races.mjs`, `race-report.mjs` | Résumé des journaux de course |
| `firefox-bench.sh`, `reset-jev.mjs` | Firefox de banc pour firefox-jev-mcp |
| `probe.mjs`, `list-tools.mjs` | Appels ponctuels à un serveur MCP, pour le débogage |

Le binaire Firefox se règle avec `FIREFOX_BIN` (par défaut, celui du snap d'Ubuntu). Les coûts utilisent les
tarifs publics des API (constantes en haut de `charts/make-charts.mjs`).
