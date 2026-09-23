// Génère les graphiques PNG du benchmark : fond crème, panneau liseré, firefox-jev-mcp en orange, les autres
// serveurs MCP en gris. Données lues dans bench/data (voir bench/README.md pour les reproduire).
// Usage : node bench/charts/make-charts.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const here = new URL(".", import.meta.url).pathname;
const data = `${here}../data/`;

const C = {
  surface: "#FAF9F5",
  ink: "#141413",
  muted: "#5E5D59",
  faint: "#87867F",
  grid: "#E6E4DD",
  border: "#141413",
  ours: "#EB6834",
  oursLight: "#F5B89C",
  them: "#73726C",
  themLight: "#C8C6BF",
  badge: "#FBE1D5",
};

// Tarifs publics. Jev 1.13 (jev-latest, défaut du SDK) : 0,042 $ par million de tokens d'entrée, sortie gratuite
// (https://docs.typesafe.ai/models.md). Claude : coût calculé par claude -p au tarif public de l'API.
const JEV_USD_PER_MTOK = 0.042;
// Taux de référence BCE du 23/09/2026 (api.frankfurter.dev).
const EUR_PER_USD = 0.87635;

const fr = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fr0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const fr2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const fr3 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3, minimumFractionDigits: 3 });

// ---------- Lecture des données ----------

// Une course de data/races.json, réduite aux chiffres des graphiques.
function summary(run) {
  const t = run.claude_tokens;
  const jevUsd = (run.jev.input_tokens * JEV_USD_PER_MTOK) / 1e6;
  return {
    total: run.total_s,
    claude: run.claude_api_s,
    turns: run.claude_turns,
    claudeTokens: t.input + t.cache_creation + t.cache_read + t.output,
    jevTokens: run.jev.input_tokens,
    jevCalls: run.jev.calls,
    // Coût complet de la course en euros : Claude, plus Jev pour firefox-jev-mcp.
    eur: (run.claude_cost_usd + jevUsd) * EUR_PER_USD,
    claudeEur: run.claude_cost_usd * EUR_PER_USD,
    jevEur: jevUsd * EUR_PER_USD,
  };
}

// Toutes les courses (versions successives de firefox-jev-mcp) ; la dernière est celle des graphiques.
const RACES = JSON.parse(readFileSync(`${data}races.json`, "utf8")).map((r) => ({ jev: summary(r.jev), moz: summary(r.moz) }));

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function clickMedian(key) {
  const { results } = JSON.parse(readFileSync(`${data}results-${key}.json`, "utf8"));
  const ok = results.filter((r) => !r.error && r.run > 1);
  return { ms: median(ok.map((r) => r.action.arrivalMs)), failures: results.filter((r) => r.error).length, n: ok.length };
}

// ---------- Rendu SVG ----------

