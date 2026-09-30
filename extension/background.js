// Pont WebSocket entre le serveur MCP local et les onglets Firefox.
// Le serveur envoie { id, method, params }, on répond { id, result } ou { id, error }.

const WS_URL = "ws://127.0.0.1:8765";
// Firefox espace de plus en plus les tentatives WebSocket qui échouent (jusqu'à 60 s, préférence
// network.websocket.delay-failed-reconnects) : on sonde donc le port en HTTP, ce qui n'est pas freiné,
// et on n'ouvre le WebSocket qu'une fois le serveur à l'écoute.
const PROBE_URL = WS_URL.replace(/^ws:/, "http:");
// Court, pour qu'un serveur MCP qui vient de démarrer soit joint aussitôt : une sonde vers un port fermé
// échoue immédiatement et ne coûte presque rien.
const RECONNECT_MS = 500;

// Refus du serveur quand l'extension du profil habituel pilote déjà Firefox : inutile de réessayer si vite.
const BUSY_RETRY_MS = 3000;

// Profil dédié (module temporaire chargé par web-ext) : connecté en permanence. Profil habituel (extension signée
// installée à demeure) : connecté seulement après un clic sur le bouton, jamais d'office au démarrage.
let profile = "dedicated";
let enabled = false;
let socket = null;
// La connexion n'est utilisable qu'une fois acceptée par le serveur (message welcome).
let accepted = false;
let waiting = "serveur MCP introuvable";
let retryTimer = null;

function setBadge() {
  const connected = socket !== null && accepted;
  const hint = profile === "default" ? " (cliquer pour couper)" : "";
  browser.browserAction.setBadgeText({ text: connected ? "ON" : enabled ? "OFF" : "" });
  browser.browserAction.setBadgeBackgroundColor({ color: connected ? "#2e7d32" : "#757575" });
  browser.browserAction.setTitle({
    title: connected
      ? `Jev Bridge : Claude peut piloter ce Firefox${hint}`
      : enabled
        ? `Jev Bridge : ${waiting}${hint}`
        : "Jev Bridge : désactivé, cliquer pour laisser Claude piloter ce Firefox",
  });
}

