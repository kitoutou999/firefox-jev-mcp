// Banc de mesure des primitives : navigation, snapshot, clic ou saisie jusqu'à l'arrivée, lecture du texte.
// Mêmes sites et mêmes actions pour chaque serveur MCP ; résultats bruts dans work/results-<serveur>.json.
// Usage : node bench.mjs <jev|mozilla|playwright> [répétitions]
import { writeFileSync } from "node:fs";
import { connect, timed } from "./servers.mjs";

const key = process.argv[2];
const RUNS = Number(process.argv[3] ?? 5);

const SITES = [
  { id: "books", url: "https://books.toscrape.com/", kind: "link", name: "Travel", expect: /travel_2/ },
  { id: "hn", url: "https://news.ycombinator.com/", kind: "link", name: "new", expect: /\/newest/ },
  { id: "wiki-article", url: "https://en.wikipedia.org/wiki/Firefox", kind: "link", name: "Gecko", expect: /\/wiki\/Gecko/ },
  { id: "wiki-search", url: "https://en.wikipedia.org/wiki/Main_Page", kind: "search", name: "Search Wikipedia", text: "Gecko (software)", expect: /Gecko/ },
];

// Ce qui change d'un serveur à l'autre : noms d'outils, format des snapshots, façon de lire l'URL courante.
const ADAPTERS = {
  jev: {
    navigate: (url) => ["browser_navigate", { url }],
    snapshot: ["browser_snapshot", {}],
    fullSnapshot: ["browser_snapshot", { limit: 1000 }],
    role: { link: "link", search: "searchbox" },
    ref: (line) => line.match(/^(e\d+) /)?.[1],
    click: (ref) => ["browser_act", { ref, action: "click" }],
    type: (ref, text) => ["browser_act", { ref, action: "type", text, submit: true }],
    read: ["browser_read", {}],
    location: ["browser_status", {}],
    url: (text) => JSON.parse(text).tabs?.find((t) => t.active)?.url ?? text,
  },
  mozilla: {
    navigate: (url) => ["navigate_page", { url }],
    snapshot: ["take_snapshot", {}],
    fullSnapshot: ["take_snapshot", { maxLines: 100_000 }],
    role: { link: "a", search: "input" },
    // Le nom affiché vient de l'attribut title quand il existe ; le texte visible est à part (text="...").
    matches: (line, role, name) => line.includes(`${role} "${name}"`) || (line.includes(` ${role} `) && line.includes(`text="${name}"`)),
    ref: (line) => line.match(/uid=(\S+)/)?.[1],
    click: (uid) => ["click_by_uid", { uid }],
    type: (uid, text) => ["type_text", { uid, text, submitKey: "Enter" }],
    read: ["get_page_text", {}],
    location: ["list_pages", {}],
    url: (text) => text,
  },
  playwright: {
    navigate: (url) => ["browser_navigate", { url }],
    snapshot: ["browser_snapshot", {}],
    fullSnapshot: null, // le snapshot par défaut couvre déjà toute la page
    role: { link: "link", search: "searchbox" },
    ref: (line) => line.match(/\[ref=(\w+)\]/)?.[1],
    click: (ref, name) => ["browser_click", { element: name, target: ref }],
    type: (ref, text, name) => ["browser_type", { element: name, target: ref, text, submit: true }],
    read: null, // pas d'outil texte : le snapshot tient ce rôle
    location: ["browser_tabs", { action: "list" }],
    url: (text) => text,
  },
};

ADAPTERS.chrome = {
  navigate: (url) => ["navigate_page", { type: "url", url }],
  snapshot: ["take_snapshot", {}],
  fullSnapshot: null,
  role: { link: "link", search: "searchbox" },
  ref: (line) => line.match(/uid=(\S+)/)?.[1],
  click: (uid) => ["click", { uid }],
  // Pas de saisie + Entrée en un seul appel : fill puis press_key.
  type: (uid, value) => [["fill", { uid, value }], ["press_key", { key: "Enter" }]],
  read: null,
  location: ["list_pages", {}],
  url: (text) => text,
};
ADAPTERS["playwright-chrome"] = ADAPTERS.playwright;

