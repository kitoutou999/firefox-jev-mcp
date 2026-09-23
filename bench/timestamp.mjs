// Préfixe chaque ligne de stdin par le temps écoulé (ms) depuis le lancement.
import { createInterface } from "node:readline";
const t0 = Number(process.argv[2] ?? Date.now());
for await (const line of createInterface({ input: process.stdin })) console.log(`${Date.now() - t0}\t${line}`);
