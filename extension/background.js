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

let socket = null;

function setBadge(connected) {
  browser.browserAction.setBadgeText({ text: connected ? "ON" : "OFF" });
  browser.browserAction.setBadgeBackgroundColor({ color: connected ? "#2e7d32" : "#757575" });
  browser.browserAction.setTitle({
    title: connected ? "Jev Bridge : connecté au serveur MCP" : "Jev Bridge : serveur MCP introuvable",
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

async function connect() {
  if (!(await serverListening())) {
    setTimeout(connect, RECONNECT_MS);
    return;
  }
  socket = new WebSocket(WS_URL);
  socket.onopen = () => {
    setBadge(true);
    socket.send(JSON.stringify({ type: "hello", version: browser.runtime.getManifest().version }));
  };
  socket.onmessage = (event) => handleMessage(event.data);
  socket.onclose = () => {
    setBadge(false);
    setTimeout(connect, RECONNECT_MS);
  };
}

async function handleMessage(raw) {
  const { id, method, params } = JSON.parse(raw);
  try {
    if (!methods[method]) throw new Error(`Méthode inconnue : ${method}`);
    const result = await methods[method](params || {});
    socket.send(JSON.stringify({ id, result }));
  } catch (err) {
    socket.send(JSON.stringify({ id, error: err.message || String(err) }));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveTab(tabId) {
  if (tabId != null) return tabId;
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("Aucun onglet actif dans Firefox");
  return tab.id;
}

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
async function content(tabId, cmd, args = {}) {
  let reply;
  try {
    reply = await browser.tabs.sendMessage(tabId, { cmd, args });
  } catch {
    try {
      await browser.tabs.executeScript(tabId, { file: "/content.js" });
    } catch (err) {
      throw new Error(`Impossible d'accéder à cette page (page protégée de Firefox ?) : ${err.message}`);
    }
    reply = await browser.tabs.sendMessage(tabId, { cmd, args });
  }
  if (!reply) throw new Error("Pas de réponse du content script");
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

const methods = {
  async list_tabs() {
    const tabs = await browser.tabs.query({});
    return tabs.map((t) => ({ ...infoOf(t), active: t.active, windowId: t.windowId }));
  },

  async navigate({ tabId, url, newTab, back }) {
    // Un nouvel onglet part d'about:blank : son id est connu avant la navigation, qu'on peut donc suivre.
    const id = newTab ? (await browser.tabs.create({ url: "about:blank", active: true })).id : await resolveTab(tabId);
    const go = back ? () => browser.tabs.goBack(id) : () => browser.tabs.update(id, { url, active: true });
    await withLoad(id, go, REQUEST_NAV_START_MS);
    return tabInfo(id);
  },

  async snapshot({ tabId, limit }) {
    const id = await resolveTab(tabId);
    return { tabId: id, ...(await content(id, "snapshot", { limit })) };
  },

  async act({ tabId, ref, action, text, submit }) {
    const id = await resolveTab(tabId);
    const result = await withLoad(id, () => content(id, "act", { ref, action, text, submit }), CLICK_NAV_START_MS);
    return { ...result, ...(await tabInfo(id)) };
  },

  async read_text({ tabId, maxChars }) {
    const id = await resolveTab(tabId);
    return { ...(await tabInfo(id)), text: await content(id, "read_text", { maxChars }) };
  },

  async scroll({ tabId, direction }) {
    const id = await resolveTab(tabId);
    const position = await content(id, "scroll", { direction });
    await sleep(300);
    return { ...(await tabInfo(id)), ...position };
  },
};

setBadge(false);
connect();
