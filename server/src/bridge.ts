import { WebSocketServer, WebSocket } from "ws";
import { log } from "./log.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HOST = "127.0.0.1";
// Au démarrage du serveur, l'extension n'est pas encore reconnectée (elle réessaie toutes les 500 ms) :
// un appel l'attend jusqu'à ce délai plutôt que d'échouer aussitôt.
const CONNECT_WAIT_MS = 4000;

// Serveur WebSocket local auquel l'extension Firefox se connecte.
// Une seule extension à la fois : une nouvelle connexion remplace l'ancienne.
export class Bridge {
  private socket?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  // Appels en attente de la connexion de l'extension.
  private waiters = new Set<() => void>();
  startError?: string;
  extensionVersion?: string;

  constructor(readonly port: number) {}

  get url(): string {
    return `ws://${HOST}:${this.port}`;
  }

  start(): void {
    const wss = new WebSocketServer({
      host: HOST,
      port: this.port,
      // N'importe quelle page web peut ouvrir un WebSocket vers localhost : on n'accepte que les extensions.
      verifyClient: ({ origin }: { origin?: string }) => typeof origin === "string" && origin.startsWith("moz-extension://"),
    });
    wss.on("listening", () => log(`en attente de l'extension sur ${this.url}`));
    wss.on("error", (err) => {
      this.startError = err.message;
      log(`WebSocket indisponible sur le port ${this.port} : ${err.message}`);
    });
    wss.on("connection", (ws) => this.attach(ws));
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private attach(ws: WebSocket): void {
    this.socket?.close(4000, "remplacée par une nouvelle connexion");
    this.socket = ws;
    log("extension connectée");
    for (const wake of [...this.waiters]) wake();
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.extensionVersion = undefined;
      log("extension déconnectée");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("L'extension s'est déconnectée pendant la requête"));
        this.pending.delete(id);
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; type?: string; version?: string; result?: unknown; error?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      log("message illisible de l'extension ignoré");
      return;
    }
    if (msg.type === "hello") {
      this.extensionVersion = msg.version;
      return;
    }
    const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  // Résout dès que l'extension est connectée, ou après timeoutMs.
  private waitForExtension(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      this.waiters.add(wake);
    });
  }

  async call<T>(method: string, params: object = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.startError) await this.waitForExtension(CONNECT_WAIT_MS);
    if (!this.connected) {
      const reason = this.startError
        ? `le serveur WebSocket n'a pas démarré (${this.startError})`
        : "l'extension Firefox n'est pas connectée (lancer `npm run firefox` dans firefox-jev-mcp)";
      throw new Error(`Navigateur indisponible : ${reason}`);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pas de réponse de l'extension pour ${method} après ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
}
