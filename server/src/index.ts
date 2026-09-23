import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { browseGoal } from "./agent.js";
import { Bridge } from "./bridge.js";
import { decide, describe, hasJevKey, round } from "./jev.js";
import { log } from "./log.js";
import { ACT_ACTIONS, tabInfo, type ActResult, type Snapshot, type TabInfo } from "./types.js";

// .env à la racine du projet, quel que soit le dossier depuis lequel Claude Code lance le serveur.
const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const bridge = new Bridge(Number(process.env.JEV_BRIDGE_PORT ?? 8765));
bridge.start();

const server = new McpServer({ name: "firefox-jev", version: "0.1.0" });

// Transforme le retour (ou l'erreur) d'un outil en réponse MCP texte.
function run<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      const out = await fn(args);
      return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Erreur : ${(err as Error).message}` }], isError: true };
    }
  };
}

const tabId = z.number().int().optional().describe("Onglet cible. Par défaut : l'onglet actif de Firefox.");

server.registerTool(
  "browser_status",
  {
    description: "État de la connexion avec Firefox et liste des onglets ouverts.",
    annotations: { readOnlyHint: true },
  },
  run(async () => ({
    extensionConnected: bridge.connected,
    extensionVersion: bridge.extensionVersion,
    websocket: bridge.startError ? `erreur : ${bridge.startError}` : bridge.url,
    jevKeyConfigured: hasJevKey(),
    tabs: bridge.connected ? await bridge.call<TabInfo[]>("list_tabs") : [],
  })),
);

server.registerTool(
  "browser_navigate",
  {
    description: "Ouvre une URL dans l'onglet actif (ou un nouvel onglet), ou revient à la page précédente.",
    inputSchema: {
      url: z.string().url().optional().describe("URL à ouvrir"),
      newTab: z.boolean().optional().describe("Ouvrir dans un nouvel onglet"),
      back: z.boolean().optional().describe("Revenir à la page précédente au lieu d'ouvrir une URL"),
      tabId,
    },
    annotations: { openWorldHint: true },
  },
  run(async ({ url, newTab, back, tabId }) => {
    if (!url && !back) throw new Error("Fournir url ou back: true");
    return bridge.call<TabInfo>("navigate", { url, newTab, back, tabId });
  }),
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Liste les éléments interactifs visibles de la page (liens, boutons, champs...) avec un ref (e1, e2...) " +
      "utilisable par browser_act. Chaque snapshot invalide les refs précédents.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).default(200).describe("Nombre maximal d'éléments"),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  run(async ({ limit, tabId }) => {
    const snap = await bridge.call<Snapshot>("snapshot", { tabId, limit });
    const header = [
      `${snap.title}`,
      `${snap.url} (onglet ${snap.tabId})`,
      `${snap.elements.length} éléments visibles${snap.truncated ? ` (limite atteinte, ${snap.total} candidats au total)` : ""}`,
      "",
    ];
    return header.concat(snap.elements.map((el) => `${el.ref} ${describe(el)}${el.disabled ? ", disabled" : ""}`)).join("\n");
  }),
);

server.registerTool(
  "browser_act",
  {
    description:
      "Agit sur un élément du dernier snapshot : click, type (saisir du texte, submit pour valider avec Entrée) " +
      "ou select (choisir une option d'une liste déroulante par sa valeur ou son libellé).",
    inputSchema: {
      ref: z.string().describe("ref de l'élément, issu du dernier snapshot (ex. e12)"),
      action: z.enum(ACT_ACTIONS),
      text: z.string().optional().describe("Texte à saisir (type) ou option à choisir (select)"),
      submit: z.boolean().optional().describe("Avec type : appuyer sur Entrée après la saisie"),
      tabId,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  run(async (args) => bridge.call<ActResult>("act", args)),
);

server.registerTool(
  "browser_read",
  {
    description: "Renvoie le texte visible de la page, pour lire ou vérifier son contenu.",
    inputSchema: {
      maxChars: z.number().int().min(100).max(50_000).default(8000),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  run(async ({ maxChars, tabId }) => bridge.call<TabInfo & { text: string }>("read_text", { maxChars, tabId })),
);

server.registerTool(
  "browser_scroll",
  {
    description: "Fait défiler la page d'un écran vers le haut ou vers le bas.",
    inputSchema: { direction: z.enum(["up", "down"]), tabId },
    annotations: { readOnlyHint: true },
  },
  run(async (args) => bridge.call("scroll", args)),
);

server.registerTool(
  "jev_rank",
  {
    description:
      "Demande à Jev de classer les éléments de la page pour un objectif, sans agir. Renvoie les 5 meilleurs " +
      "candidats avec leur probabilité (relative), le fit des 3 premiers (Noul absolu : cette action fait-elle " +
      "avancer ?), la confiance de Jev et la probabilité que la page satisfasse déjà l'objectif.",
    inputSchema: {
      goal: z.string().min(3).describe("Objectif, de préférence en anglais (langue principale de Jev)"),
      typeText: z.string().optional().describe("Texte qui serait tapé dans un champ de recherche, comme pour browse_goal"),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  run(async ({ goal, typeText, tabId }) => {
    const snap = await bridge.call<Snapshot>("snapshot", { tabId });
    const d = await decide(goal, snap, [], { typeText, verifyBelow: Infinity });
    return {
      page: tabInfo(snap),
      elementsOnPage: snap.elements.length,
      choice: d.choice ?? "aucun élément pertinent",
      confidence: round(d.confidence),
      goalReachedProbability: round(d.goalReached),
      candidates: d.candidates,
      jev: { calls: d.calls, inputTokens: d.inputTokens },
    };
  }),
);

server.registerTool(
  "browse_goal",
  {
    description:
      "Navigue seul vers un objectif : à chaque étape, Jev choisit l'élément le plus probable et l'extension agit. " +
      "S'arrête quand l'objectif semble atteint (status done), quand Jev hésite, veut saisir du texte ou déclencher " +
      "une action sensible (status need_decision, avec les meilleurs candidats), ou après maxSteps. " +
      "À privilégier pour les suites de clics simples ; garder la réflexion et la saisie de contenu pour soi.",
    inputSchema: {
      goal: z.string().min(3).describe("Objectif concret, de préférence en anglais (ex. 'open the API reference documentation')"),
      maxSteps: z.number().int().min(1).max(20).default(6),
      minConfidence: z.number().min(0).max(1).default(0.6).describe("Confiance Jev au-dessus de laquelle on agit sans vérification"),
      verifyThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.8)
        .describe("Sous minConfidence, fit minimal (Noul de vérification) du candidat choisi pour agir quand même. 1 désactive la vérification"),
      goalThreshold: z.number().min(0).max(1).default(0.85).describe("Probabilité d'objectif atteint pour s'arrêter"),
      typeText: z.string().optional().describe("Texte à taper si Jev choisit un champ de saisie (ex. une recherche)"),
      allowRisky: z.boolean().default(false).describe("Autoriser les clics sur des actions sensibles (supprimer, payer, envoyer...)"),
      tabId,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  run(async (args) => browseGoal(bridge, args)),
);

await server.connect(new StdioServerTransport());
// Le serveur WebSocket garderait le process en vie (et le port occupé) après la fin de la session Claude Code.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
log(`serveur MCP prêt${hasJevKey() ? "" : " (TYPESAFE_API_KEY absente : jev_rank et browse_goal indisponibles)"}`);
