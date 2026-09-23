// Résume les journaux de course (work/race/*.log, sortie stream-json de claude -p horodatée par timestamp.mjs)
// dans data/races.json : temps, tours, tokens, coût et déroulé des appels d'outils, sans les détails de
// l'environnement local (chemins, session, configuration de Claude Code).
// Les deux courses lancées ensemble partagent l'heure de leur nom de fichier (jev-HHMMSS.log / moz-HHMMSS.log).
// Usage : node bench/extract-races.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const dir = new URL("./work/race/", import.meta.url);
const MCP = { jev: "firefox-jev-mcp", moz: "@mozilla/firefox-devtools-mcp" };

function summarize(file) {
  const events = readFileSync(new URL(file, dir), "utf8").trim().split("\n").map((line) => {
    const i = line.indexOf("\t");
    return { t: Number(line.slice(0, i)), e: JSON.parse(line.slice(i + 1)) };
  });
  const init = events.find(({ e }) => e.type === "system").e;
  const { t: end, e: result } = events.at(-1);
  const pending = new Map();
  const steps = [];
  let jevCalls = 0;
  let jevTokens = 0;
  for (const { t, e } of events) {
    for (const c of e.message?.content ?? []) {
      if (c.type === "tool_use") {
        pending.set(c.id, steps.push({ at_s: t / 1000, tool: c.name.replace(/^mcp__\w+__/, ""), input: c.input }) - 1);
      } else if (c.type === "tool_result" && pending.has(c.tool_use_id)) {
        const step = steps[pending.get(c.tool_use_id)];
        step.duration_s = t / 1000 - step.at_s;
        if (c.is_error) step.error = true;
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content);
        try {
          const out = JSON.parse(text);
          if (out.status) step.status = out.status;
          if (out.jev) {
            jevCalls += out.jev.calls;
            jevTokens += out.jev.inputTokens;
          }
        } catch {}
      }
    }
  }
  const u = result.usage;
  return {
    mcp: MCP[file.slice(0, 3)],
    model: init.model,
    success: result.subtype === "success" && !result.is_error,
    total_s: end / 1000,
    claude_api_s: result.duration_api_ms / 1000,
    claude_turns: result.num_turns,
    claude_cost_usd: result.total_cost_usd,
    claude_tokens: {
      input: u.input_tokens,
      cache_creation: u.cache_creation_input_tokens,
      cache_read: u.cache_read_input_tokens,
      output: u.output_tokens,
    },
    jev: { calls: jevCalls, input_tokens: jevTokens },
    steps,
    answer: result.result,
  };
}

const files = readdirSync(dir).filter((f) => /^(jev|moz)-\d{6}\.log$/.test(f));
const starts = [...new Set(files.map((f) => f.slice(4, 10)))].sort();
const races = starts
  .filter((s) => files.includes(`jev-${s}.log`) && files.includes(`moz-${s}.log`))
  .map((s) => ({
    date: statSync(new URL(`jev-${s}.log`, dir)).mtime.toISOString().slice(0, 10),
    started: `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`,
    jev: summarize(`jev-${s}.log`),
    moz: summarize(`moz-${s}.log`),
  }));
writeFileSync(new URL("./data/races.json", import.meta.url), JSON.stringify(races, null, 1) + "\n");
console.log(`${races.length} courses -> data/races.json`);
