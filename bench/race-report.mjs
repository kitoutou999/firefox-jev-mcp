// Résume un journal de course : chaque appel d'outil avec son heure, sa durée, et le temps de réflexion avant.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => {
  const i = l.indexOf("\t");
  try { return { t: Number(l.slice(0, i)), e: JSON.parse(l.slice(i + 1)) }; } catch { return null; }
}).filter(Boolean);
const pending = new Map();
let last = lines.find((x) => x.e.type === "system")?.t ?? 0;
let think = 0, tools = 0;
for (const { t, e } of lines) {
  if (e.type === "assistant") {
    for (const c of e.message.content) {
      if (c.type === "tool_use") {
        think += t - last;
        pending.set(c.id, { t, name: c.name.replace(/^mcp__\w+__/, ""), input: JSON.stringify(c.input).slice(0, 110), gap: t - last });
      } else if (c.type === "text") console.log(`${(t / 1000).toFixed(1)}s  [texte] ${c.text.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    last = t;
  } else if (e.type === "user") {
    for (const c of e.message.content ?? []) {
      if (c.type !== "tool_result") continue;
      const p = pending.get(c.tool_use_id);
      if (!p) continue;
      const out = (Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content));
      tools += t - p.t;
      console.log(`${(p.t / 1000).toFixed(1)}s  réflexion ${(p.gap / 1000).toFixed(1)}s -> ${p.name} ${p.input}  [outil ${((t - p.t) / 1000).toFixed(1)}s, ${out.length} car.] ${out.replace(/\s+/g, " ").slice(0, 160)}`);
      last = t;
    }
  } else if (e.type === "result") {
    console.log(`\nTOTAL ${(t / 1000).toFixed(1)}s | Claude ${(e.duration_api_ms / 1000).toFixed(1)}s d'API | outils ${(tools / 1000).toFixed(1)}s | tours ${e.num_turns} | coût ${e.total_cost_usd?.toFixed(3)} $ | ${e.subtype}`);
  }
}
