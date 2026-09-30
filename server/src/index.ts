import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { browseGoal } from "./agent.js";
import { Bridge } from "./bridge.js";
import { expandHome, pdfText, saveFile } from "./files.js";
import { decide, describe, hasJevKey, round } from "./jev.js";
import { log } from "./log.js";
import {
  ACT_ACTIONS,
  pdfHint,
  tabInfo,
  type ActResult,
  type FilePayload,
  type ReadResult,
  type Snapshot,
  type TabInfo,
  type UploadResult,
} from "./types.js";

// Racine du projet (.env, profil Firefox dédié, scripts npm), quel que soit le dossier depuis lequel Claude Code
// lance le serveur.
const root = fileURLToPath(new URL("../../", import.meta.url));
const envPath = join(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Le premier lancement de Firefox crée le profil dédié : compter large.
const LAUNCH_WAIT_MS = 30_000;

// Les fichiers passent en base64 par le WebSocket : de quoi couvrir un CV ou une lettre, pas une vidéo.
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// Un PDF ou un fichier à enregistrer passe en base64 par le WebSocket : laisser le temps du transfert.
const FILE_TIMEOUT_MS = 60_000;

// Le port n'est ouvert qu'au premier appel d'outil (voir Bridge).
const bridge = new Bridge(Number(process.env.JEV_BRIDGE_PORT ?? 8765));

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

const profileLabel = (): string =>
  bridge.profile === "default"
    ? "profil habituel de l'utilisateur : ses onglets et ses comptes, ouvrir ses propres pages dans un nouvel onglet"
    : "profil dédié";

const tabId = z
  .number()
  .int()
  .optional()
  .describe("Onglet cible. Par défaut : l'onglet où Claude travaille (celui du dernier appel), sinon l'onglet actif");

server.registerTool(
  "browser_status",
  {
    description:
      "État de la connexion avec Firefox et liste des onglets ouverts (active : affiché à l'utilisateur ; claude : " +
      "onglet où Claude travaille). Si une autre session Claude Code pilotait Firefox, cette session prend la main.",
    annotations: { readOnlyHint: true },
  },
  run(async () => {
    const connected = await bridge.connect().catch(() => false);
    return {
      extensionConnected: connected,
      profile: connected ? profileLabel() : undefined,
      extensionVersion: bridge.extensionVersion,
      websocket: bridge.startError ? `erreur : ${bridge.startError}` : bridge.url,
      jevKeyConfigured: hasJevKey(),
      tabs: connected ? await bridge.call<TabInfo[]>("list_tabs") : [],
      // Relevés, factures... affichés récemment : browser_save les enregistre par leur URL.
      recentPdfs: connected ? await bridge.call<unknown[]>("recent_pdfs").catch(() => undefined) : undefined,
    };
  }),
);

server.registerTool(
  "browser_launch",
  {
    description:
      "Lance Firefox avec l'extension, dans le profil dédié, et attend qu'elle se connecte. Sans effet si " +
      "Firefox est déjà connecté.",
    annotations: { idempotentHint: true },
  },
  run(async () => {
    if (await bridge.connect(2000)) return `Firefox est déjà connecté (${profileLabel()}).`;
    // Détaché : Firefox reste ouvert après la fin de la session Claude Code.
    const child = spawn("npm", ["run", "firefox"], { cwd: root, detached: true, stdio: "ignore" });
    child.unref();
    const failed = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(new Error(`lancement impossible : ${err.message}`)));
      child.once("exit", (code) => reject(new Error(`\`npm run firefox\` s'est arrêté (code ${code}) : le lancer dans ${root} pour voir l'erreur`)));
    });
    if (!(await Promise.race([bridge.connect(LAUNCH_WAIT_MS), failed]))) {
      throw new Error(`Firefox lancé, mais l'extension ne s'est pas connectée en ${LAUNCH_WAIT_MS / 1000} s`);
    }
    return "Firefox lancé et connecté.";
  }),
);

server.registerTool(
  "browser_navigate",
  {
    description:
      "Ouvre une URL ou revient à la page précédente, dans l'onglet où Claude travaille ou un nouvel onglet, sans " +
      "changer l'onglet affiché à l'utilisateur. Au premier appel, un onglet actif non vide n'est pas remplacé : " +
      "la page s'ouvre dans un nouvel onglet en arrière-plan. activate montre l'onglet à l'utilisateur (seul, " +
      "il affiche l'onglet sans naviguer).",
    inputSchema: {
      url: z.string().url().optional().describe("URL à ouvrir"),
      newTab: z.boolean().optional().describe("Ouvrir dans un nouvel onglet"),
      back: z.boolean().optional().describe("Revenir à la page précédente au lieu d'ouvrir une URL"),
      activate: z.boolean().optional().describe("Rendre l'onglet actif, quand l'utilisateur veut voir la page"),
      tabId,
    },
    annotations: { openWorldHint: true },
  },
  run(async ({ url, newTab, back, activate, tabId }) => {
    if (!url && !back && !activate) throw new Error("Fournir url, back: true ou activate: true");
    return bridge.call<TabInfo>("navigate", { url, newTab, back, activate, tabId });
  }),
);

