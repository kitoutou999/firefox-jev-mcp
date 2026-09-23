// stdout est réservé au protocole MCP : tout le reste passe par stderr.
export function log(...args: unknown[]): void {
  console.error("[firefox-jev]", ...args);
}
