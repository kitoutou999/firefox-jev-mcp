// Démarrage des trois serveurs MCP comparés, avec le même Firefox (155, binaire du snap) quand c'est possible.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Binaire réel de Firefox : sous Ubuntu, /usr/bin/firefox (snap) est un script que geckodriver refuse.
export const FIREFOX = process.env.FIREFOX_BIN ?? "/snap/firefox/current/usr/lib/firefox/firefox";
const here = new URL(".", import.meta.url).pathname;

export const SERVERS = {
  jev: {
    label: "firefox-jev-mcp (nous)",
    command: `${here}../node_modules/.bin/tsx`,
    args: [`${here}../server/src/index.ts`],
    env: { JEV_BRIDGE_PORT: "8766" },
  },
  mozilla: {
    label: "@mozilla/firefox-devtools-mcp 0.10.4",
    command: "node",
    args: [`${here}node_modules/@mozilla/firefox-devtools-mcp/dist/index.js`, "--headless", "--firefoxPath", FIREFOX, "--viewport", "1366x768"],
  },
  playwright: {
    label: "@playwright/mcp 0.0.82 (Firefox 156 Juggler)",
    command: "node",
    args: [`${here}node_modules/@playwright/mcp/cli.js`, "--browser", "firefox", "--headless", "--isolated", "--viewport-size", "1366x768", "--output-dir", `${here}work/pw-out`],
  },
  chrome: {
    label: "chrome-devtools-mcp 1.10.1 (Google Chrome)",
    command: "node",
    args: [`${here}node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`, "--headless", "--isolated", "--executablePath", "/opt/google/chrome/chrome", "--viewport", "1366x768", "--no-usage-statistics", "--no-page-id-routing", "--no-performance-crux"],
  },
  "playwright-chrome": {
    label: "@playwright/mcp 0.0.82 (Google Chrome)",
    command: "node",
    args: [`${here}node_modules/@playwright/mcp/cli.js`, "--browser", "chrome", "--headless", "--isolated", "--viewport-size", "1366x768", "--output-dir", `${here}work/pw-out`],
  },
};

export async function connect(key) {
  const s = SERVERS[key];
  const client = new Client({ name: "bench", version: "0" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...s.env }, stderr: "ignore" }));
  return client;
}

// Appel chronométré : renvoie { ms, text, chars, isError }.
export async function timed(client, name, args = {}) {
  const t = performance.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const ms = performance.now() - t;
  const text = res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
  return { ms, text, chars: text.length, isError: Boolean(res.isError) };
}
