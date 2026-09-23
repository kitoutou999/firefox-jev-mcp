import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [cmd, ...args] = process.argv.slice(2);
const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: cmd, args, stderr: "ignore" }));
const { tools } = await client.listTools();
for (const t of tools) console.log(`${t.name}: ${JSON.stringify(t.inputSchema.properties ?? {}).slice(0, 300)}`);
await client.close();