// Même serveur Mozilla, mais navigation rendue à l'événement load (comme Playwright), et non à DOMContentLoaded.
ADAPTERS["mozilla-complete"] = { ...ADAPTERS.mozilla, navigate: (url) => ["navigate_page", { url, wait: "complete" }] };

const A = ADAPTERS[key];
if (!A) throw new Error(`serveur inconnu : ${key}`);

function findRef(snapshot, site) {
  const role = A.role[site.kind];
  const needle = `${role} "${site.name}"`;
  const line = snapshot.split("\n").find((l) => (A.matches ? A.matches(l, role, site.name) : l.includes(needle)));
  const ref = line && A.ref(line.trim().replace(/^- /, ""));
  if (!ref) throw new Error(`${needle} introuvable dans le snapshot (${snapshot.length} caractères)`);
  return ref;
}

// Un appel d'outil, ou une suite d'appels comptée comme une seule action (temps et tailles cumulés).
async function call(client, spec) {
  if (typeof spec[0] === "string") return timed(client, spec[0], spec[1]);
  const total = { ms: 0, text: "", chars: 0, isError: false };
  for (const [name, args] of spec) {
    const r = await timed(client, name, args);
    total.ms += r.ms;
    total.text += r.text;
    total.chars += r.chars;
    if (r.isError) return { ...total, isError: true };
  }
  return total;
}

async function waitArrival(client, site, first) {
  const t = performance.now();
  if (site.expect.test(first)) return 0;
  for (let i = 0; i < 200; i++) {
    const loc = await call(client, A.location);
    if (site.expect.test(A.url(loc.text))) return performance.now() - t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`arrivée non détectée pour ${site.id}`);
}

const t0 = performance.now();
const client = await connect(key.replace("-complete", ""));
const startup = { connectMs: performance.now() - t0 };
if (key === "jev") {
  // L'extension retente sa connexion toutes les 3 s : on attend qu'elle ait rejoint ce serveur.
  const t = performance.now();
  while (!JSON.parse((await call(client, ["browser_status", {}])).text).extensionConnected) {
    if (performance.now() - t > 15_000) throw new Error("extension non connectée");
    await new Promise((r) => setTimeout(r, 50));
  }
  startup.extensionWaitMs = performance.now() - t;
}
const first = await call(client, A.navigate("https://example.com/"));
startup.firstNavigateMs = first.ms;
console.error(`[${key}] prêt : ${JSON.stringify(startup, (_, v) => (typeof v === "number" ? Math.round(v) : v))}`);

const results = [];
for (let run = 1; run <= RUNS; run++) {
  for (const site of SITES) {
    const r = { run, site: site.id };
    try {
      const nav = await call(client, A.navigate(site.url));
      if (nav.isError) throw new Error(nav.text.slice(0, 200));
      r.navigate = { ms: nav.ms, chars: nav.chars };
      const snap = await call(client, A.snapshot);
      r.snapshot = { ms: snap.ms, chars: snap.chars };
      let full = snap;
      if (A.fullSnapshot) {
        full = await call(client, A.fullSnapshot);
        r.fullSnapshot = { ms: full.ms, chars: full.chars };
      }
      const ref = findRef(full.text, site);
      const act = await call(client, site.kind === "link" ? A.click(ref, site.name) : A.type(ref, site.text, site.name));
      if (act.isError) throw new Error(act.text.slice(0, 200));
      const extra = await waitArrival(client, site, act.text);
      r.action = { ms: act.ms, chars: act.chars, arrivalMs: act.ms + extra };
      // Observation de la page d'arrivée, nécessaire à l'étape suivante d'un agent.
      const after = await call(client, A.snapshot);
      r.snapshotAfter = { ms: after.ms, chars: after.chars };
      if (A.read) {
        const read = await call(client, A.read);
        r.read = { ms: read.ms, chars: read.chars };
      }
    } catch (err) {
      r.error = err.message;
    }
    console.error(`[${key}] run ${run} ${site.id} ${r.error ? `ERREUR ${r.error}` : `nav ${Math.round(r.navigate.ms)} snap ${Math.round(r.snapshot.ms)} act→arrivée ${Math.round(r.action.arrivalMs)} ms`}`);
    results.push(r);
  }
}
await client.close();
writeFileSync(new URL(`data/results-${key}.json`, import.meta.url), JSON.stringify({ key, startup, results }, null, 1));