// Rectangle horizontal arrondi (4 px) du côté de la valeur seulement, carré côté base.
function bar(x, y, w, h, color, roundEnd) {
  if (w <= 0) return "";
  const r = roundEnd ? Math.min(4, w, h / 2) : 0;
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z" fill="${color}"/>`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * Barres horizontales, empilables. rows : { label, sub, segments: [{ value, color, text, textColor }], end }.
 * Un row { group } insère un intertitre de groupe.
 */
function hbarChart({ rows, max, ticks, tickFormat, width, labelW = 300, rowH = 64, barH = 24, endW = 110 }) {
  const plotX = labelW;
  const plotW = width - labelW - endW;
  const sx = (v) => (v / max) * plotW;
  let y = 8;
  const parts = [];
  const rowYs = [];
  for (const row of rows) {
    if (row.group) {
      parts.push(`<text x="0" y="${y + 22}" class="group">${esc(row.group)}</text>`);
      y += 34;
      continue;
    }
    const by = y + (rowH - barH) / 2;
    rowYs.push(y);
    parts.push(`<text x="0" y="${by + barH / 2 - (row.sub ? 4 : -5)}" class="label">${esc(row.label)}</text>`);
    if (row.sub) parts.push(`<text x="0" y="${by + barH / 2 + 15}" class="sub">${esc(row.sub)}</text>`);
    let x = plotX;
    row.segments.forEach((seg, i) => {
      const gap = i > 0 ? 2 : 0;
      const w = sx(seg.value) - gap;
      parts.push(bar(x + gap, by, w, barH, seg.color, i === row.segments.length - 1));
      if (seg.text) {
        parts.push(`<text x="${x + gap + 10}" y="${by + barH / 2 + 4.5}" class="inbar" fill="${seg.textColor}">${esc(seg.text)}</text>`);
      }
      x += gap + w;
    });
    parts.push(`<text x="${x + 10}" y="${by + barH / 2 + 5}" class="end">${esc(row.end)}</text>`);
    if (row.badge) {
      // Largeurs estimées (Inter) : texte de fin à 15 px semi-gras, badge à 13 px.
      const bx = x + 10 + row.end.length * 8.8 + 10;
      const bw = row.badge.length * 7.6 + 18;
      parts.push(`<rect x="${bx}" y="${by - 1}" width="${bw}" height="${barH + 2}" rx="${(barH + 2) / 2}" fill="${C.badge}"/>`);
      parts.push(`<text x="${bx + bw / 2}" y="${by + barH / 2 + 4.5}" class="badge" text-anchor="middle">${esc(row.badge)}</text>`);
    }
    y += rowH;
  }
  const plotBottom = y + 4;
  const grid = ticks
    .map((t) => {
      const gx = plotX + sx(t);
      return `<line x1="${gx}" x2="${gx}" y1="0" y2="${plotBottom}" stroke="${t === 0 ? C.faint : C.grid}" stroke-width="1"/>
        <text x="${gx}" y="${plotBottom + 20}" class="tick" text-anchor="middle">${esc(tickFormat(t))}</text>`;
    })
    .join("");
  const height = plotBottom + 30;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${grid}${parts.join("")}</svg>`;
}

function page({ title, subtitle, legend, chart, caption }) {
  const legendHtml = legend
    .map((l) => `<span class="key"><i style="background:${l.color}"></i>${esc(l.label)}</span>`)
    .join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 675px; background: ${C.surface}; font-family: Inter, system-ui, sans-serif; color: ${C.ink};
         padding: 40px 48px 28px; display: flex; flex-direction: column; gap: 16px; }
  .panel { border: 1px solid ${C.border}; padding: 26px 30px 18px; flex: 1; display: flex; flex-direction: column; gap: 14px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .subtitle { font-size: 14px; color: ${C.muted}; margin-top: 6px; line-height: 1.4; }
  .legend { display: flex; gap: 18px; flex-shrink: 0; padding-top: 4px; }
  .key { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 500; white-space: nowrap; }
  .key i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid ${C.ink}; display: inline-block; }
  .chart { flex: 1; display: flex; align-items: center; }
  .caption { font-size: 12.5px; color: ${C.muted}; line-height: 1.5; text-align: center; padding: 0 30px; }
  svg text { font-family: Inter, system-ui, sans-serif; }
  .label { font-size: 15px; font-weight: 600; fill: ${C.ink}; }
  .sub { font-size: 12.5px; fill: ${C.muted}; }
  .group { font-size: 12px; font-weight: 600; fill: ${C.faint}; text-transform: uppercase; letter-spacing: 0.06em; }
  .inbar { font-size: 12.5px; font-weight: 500; }
  .end { font-size: 15px; font-weight: 600; fill: ${C.ink}; }
  .tick { font-size: 12px; fill: ${C.faint}; }
  .badge { font-size: 13px; font-weight: 700; fill: ${C.ink}; }
</style></head><body>
<div class="panel">
  <div class="head"><div><h1>${esc(title)}</h1><div class="subtitle">${esc(subtitle)}</div></div><div class="legend">${legendHtml}</div></div>
  <div class="chart">${chart}</div>
</div>
<div class="caption">${esc(caption)}</div>
</body></html>`;
}

// ---------- Les graphiques ----------

const { jev, moz } = RACES.at(-1);
const all = RACES.map((r) => [r.jev.total, r.moz.total]);
const fasterPct = Math.round((1 - jev.total / moz.total) * 100);
const legendTwo = [
  { label: "firefox-jev-mcp", color: C.ours },
  { label: "Mozilla firefox-devtools-mcp", color: C.them },
];
const cheaperPct = Math.round((1 - jev.eur / moz.eur) * 100);
const WIDTH = 1040;

const charts = {};

charts["1-course-temps"] = page({
  title: `Wikipédia, de « Titanic » à « Tour Eiffel » : ${fasterPct} % plus rapide`,
  subtitle: "Temps total de la tâche en secondes, plus court = mieux. Partie foncée : réflexion de Claude. Partie claire : navigateur, outils et démarrage.",
  legend: legendTwo,
  chart: hbarChart({
    width: WIDTH,
    max: 25,
    ticks: [0, 5, 10, 15, 20, 25],
    tickFormat: (t) => `${t} s`,
    rowH: 120,
    rows: [
      {
        label: "firefox-jev-mcp",
        sub: `${jev.turns} tours de Claude, Jev décide des clics`,
        segments: [
          { value: jev.claude, color: C.ours, text: `Claude ${fr.format(jev.claude)} s`, textColor: C.ink },
          { value: jev.total - jev.claude, color: C.oursLight, text: `${fr.format(jev.total - jev.claude)} s`, textColor: C.ink },
        ],
        end: `${fr.format(jev.total)} s`,
        badge: `−${fasterPct} %`,
      },
      {
        label: "Mozilla firefox-devtools-mcp",
        sub: `${moz.turns} tours de Claude, un par action`,
        segments: [
          { value: moz.claude, color: C.them, text: `Claude ${fr.format(moz.claude)} s`, textColor: "#FFFFFF" },
          { value: moz.total - moz.claude, color: C.themLight, text: `${fr.format(moz.total - moz.claude)} s`, textColor: C.ink },
        ],
        end: `${fr.format(moz.total)} s`,
      },
    ],
  }),
  caption:
    `Même prompt et même modèle (Claude Opus 5.5 via claude -p), deux courses lancées en parallèle sur Firefox 155 sans interface. ` +
    `Interdits : barre de recherche, saisie, URL tapée, retour arrière. Sur ${RACES.length} courses, firefox-jev-mcp est arrivé premier à chaque fois : ` +
    `${all.map(([a]) => fr.format(a)).join(" / ")} s contre ${all.map(([, b]) => fr.format(b)).join(" / ")} s.`,
});

const allCost = RACES.map((r) => [r.jev.eur, r.moz.eur]);
const per1000 = (eur) => eur * 1000;

charts["2-course-cout"] = page({
  title: `Wikipédia, de « Titanic » à « Tour Eiffel » : ${cheaperPct} % moins cher`,
  subtitle: `Coût de 1 000 courses en euros, Jev compris, plus court = mieux. Soit ${fr3.format(jev.eur)} € contre ${fr3.format(moz.eur)} € par course.`,
  legend: legendTwo,
  chart: hbarChart({
    width: WIDTH,
    max: 60,
    ticks: [0, 10, 20, 30, 40, 50, 60],
    tickFormat: (t) => `${t} €`,
    rowH: 120,
    rows: [
      {
        label: "firefox-jev-mcp",
        sub: "Claude planifie, Jev choisit les clics",
        segments: [
          { value: per1000(jev.claudeEur), color: C.ours, text: `Claude ${fr2.format(per1000(jev.claudeEur))} €`, textColor: C.ink },
          { value: per1000(jev.jevEur), color: C.oursLight, text: `Jev ${fr2.format(per1000(jev.jevEur))} €`, textColor: C.ink },
        ],
        end: `${fr2.format(per1000(jev.eur))} €`,
        badge: `−${cheaperPct} %`,
      },
      {
        label: "Mozilla firefox-devtools-mcp",
        sub: "Claude décide de chaque action",
        segments: [{ value: per1000(moz.claudeEur), color: C.them, text: `Claude ${fr2.format(per1000(moz.claudeEur))} €`, textColor: "#FFFFFF" }],
        end: `${fr2.format(per1000(moz.eur))} €`,
      },
    ],
  }),
  caption:
    `Tarifs publics des API : Claude Opus 5.5 (coût calculé par claude -p) et Jev 1.13 de TypeSafe, 0,042 $ par million de tokens ` +
    `d'entrée, sortie gratuite (${fr0.format(jev.jevTokens)} tokens en ${jev.jevCalls} appels). Taux BCE du 23/09/2026 : 1 $ = ${fr3.format(EUR_PER_USD)} €. ` +
    `Sur ${RACES.length} courses, par course : ${allCost.map(([a]) => fr3.format(a)).join(" / ")} € contre ${allCost.map(([, b]) => fr3.format(b)).join(" / ")} €.`,
});

const clicks = [
  { key: "jev", label: "firefox-jev-mcp", sub: "Firefox, extension", color: C.ours },
  { key: "mozilla", label: "Mozilla firefox-devtools-mcp", sub: "Firefox, WebDriver BiDi", color: C.them },
  { key: "chrome", label: "Google chrome-devtools-mcp", sub: "Chrome, CDP", color: C.them },
  { key: "playwright-chrome", label: "Microsoft Playwright MCP", sub: "Chrome", color: C.them },
  { key: "playwright", label: "Microsoft Playwright MCP", sub: "Firefox (Juggler)", color: C.them },
].map((c) => ({ ...c, ...clickMedian(c.key) }));

charts["3-latence-clic"] = page({
  title: "Temps d'un clic, jusqu'à la page suivante chargée",
  subtitle: "Médiane en millisecondes, plus court = mieux. 4 pages réelles, 4 passages chacune après un passage de chauffe.",
  legend: [
    { label: "firefox-jev-mcp", color: C.ours },
    { label: "autres serveurs MCP", color: C.them },
  ],
  chart: hbarChart({
    width: WIDTH,
    max: 1400,
    ticks: [0, 200, 400, 600, 800, 1000, 1200, 1400],
    tickFormat: (t) => `${fr0.format(t)} ms`,
    rowH: 62,
    rows: clicks.map((c) => ({
      label: c.label,
      sub: c.sub,
      segments: [{ value: c.ms, color: c.color }],
      end: `${fr0.format(c.ms)} ms`,
      badge: c.key === "jev" ? "le plus rapide" : undefined,
    })),
  }),
  caption:
    "Pages : books.toscrape.com, Hacker News, article Wikipédia « Firefox » (plus de 1 000 liens), recherche Wikipédia. " +
    "Clic lancé par le serveur MCP, sans LLM. Mozilla : médiane sur 3 pages, son snapshot ne montre pas les liens de navigation de Hacker News.",
});

// ---------- Capture PNG ----------

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 2 });
const tab = await context.newPage();
for (const [name, html] of Object.entries(charts)) {
  writeFileSync(`${here}${name}.html`, html);
  await tab.setContent(html, { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: `${here}${name}.png` });
  console.log(`${name}.png`);
}
await browser.close();
console.log(JSON.stringify({ jev, moz, all, clicks: clicks.map(({ key, ms, n, failures }) => ({ key, ms: Math.round(ms), n, failures })) }));
