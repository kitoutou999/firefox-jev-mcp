// Remet l'onglet du Firefox de banc (port 8766) sur la page Titanic avant une course.
import { connect, timed } from "./servers.mjs";
const client = await connect("jev");
for (let i = 0; i < 100; i++) {
  if (JSON.parse((await timed(client, "browser_status")).text).extensionConnected) break;
  await new Promise((r) => setTimeout(r, 100));
}
const r = await timed(client, "browser_navigate", { url: "https://en.wikipedia.org/wiki/Titanic" });
console.log(`${Math.round(r.ms)} ms ${r.text}`);
await client.close();