async function serverListening() {
  try {
    // Le serveur WebSocket répond 426 à une requête HTTP simple : toute réponse suffit.
    await fetch(PROBE_URL, { cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

function retry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, ms);
}

async function connect() {
  if (!enabled || socket) return;
  if (!(await serverListening())) {
    waiting = "serveur MCP introuvable";
    setBadge();
    retry(RECONNECT_MS);
    return;
  }
  // Un clic a pu désactiver l'extension pendant la sonde.
  if (!enabled || socket) return;
  const ws = new WebSocket(WS_URL);
  socket = ws;
  accepted = false;
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", version: browser.runtime.getManifest().version, profile }));
  ws.onmessage = (event) => handleMessage(ws, event.data);
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    accepted = false;
    waiting = event.code === 4002 ? "une autre fenêtre Firefox est pilotée" : "serveur MCP introuvable";
    setBadge();
    if (enabled) retry(event.code === 4002 ? BUSY_RETRY_MS : RECONNECT_MS);
  };
}

function setEnabled(value) {
  enabled = value;
  watchRequests(enabled);
  if (enabled) {
    connect();
  } else {
    clearTimeout(retryTimer);
    const ws = socket;
    socket = null;
    accepted = false;
    if (ws) ws.close(1000, "désactivée par l'utilisateur");
  }
  setBadge();
}

async function handleMessage(ws, raw) {
  const { id, type, method, params } = JSON.parse(raw);
  if (type === "welcome") {
    accepted = true;
    setBadge();
    return;
  }
  try {
    if (!methods[method]) throw new Error(`Méthode inconnue : ${method}`);
    const result = await methods[method](params || {});
    ws.send(JSON.stringify({ id, result }));
  } catch (err) {
    ws.send(JSON.stringify({ id, error: err.message || String(err) }));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Requêtes en cours par onglet (requestId -> début) : une page n'a fini de s'afficher qu'une fois ses documents et
// ses appels de données reçus. Les scripts et les images n'en font pas partie : les publicités les font traîner.
const pendingRequests = new Map();
const TRACKED_TYPES = ["main_frame", "sub_frame", "xmlhttprequest"];
// Au-delà, une requête ouverte (long polling, flux d'événements) ne retient plus la lecture.
const LONG_REQUEST_MS = 5000;
// Délai accordé à une page pour finir de s'afficher avant une lecture, dont NETWORK_MAX_MS au plus pour le réseau.
const SETTLE_MS = 4000;
const NETWORK_MAX_MS = 2500;
// Puis chaque cadre doit avoir une structure stable depuis QUIET_MS, sans indicateur de chargement visible. Un cadre
// qui change sans cesse (carrousel, fil d'actualité) est lu au bout de CHANGING_MAX_MS.
const QUIET_MS = 250;
const CHANGING_MAX_MS = 1500;

// PDF reçus, par URL, du plus ancien au plus récent. La visionneuse PDF de Firefox est fermée aux extensions, et
// une banque ne sert souvent un relevé qu'une fois : on garde les octets reçus plutôt que de retélécharger.
// Ils restent en mémoire, et sont oubliés quand l'extension est coupée.
const pdfs = new Map();
const PDF_KEEP = 10;
const PDF_MAX_BYTES = 30 * 1024 * 1024;
// Au-delà, un fichier ne passe pas par le WebSocket.
const FILE_MAX_BYTES = 50 * 1024 * 1024;

function onRequestStart(details) {
  if (details.tabId < 0) return;
  let requests = pendingRequests.get(details.tabId);
  if (!requests) pendingRequests.set(details.tabId, (requests = new Map()));
  requests.set(details.requestId, Date.now());
}

function onRequestEnd(details) {
  const requests = pendingRequests.get(details.tabId);
  if (requests && requests.delete(details.requestId) && requests.size === 0) pendingRequests.delete(details.tabId);
}

function headerOf(details, name) {
  const header = details.responseHeaders.find((h) => h.name.toLowerCase() === name);
  return header && header.value;
}

// Copie des PDF affichés ou téléchargés : la réponse passe par un filtre qui la transmet telle quelle à Firefox.
function onPdfHeaders(details) {
  const type = (headerOf(details, "content-type") || "").split(";")[0].trim().toLowerCase();
  const disposition = headerOf(details, "content-disposition");
  const isPdf = type === "application/pdf" || (type === "application/octet-stream" && /\.pdf\b/i.test(disposition || details.url));
  if (!isPdf) return {};
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const chunks = [];
  let size = 0;
  filter.ondata = (event) => {
    filter.write(event.data);
    size += event.data.byteLength;
    if (size <= PDF_MAX_BYTES) chunks.push(event.data);
  };
  filter.onstop = () => {
    filter.close();
    if (size > PDF_MAX_BYTES) return;
    pdfs.delete(details.url);
    pdfs.set(details.url, { url: details.url, disposition, blob: new Blob(chunks, { type: "application/pdf" }) });
    for (const url of pdfs.keys()) {
      if (pdfs.size <= PDF_KEEP) break;
      pdfs.delete(url);
    }
  };
  return {};
}

// Suivi du réseau et copie des PDF, seulement quand Claude peut piloter ce Firefox.
function watchRequests(on) {
  const { onBeforeRequest, onCompleted, onErrorOccurred, onHeadersReceived } = browser.webRequest;
  if (on === onBeforeRequest.hasListener(onRequestStart)) return;
  if (on) {
    const filter = { urls: ["<all_urls>"], types: TRACKED_TYPES };
    onBeforeRequest.addListener(onRequestStart, filter);
    onCompleted.addListener(onRequestEnd, filter);
    onErrorOccurred.addListener(onRequestEnd, filter);
    onHeadersReceived.addListener(onPdfHeaders, { urls: ["<all_urls>"], types: ["main_frame", "sub_frame", "object"] }, [
      "blocking",
      "responseHeaders",
    ]);
  } else {
    onBeforeRequest.removeListener(onRequestStart);
    onCompleted.removeListener(onRequestEnd);
    onErrorOccurred.removeListener(onRequestEnd);
    onHeadersReceived.removeListener(onPdfHeaders);
    pendingRequests.clear();
    pdfs.clear();
  }
}

// Attend la fin des requêtes de l'onglet (NETWORK_MAX_MS au plus), puis renvoie l'échéance jusqu'à laquelle le
// content script peut attendre que la page finisse de s'afficher.
async function settleNetwork(tabId) {
  const start = Date.now();
  for (;;) {
    const requests = pendingRequests.get(tabId);
    const now = Date.now();
    const busy = requests && [...requests.values()].some((t) => now - t < LONG_REQUEST_MS);
    if (!busy || now - start >= NETWORK_MAX_MS) return start + SETTLE_MS;
    await sleep(50);
  }
}

// Nom du fichier d'après l'en-tête Content-Disposition, sinon d'après l'URL.
function fileName(disposition = "", url) {
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  try {
    if (star) return decodeURIComponent(star[1].trim());
    if (plain) return plain[1].trim();
    return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "document";
  } catch {
    return "document";
  }
}

function base64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Fichier à renvoyer au serveur, contenu en base64.
async function filePayload({ url, disposition, blob }) {
  if (blob.size > FILE_MAX_BYTES) throw new Error(`Fichier trop gros pour passer par l'extension (${Math.round(blob.size / 1048576)} Mo)`);
  return { url, name: fileName(disposition, url), type: blob.type, size: blob.size, data: await base64(blob) };
}

// Télécharge url depuis le script de fond avec les cookies de l'utilisateur, en prenant la copie du cache si elle
// existe : un document déjà affiché n'est pas redemandé au site.
async function fetchFile(url) {
  const res = await fetch(url, { credentials: "include", cache: "force-cache" });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return { url: res.url, disposition: res.headers.get("content-disposition") || undefined, blob: await res.blob() };
}

// PDF affiché dans l'onglet : la copie gardée à sa réception, sinon l'URL de l'onglet téléchargée à nouveau.
// null si l'onglet n'affiche pas un PDF.
async function tabPdf(tabId) {
  const { url } = await browser.tabs.get(tabId);
  let file = pdfs.get(url);
  if (!file && /^https?:/.test(url)) {
    file = await fetchFile(url).catch(() => null);
    if (file && !file.blob.type.startsWith("application/pdf")) file = null;
  }
  return file ? filePayload(file) : null;
}

// Profondeur maximale des cadres explorés (une iframe dans une iframe...).
const FRAME_DEPTH = 3;
// Refs du dernier snapshot de chaque onglet : ref -> { frameId, ref propre au cadre }.
const refsByTab = new Map();

// Attend qu'un cadre ait fini de s'afficher, au plus jusqu'à until. Le sondage part d'ici et non du content script :
// dans un onglet en arrière-plan, Firefox espace les timers de la page d'une seconde.
async function settleFrame(tabId, frameId, until) {
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    const timedOut = now >= until;
    const state = await content(tabId, "page_state", { timedOut }, frameId);
    if (timedOut || (!state.busy && (state.idleMs >= QUIET_MS || now - start >= CHANGING_MAX_MS))) return;
    await sleep(100);
  }
}

// Onglet où Claude travaille : celui du dernier outil appelé. Les outils sans tabId le visent, ce qui laisse
// l'utilisateur sur l'onglet qu'il regarde pendant que Claude travaille dans un autre.
let workTab = null;

browser.tabs.onRemoved.addListener((tabId) => {
  pendingRequests.delete(tabId);
  refsByTab.delete(tabId);
  if (workTab === tabId) workTab = null;
});

// Snapshot d'un cadre et de ses sous-cadres, mis à plat : les éléments d'un cadre à sa place dans la page, ceux
// d'une fenêtre modale en tête. Un cadre inaccessible (visionneuse PDF, page protégée) est ignoré.
async function frameSnapshot(tabId, frameId, args, depth) {
  await settleFrame(tabId, frameId, args.settleUntil);
  const snap = await content(tabId, "snapshot", args, frameId);
  const items = snap.elements.map((el) => ({ el, frameId }));
  const frames = depth < FRAME_DEPTH ? snap.frames : [];
  const children = await Promise.all(frames.map((f) => frameSnapshot(tabId, f.frameId, args, depth + 1).catch(() => null)));
  let { total, loading } = snap;
  const onTop = [];
  const others = [];
  const placed = [];
  frames.forEach((frame, i) => {
    const child = children[i];
    if (!child) return;
    total += child.total;
    loading = loading || (child.loading && `${child.loading}, cadre « ${frame.name} »`);
    (frame.onTop ? onTop : others).push(child.text);
    placed.push({ frame, child, at: frame.onTop ? 0 : frame.index, i });
  });
  // Insertion depuis la fin : les positions des cadres suivants restent valables.
  placed.sort((a, b) => b.at - a.at || b.i - a.i);
  for (const { frame, child, at } of placed) {
    const sub = child.items.map((item) => ({
      el: { ...item.el, frame: item.el.frame || frame.name, inViewport: item.el.inViewport && frame.inViewport },
      frameId: item.frameId,
    }));
    items.splice(at, 0, ...sub);
  }
  const text = [...onTop, snap.text, ...others].filter(Boolean).join(" ").slice(0, 2000);
  return { snap, items, total, loading, text };
}

// Texte d'un cadre et de ses sous-cadres : celui d'une fenêtre modale d'abord, puis la page, puis les autres cadres.
async function frameText(tabId, frameId, args, depth) {
  await settleFrame(tabId, frameId, args.settleUntil);
  const page = await content(tabId, "read_text", args, frameId);
  const frames = depth < FRAME_DEPTH ? page.frames : [];
  const children = await Promise.all(frames.map((f) => frameText(tabId, f.frameId, args, depth + 1).catch(() => null)));
  let loading = page.loading;
  const onTop = [];
  const others = [];
  frames.forEach((frame, i) => {
    const child = children[i];
    if (!child) return;
    loading = loading || (child.loading && `${child.loading}, cadre « ${frame.name} »`);
    if (child.text) (frame.onTop ? onTop : others).push(`--- cadre « ${frame.name} » ---\n${child.text}`);
  });
  const main = onTop.length && page.text ? `--- page sous la fenêtre ---\n${page.text}` : page.text;
  return { text: [...onTop, main, ...others].filter(Boolean).join("\n\n"), loading };
}

// Cadre et ref propre au cadre d'un ref du dernier snapshot de l'onglet.
function frameRef(tabId, ref) {
  const target = refsByTab.has(tabId) && refsByTab.get(tabId).get(ref);
  if (!target) throw new Error(`Élément ${ref} introuvable : refaire un snapshot`);
  return target;
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("Aucun onglet actif dans Firefox");
  return tab;
}

// Onglet visé : tabId, sinon l'onglet où Claude travaille, sinon l'onglet actif. Il devient l'onglet de travail.
async function resolveTab(tabId) {
  if (tabId == null && workTab != null) tabId = workTab;
  if (tabId == null) tabId = (await activeTab()).id;
  workTab = tabId;
  return tabId;
}

// Pages vides qu'une navigation peut remplacer sans rien faire perdre à l'utilisateur.
const BLANK_PAGES = new Set(["about:blank", "about:newtab", "about:home", "about:privatebrowsing"]);

// Délai pendant lequel un clic peut encore lancer une navigation (Marionette attend 50 ms, on garde de la marge).
const CLICK_NAV_START_MS = 150;
// Une navigation demandée (URL, retour) démarre presque aussitôt : au-delà, on considère qu'il n'y en a pas.
const REQUEST_NAV_START_MS = 2000;
const LOAD_TIMEOUT_MS = 10000;
// Changement d'URL sans rechargement (SPA, retour depuis le cache) : délai laissé pour afficher le contenu.
const SPA_RENDER_MS = 300;

// Exécute une action sur l'onglet, puis attend la fin du chargement qu'elle a lancé, s'il y en a un.
// L'écoute commence avant l'action : un chargement très rapide ne peut pas passer inaperçu.
async function withLoad(tabId, action, startWindowMs) {
  let loading = false;
  let urlChanged = false;
  let onMove, onDone;
  const moved = new Promise((resolve) => (onMove = resolve));
  const done = new Promise((resolve) => (onDone = resolve));
  const listener = (_id, change) => {
    if (change.status === "loading") loading = true;
    else if (change.status === "complete" && loading) onDone();
    if (change.url) urlChanged = true;
    if (loading || urlChanged) onMove();
  };
  browser.tabs.onUpdated.addListener(listener, { tabId, properties: ["status", "url"] });
  try {
    const result = await action();
    const started = await Promise.race([moved.then(() => true), sleep(startWindowMs).then(() => false)]);
    if (started) {
      if (!loading) await sleep(SPA_RENDER_MS);
      // Le chargement peut suivre le changement d'URL : on l'attend aussi dans ce cas.
      if (loading) await Promise.race([done, sleep(LOAD_TIMEOUT_MS)]);
    }
    return result;
  } finally {
    browser.tabs.onUpdated.removeListener(listener);
  }
}

const infoOf = (tab) => ({ tabId: tab.id, url: tab.url, title: tab.title });

async function tabInfo(tabId) {
  return infoOf(await browser.tabs.get(tabId));
}

// Le content script est injecté à la demande : ça couvre aussi les onglets ouverts avant l'extension.
// Ses handlers ne rejettent jamais ({ ok: false } à la place), donc un échec de sendMessage
// signifie uniquement qu'il n'est pas encore présent dans la page.
async function content(tabId, cmd, args = {}, frameId = 0) {
  const tab = await browser.tabs.get(tabId);
  // Onglet mis en veille par Firefox : sa page n'est plus chargée, on la recharge comme le ferait un clic dessus.
  if (tab.discarded) {
    await withLoad(tabId, () => browser.tabs.reload(tabId), REQUEST_NAV_START_MS);
  }
  const target = { frameId };
  let reply;
  try {
    reply = await browser.tabs.sendMessage(tabId, { cmd, args }, target);
  } catch {
    try {
      await browser.tabs.executeScript(tabId, { file: "/content.js", frameId, matchAboutBlank: true });
    } catch (err) {
      if (frameId === 0 && pdfs.has(tab.url)) {
        throw new Error("Cet onglet affiche un PDF dans la visionneuse de Firefox : browser_read donne son texte, browser_save l'enregistre");
      }
      throw new Error(`Impossible d'accéder à cette page (page protégée de Firefox, ou PDF : essayer browser_read ou browser_save) : ${err.message}`);
    }
    reply = await browser.tabs.sendMessage(tabId, { cmd, args }, target);
  }
  if (!reply) throw new Error("Pas de réponse du content script");
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

const methods = {
  // active : l'onglet affiché dans sa fenêtre ; claude : l'onglet où Claude travaille.
  async list_tabs() {
    const tabs = await browser.tabs.query({});
    return tabs.map((t) => ({ ...infoOf(t), active: t.active, claude: t.id === workTab || undefined, windowId: t.windowId }));
  },

  // Navigue sans changer l'onglet affiché, sauf avec activate. Sans tabId ni onglet de travail, Claude ne prend
  // l'onglet actif que s'il est vide : sinon il ouvre le sien en arrière-plan, pour ne pas remplacer la page que
  // l'utilisateur regarde.
  async navigate({ tabId, url, newTab, back, activate }) {
    let id;
    if (!newTab && tabId == null && workTab == null) {
      const active = await activeTab();
      if (BLANK_PAGES.has(active.url)) id = active.id;
      else newTab = true;
    }
    // Un nouvel onglet part d'about:blank : son id est connu avant la navigation, qu'on peut donc suivre.
    if (newTab) id = (await browser.tabs.create({ url: "about:blank", active: Boolean(activate) })).id;
    id = await resolveTab(id ?? tabId);
    if (url || back) {
      const go = back ? () => browser.tabs.goBack(id) : () => browser.tabs.update(id, { url });
      await withLoad(id, go, REQUEST_NAV_START_MS);
    }
    if (activate) await browser.tabs.update(id, { active: true });
    return tabInfo(id);
  },

  // Les refs des cadres sont renumérotés à la suite (e1, e2...) : le serveur ne voit pas les cadres.
  // Sur un PDF gardé en mémoire, renvoie un snapshot vide qui le signale (pdf : nom du fichier).
  async snapshot({ tabId, limit = 1000 }) {
    const id = await resolveTab(tabId);
    const settleUntil = await settleNetwork(id);
    let found;
    try {
      found = await frameSnapshot(id, 0, { limit, settleUntil }, 0);
    } catch (err) {
      const tab = await browser.tabs.get(id);
      const kept = pdfs.get(tab.url);
      if (!kept) throw err;
      refsByTab.delete(id);
      return { ...infoOf(tab), elements: [], total: 0, truncated: false, text: "", pdf: fileName(kept.disposition, kept.url) };
    }
    const { snap, items, total, loading, text } = found;
    const refs = new Map();
    const elements = items.slice(0, limit).map(({ el, frameId }, i) => {
      const ref = `e${i + 1}`;
      refs.set(ref, { frameId, ref: el.ref });
      return { ...el, ref };
    });
    refsByTab.set(id, refs);
    return { tabId: id, url: snap.url, title: snap.title, elements, total, truncated: items.length >= limit, text, loading: loading || undefined };
  },

  async act({ tabId, ref, action, text, submit }) {
    const id = await resolveTab(tabId);
    const { frameId, ref: local } = frameRef(id, ref);
    const { open, ...result } = await withLoad(
      id,
      async () => {
        const done = await content(id, "act", { ref: local, action, text, submit }, frameId);
        if (done.open) await browser.tabs.update(id, { url: done.open });
        return done;
      },
      CLICK_NAV_START_MS,
    );
    return { ...result, ...(await tabInfo(id)) };
  },

  async upload({ tabId, ref, files }) {
    const id = await resolveTab(tabId);
    const { frameId, ref: local } = frameRef(id, ref);
    const result = await withLoad(id, () => content(id, "upload", { ref: local, files }, frameId), CLICK_NAV_START_MS);
    return { ...result, ...(await tabInfo(id)) };
  },

  // Sur un PDF (visionneuse de Firefox, fermée aux extensions), renvoie le fichier : le serveur en extrait le texte.
  async read_text({ tabId, maxChars }) {
    const id = await resolveTab(tabId);
    const settleUntil = await settleNetwork(id);
    let page;
    try {
      page = await frameText(id, 0, { maxChars, settleUntil }, 0);
    } catch (err) {
      const pdf = await tabPdf(id);
      if (!pdf) throw err;
      return { ...(await tabInfo(id)), pdf };
    }
    return { ...(await tabInfo(id)), text: page.text.slice(0, maxChars), loading: page.loading || undefined };
  },

  // Fichier à enregistrer : la cible du lien ref, l'URL donnée, ou à défaut le document affiché dans l'onglet.
  // Un PDF déjà reçu est repris de la copie gardée, sans le redemander au site.
  async save({ tabId, ref, url }) {
    const id = await resolveTab(tabId);
    let file;
    if (ref) {
      const { frameId, ref: local } = frameRef(id, ref);
      const link = await content(id, "link_url", { ref: local }, frameId);
      if (pdfs.has(link)) {
        file = await filePayload(pdfs.get(link));
      } else {
        // Depuis la page d'abord, avec ses cookies ; depuis le script de fond si la page ne peut pas le lire (CORS).
        file = await content(id, "fetch_file", { url: link }, frameId).then(
          ({ disposition, ...rest }) => ({ ...rest, name: fileName(disposition, rest.url) }),
          () => fetchFile(link).then(filePayload),
        );
      }
    } else {
      const target = url || (await browser.tabs.get(id)).url;
      file = await filePayload(pdfs.get(target) || (await fetchFile(target)));
    }
    return { ...(await tabInfo(id)), ...file };
  },

  // PDF gardés en mémoire, du plus récent au plus ancien : un relevé remplacé dans l'onglet par un autre reste
  // enregistrable avec son URL.
  async recent_pdfs() {
    return [...pdfs.values()].reverse().map(({ url, disposition, blob }) => ({ url, name: fileName(disposition, url), size: blob.size }));
  },

  async scroll({ tabId, direction }) {
    const id = await resolveTab(tabId);
    const position = await content(id, "scroll", { direction });
    await sleep(300);
    return { ...(await tabInfo(id)), ...position };
  },
};

browser.browserAction.onClicked.addListener(() => setEnabled(!enabled));

// Attentes des content scripts d'onglets en arrière-plan (voir sleep dans content.js).
browser.runtime.onMessage.addListener((msg) => (msg && msg.sleep ? sleep(Math.min(msg.sleep, 5000)) : undefined));

browser.management.getSelf().then((self) => {
  profile = self.installType === "development" ? "dedicated" : "default";
  setEnabled(profile === "dedicated");
});
