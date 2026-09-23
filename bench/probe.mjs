// Sonde : appelle une suite d'outils sur un serveur MCP et affiche durée + début de la réponse.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [calls, cmd, ...args] = process.argv.slice(2);
const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: cmd, args, stderr: "inherit", env: { ...process.env } }));
for (const [name, a] of JSON.parse(calls)) {
  const t = performance.now();
  const res = await client.callTool({ name, arguments: a }, undefined, { timeout: 120000 });
  const text = res.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
  console.log(`--- ${name} ${Math.round(performance.now() - t)} ms, ${text.length} chars${res.isError ? " ERROR" : ""}\n${text.slice(0, 1500)}`);
}
await client.close();