server.registerTool(
  "browser_snapshot",
  {
    description:
      "Liste les éléments interactifs visibles de la page (liens, boutons, champs...), iframes comprises, avec un " +
      "ref (e1, e2...) utilisable par browser_act. Attend que la page ait fini de s'afficher. Chaque snapshot " +
      "invalide les refs précédents.",
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
      ...(snap.pdf ? [pdfHint(snap.pdf)] : []),
      `${snap.elements.length} éléments visibles${snap.truncated ? ` (limite atteinte, ${snap.total} candidats au total)` : ""}`,
      ...(snap.loading ? [`La page affiche encore un indicateur de chargement (${snap.loading}) : refaire un snapshot dans un instant si un élément manque.`] : []),
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
      "ou select (choisir une option d'une liste déroulante par sa valeur ou son libellé). select marche aussi sur " +
      "les listes dessinées par la page (combobox) : elle les ouvre, clique l'option puis les referme ; un libellé " +
      "partiel suffit s'il ne désigne qu'une option, et en cas d'échec l'erreur liste les options. Ne pas utiliser " +
      "type sur une liste déroulante.",
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
  "browser_upload",
  {
    description:
      "Dépose des fichiers locaux (CV, lettre...) dans un champ fichier de la page, désigné par un ref du dernier " +
      "snapshot : le champ lui-même, ou le bouton ou la zone « Importer » (marqués file upload) qui lui est relié. " +
      "Sans champ fichier, simule un glisser-déposer sur l'élément. Ne déposer que des fichiers désignés par l'utilisateur.",
    inputSchema: {
      ref: z.string().describe("ref du champ fichier, ou du bouton ou de la zone de dépôt, issu du dernier snapshot"),
      paths: z.array(z.string()).min(1).describe("Chemins absolus des fichiers (~ accepté)"),
      tabId,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  run(async ({ ref, paths, tabId }) => {
    const files = await Promise.all(
      paths.map(async (raw) => {
        const path = expandHome(raw);
        if (!isAbsolute(path)) throw new Error(`Chemin absolu attendu : ${raw}`);
        const { size, isFile } = await stat(path).then((st) => ({ size: st.size, isFile: st.isFile() }));
        if (!isFile) throw new Error(`Pas un fichier : ${path}`);
        if (size > UPLOAD_MAX_BYTES) throw new Error(`${basename(path)} dépasse ${UPLOAD_MAX_BYTES / 1024 / 1024} Mo`);
        const type = MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
        return { name: basename(path), type, data: (await readFile(path)).toString("base64") };
      }),
    );
    return bridge.call<UploadResult>("upload", { tabId, ref, files }, 60_000);
  }),
);

server.registerTool(
  "browser_read",
  {
    description:
      "Renvoie le texte visible de la page, pour lire ou vérifier son contenu, iframes comprises (le contenu " +
      "d'une fenêtre modale d'abord). Attend que la page ait fini de s'afficher. Lit aussi un PDF affiché dans " +
      "l'onglet.",
    inputSchema: {
      maxChars: z.number().int().min(100).max(50_000).default(8000),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  run(async ({ maxChars, tabId }) => {
    const page = await bridge.call<ReadResult>("read_text", { maxChars, tabId }, FILE_TIMEOUT_MS);
    if (!page.pdf) return page;
    const text = await pdfText(Buffer.from(page.pdf.data, "base64"));
    return {
      ...tabInfo(page),
      pdf: { name: page.pdf.name, bytes: page.pdf.size },
      text: text.slice(0, maxChars),
      ...(text.length > maxChars ? { truncated: `${text.length} caractères au total : augmenter maxChars pour la suite` } : {}),
    };
  }),
);

server.registerTool(
  "browser_save",
  {
    description:
      "Enregistre un fichier sur le disque : le document affiché dans l'onglet (un PDF ouvert dans la visionneuse " +
      "de Firefox, par exemple), la cible d'un lien du dernier snapshot (ref), ou une URL. Les PDF déjà affichés " +
      "sont repris de la copie gardée par l'extension (voir recentPdfs dans browser_status), sans les redemander " +
      "au site. Pour plusieurs documents, les enregistrer un par un par leur lien, sans les ouvrir. " +
      "N'écrase jamais un fichier existant.",
    inputSchema: {
      ref: z.string().optional().describe("Lien à enregistrer sans l'ouvrir, issu du dernier snapshot"),
      url: z.string().url().optional().describe("URL du fichier (un PDF de recentPdfs, par exemple)"),
      path: z
        .string()
        .optional()
        .describe("Dossier ou chemin de fichier absolu (~ accepté). Par défaut : le dossier Téléchargements, avec le nom donné par le site"),
      tabId,
    },
    annotations: { openWorldHint: true },
  },
  run(async ({ ref, url, path, tabId }) => {
    if (ref && url) throw new Error("Fournir ref ou url, pas les deux");
    const file = await bridge.call<TabInfo & FilePayload>("save", { tabId, ref, url }, FILE_TIMEOUT_MS);
    const saved = await saveFile(file, path);
    return { ...tabInfo(file), saved, bytes: file.size, type: file.type, source: file.url };
  }),
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
    if (snap.pdf) throw new Error(pdfHint(snap.pdf));
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
