# firefox-jev-mcp

Un serveur MCP qui permet à Claude de piloter Firefox, avec un modèle de décision rapide pour les clics :
**Claude planifie, [Jev](https://docs.typesafe.ai) (TypeSafe) choisit l'élément sur lequel agir**, et
Claude ne reprend la main que quand Jev hésite.

![Course Wikipédia de « Titanic » à « Tour Eiffel » : 14,7 s contre 23,4 s](bench/charts/1-course-temps.png)

## Pourquoi

Avec un serveur MCP de navigateur classique, le LLM relit la page et décide de **chaque** clic : un tour de
modèle par action, soit quelques secondes à chaque fois. Or la plupart des clics sont des décisions simples
(« quel lien mène à Paris ? »). firefox-jev-mcp les confie à Jev, un modèle qui ne génère pas de texte mais
renvoie une probabilité par élément de la page, en environ une seconde. Claude garde ce qu'il fait le mieux :
comprendre la demande, planifier, trancher les cas ambigus.

## Résultats

Même tâche, même prompt, même modèle (Claude Opus 5.5 via `claude -p`), deux courses lancées en parallèle :
partir de l'article Wikipédia « Titanic » et atteindre « Tour Eiffel » en cliquant uniquement sur des liens
(ni recherche, ni saisie, ni URL tapée, ni retour arrière).

| Course Wikipédia | **firefox-jev-mcp** | Mozilla firefox-devtools-mcp |
|---|:---:|:---:|
| Temps total | **14,7 s** | 23,4 s |
| dont réflexion de Claude | **7,9 s** | 19,1 s |
| Tours de Claude | **4** | 12 |
| Tokens Claude | **20,8 k** | 88,5 k |
| Coût par course, Claude et Jev compris | **0,033 €** | 0,050 € |

Sur 4 courses, firefox-jev-mcp est arrivé premier à chaque fois : 17,2 / 19,2 / 22,7 / 14,7 s contre
23,5 / 20,2 / 27,8 / 23,4 s (les premières avec des versions antérieures du serveur).

![Coût de 1 000 courses : 32,74 € contre 49,60 €](bench/charts/2-course-cout.png)

Les actions de base, mesurées sans LLM sur 4 pages réelles (médiane de 4 passages après un passage de chauffe) :

| Actions de base | **firefox-jev-mcp** | Mozilla firefox-devtools-mcp | Google chrome-devtools-mcp | Playwright MCP | Playwright MCP |
|---|:---:|:---:|:---:|:---:|:---:|
| Navigateur | Firefox | Firefox | Chrome | Chrome | Firefox |
| Clic, jusqu'à la page suivante chargée | **181 ms** | 290 ms ¹ | 326 ms | 958 ms | 1 257 ms |
| Navigation vers une URL | 186 ms | **129 ms** ² | 280 ms | 248 ms | 388 ms |
| Snapshot d'un article Wikipédia, en tokens ³ | 3,7 k | 1,1 k ⁴ | 215 k | 209 k | 209 k |

¹ Médiane sur 3 pages : son snapshot ne montre pas les liens de navigation de Hacker News.
² Rend la main dès que le HTML est analysé (DOMContentLoaded), avant la fin du chargement.
³ Estimation : caractères divisés par 4.
⁴ Tronqué à 100 lignes par défaut.

![Temps d'un clic : 181 ms, le plus rapide des 5 serveurs MCP testés](bench/charts/3-latence-clic.png)

Tarifs utilisés : prix publics des API (Claude Opus 5.5, Jev 1.13 à 0,042 $ par million de tokens d'entrée,
sortie gratuite), taux BCE du 23/09/2026. Méthode, données brutes et scripts pour tout reproduire :
[`bench/`](bench/README.md).

## Comment ça marche

```
Claude Code
   |  outils MCP (stdio)
   v
Serveur MCP local (server/, TypeScript)
   |-- API Jev : un Choice sur les éléments de la page + un Noul « objectif atteint ? »,
   |             puis des Nouls de vérification quand le Choice hésite
   |
   |  WebSocket ws://127.0.0.1:8765 (origine moz-extension:// uniquement)
   v
Extension Firefox (extension/)
   |-- content.js : extraction des éléments interactifs, clics, saisie, attente de fin d'affichage
   '-- background.js : pont WebSocket, onglets, navigation, iframes, suivi réseau, copie des PDF reçus
```

Avant chaque lecture (`browser_snapshot`, `browser_read`, étapes de `browse_goal`), l'extension attend que la page
ait fini de s'afficher : fin des requêtes de données de l'onglet, structure stable depuis 250 ms, plus
d'indicateur de chargement visible (« Chargement en cours… », `aria-busy`, barre de progression sans valeur).
Elle attend 4 s au plus, et signale un indicateur encore visible. Une page déjà affichée est lue sans délai.

L'outil `browse_goal` enchaîne seul : snapshot de la page, décision de Jev, action, et ainsi de suite jusqu'à
l'objectif. Il s'arrête quand l'objectif est atteint, quand Jev hésite ou quand l'action est sensible (payer,
supprimer, envoyer...), et renvoie alors à Claude les meilleurs candidats, directement utilisables. Claude
reste l'orchestrateur : l'extension ne contacte jamais Claude, ce qui fonctionne avec un abonnement Claude,
sans clé API Anthropic.

<details>
<summary><b>Comment Jev décide, étape par étape</b></summary>

1. **Fusion des doublons.** Les liens qui mènent à la même URL (menu, carte, pied de page) deviennent une seule
   option. Les probabilités d'un Choice font toujours 1 au total : sans fusion, Jev répartit la sienne entre des
   liens équivalents et sa confiance baisse alors qu'il n'hésite pas sur la destination.
2. **Éléments déjà utilisés retirés.** Un élément déjà cliqué ou rempli sur la page courante n'est plus proposé,
   ce qui évite les boucles.
3. **Texte à saisir connu de Jev.** Avec `typeText`, Jev sait qu'une recherche est possible. Sans `typeText`,
   les champs de recherche ne lui sont pas proposés.
4. **Choice + Noul « objectif atteint ? »** dans une seule requête.
5. **Vérification quand le Choice hésite.** Sous `minConfidence` (0,6), un second appel pose un Noul par candidat
   parmi les 3 premiers : « cette action fait-elle avancer vers l'objectif ? ». Le Choice est relatif et partage
   sa probabilité entre plusieurs chemins valables ; le Noul est absolu. La boucle agit si le candidat choisi
   atteint `verifyThreshold` (0,8), sinon elle rend la main à Claude.
6. **Contrôle d'arrivée.** Après chaque action, un Noul voit la page précédente, l'action faite et la page
   courante, pour les objectifs définis par la page de départ (« la 3e histoire », « le livre le moins cher »).
7. **Listes déroulantes.** Un Choice sur les options désigne la valeur à sélectionner. Une liste dessinée par la
   page (combobox ARIA : Angular Material, React Select...) n'a souvent ses options qu'une fois ouverte : la boucle
   la clique d'abord, puis `select` clique l'option et referme la liste.
8. **Saisie.** `typeText` n'est tapé qu'une fois, et Entrée n'est pressée que dans un champ de recherche.

Au-delà de 250 options (l'API limite un Choice à 255), la décision se fait en deux passes : un Choice par
tranche de 200, en requêtes parallèles, puis un Choice final sur les 5 meilleurs de chaque tranche.

</details>

## Installation

Prérequis : Node.js 20 ou plus, Firefox 142 ou plus, une clé API TypeSafe ([console.typesafe.ai](https://console.typesafe.ai)),
et `pdftotext` pour lire les PDF (paquet `poppler-utils`).

```bash
npm install
cp .env.example .env   # puis renseigner TYPESAFE_API_KEY
```

1. Brancher le serveur sur Claude Code pour tous les projets :

   ```bash
   claude mcp add firefox-jev --scope user -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/server/src/index.ts"
   ```

   Ou lancer `claude` depuis ce dossier : le fichier `.mcp.json` est détecté. Le serveur n'ouvre le port 8765 qu'au
   premier appel d'outil : les sessions qui ne se servent pas de Firefox ne le bloquent pas.

2. Installer la commande `/firefox`, disponible dans tous les projets :

   ```bash
   ln -s "$(pwd)/skills/firefox" ~/.claude/skills/firefox
   ```

3. Demander par exemple à Claude : `/firefox ouvre la documentation de l'API sur example.com`. La commande lance
   Firefox si besoin (outil `browser_launch`), puis enchaîne les outils.

Pour lancer Firefox à la main, avec l'extension, dans le profil dédié (`./firefox-profile`, créé au premier
lancement) : `npm run firefox`. Le badge de l'extension affiche `ON` quand une session Claude Code est connectée.

### Piloter ton Firefox habituel

L'extension peut aussi tourner dans ton profil Firefox de tous les jours, pour agir sur les pages que tu as déjà
ouvertes (reprendre un formulaire à partir d'un mail, par exemple). Elle y est **désactivée par défaut** : un clic
sur son bouton donne la main à Claude (badge `ON`), un second clic la reprend. Tant qu'elle est activée, elle passe
avant le profil dédié, qui se reconnecte dès qu'on la coupe.

Claude travaille dans son propre onglet, en arrière-plan : l'onglet que tu regardes reste affiché (un stream
continue), et les outils sans `tabId` visent l'onglet où Claude travaille. Au premier appel, Claude ne reprend
l'onglet actif que s'il est vide ; sinon il ouvre le sien. Pour voir sa page, demande-lui de l'afficher
(`activate`).

Firefox n'installe à demeure que des extensions signées par Mozilla. La signature « non listée » est gratuite et
l'extension n'est pas publiée :

1. Créer des clés sur [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/)
   et les renseigner dans `.env` (`WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET`).
2. `npm run sign` : le fichier `.xpi` signé arrive dans `web-ext-artifacts/`. Chaque nouvelle signature demande
   d'augmenter la version dans `extension/manifest.json`. Depuis la 0.3.0, l'extension demande en plus l'accès aux
   requêtes réseau (`webRequest`), pour suivre le chargement des pages et garder une copie des PDF : Firefox le
   fait accepter à la mise à jour.
3. L'ouvrir dans Firefox (glisser le fichier dans une fenêtre, ou `about:addons` puis « Installer un module
   depuis un fichier »).

Pour essayer sans signer : `about:debugging`, « Ce Firefox », « Charger un module complémentaire temporaire » et
choisir `extension/manifest.json`. Chargée ainsi, l'extension se comporte comme dans le profil dédié : elle se
connecte d'elle-même, et disparaît au redémarrage de Firefox.

## Outils MCP

| Outil | Rôle |
|---|---|
| `browser_launch` | Lance Firefox avec l'extension si aucun n'est connecté |
| `browse_goal` | Navigation autonome vers un objectif : snapshot, décision de Jev, action, en boucle |
| `jev_rank` | Classement des éléments de la page par Jev pour un objectif, sans agir |
| `browser_snapshot` | Éléments interactifs visibles, avec un ref (`e1`, `e2`...) |
| `browser_act` | `click`, `type` (avec `submit` pour Entrée) ou `select` sur un ref |
| `browser_upload` | Dépose des fichiers locaux (CV, lettre...) dans un champ fichier ou une zone de glisser-déposer |
| `browser_save` | Enregistre sur le disque le PDF affiché dans l'onglet, la cible d'un lien ou une URL, sans rien écraser |
| `browser_navigate` | Ouvrir une URL ou revenir en arrière, en arrière-plan ; `activate` montre l'onglet |
| `browser_read` | Texte visible de la page, iframes comprises, ou texte du PDF affiché dans l'onglet |
| `browser_scroll` | Défiler d'un écran |
| `browser_status` | Connexion à l'extension, présence de la clé Jev, onglets (affiché, celui de Claude), PDF récents |

<details>
<summary><b>Statuts de <code>browse_goal</code></b></summary>

- `done` : Jev estime que la page satisfait l'objectif (`goalThreshold`, 0,85 par défaut).
- `need_decision` : Claude doit trancher ; `reason` explique pourquoi et `candidates` donne les 5 meilleurs refs.
- `max_steps` : nombre d'étapes atteint (`maxSteps`, 6 par défaut).
- `error` : incident technique ; les étapes déjà faites sont conservées.

</details>

## Limites connues

- **Clics synthétiques** : Firefox n'offre pas aux extensions d'équivalent à l'API `debugger` de Chrome. Les
  événements ont `isTrusted = false`, ce que certains sites (anti-bot, paiement, OAuth) ignorent.
- **Iframes** explorées sur 3 niveaux, même d'une autre origine ; le contenu d'une fenêtre modale passe en premier.
  Un lien d'iframe qui vise la page entière (`target="_top"`) est ouvert par l'onglet : Firefox bloque cette
  navigation sans vrai clic. Shadow DOM ouverts et fermés pris en charge.
- **PDF** : la visionneuse de Firefox est fermée aux extensions. L'extension garde donc une copie des 10 derniers
  PDF reçus (30 Mo au plus chacun, en mémoire, oubliés quand elle est coupée) : `browser_read` en extrait le texte
  et `browser_save` les enregistre, même quand le site ne sert un document qu'une fois ou qu'un autre PDF l'a
  remplacé dans l'onglet.
- **Onglets en arrière-plan** : Firefox y ralentit les pages. L'extension fait compter ses attentes par son script
  de fond, qui ne l'est pas, mais quelques sites n'affichent leur contenu qu'une fois visibles (chargement au
  défilement, rendu à l'image suivante) : afficher alors l'onglet avec `activate`.
- **1 000 éléments au plus** par snapshot : sur un très long article, les derniers liens ne sont pas proposés.
- **Une seule session** pilote Firefox à la fois : la dernière à appeler un outil prend la main, et une requête
  en cours dans l'autre session échoue.
- **Planification** : Jev excelle quand le lien cible est sur la page, moins pour choisir une page intermédiaire.
  Il rend alors la main à Claude.
- **Langue** : Jev est surtout entraîné en anglais ; formuler les objectifs en anglais donne de meilleurs résultats.
- **Confidentialité** : l'URL, le titre, les libellés des éléments et le début du texte des pages visitées par
  `browse_goal` ou `jev_rank` sont envoyés à l'API TypeSafe. La commande `/firefox` passe par Jev pour tous les
  clics, y compris dans le profil habituel, sur les pages où tu es connecté.

## Licence

MIT, voir [LICENSE](LICENSE).
