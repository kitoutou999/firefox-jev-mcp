import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
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
// Demande de libération du port entre deux serveurs firefox-jev. L'en-tête personnalisé impose un preflight
// CORS que le serveur ne satisfait pas : une page web ne peut pas l'envoyer.
const RELEASE_PATH = "/release";
const RELEASE_HEADER = "x-firefox-jev";

// Profil Firefox de l'extension : "default", le profil habituel de l'utilisateur, qui ne se connecte qu'après un
// clic sur le bouton de l'extension ; "dedicated", le profil dédié lancé par web-ext, connecté en permanence.
export type Profile = "default" | "dedicated";

// Délai laissé à une nouvelle connexion pour se présenter (message hello).
const HELLO_TIMEOUT_MS = 2000;

// Serveur WebSocket local auquel l'extension Firefox se connecte.
// Une seule extension à la fois. Le profil habituel, activé à la main, passe avant le profil dédié : il remplace
// sa connexion, et le profil dédié est refusé tant qu'il est connecté.
// Enregistré pour tous les projets, le serveur MCP tourne dans chaque session Claude Code : il n'ouvre donc le
// port qu'au premier appel d'outil, et le reprend à une autre session si elle l'occupe déjà. C'est la dernière
// session à se servir de Firefox qui le pilote.
export class Bridge {
  private http?: Server;
  private starting?: Promise<void>;
  private socket?: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  // Appels en attente de la connexion de l'extension.
  private waiters = new Set<() => void>();
  startError?: string;
  extensionVersion?: string;
  profile?: Profile;

  constructor(readonly port: number) {}

  get url(): string {
    return `ws://${HOST}:${this.port}`;
  }

  get listening(): boolean {
    return this.http !== undefined;
  }

  // Ouvre le port si ce n'est pas déjà fait. Rejette avec un message lisible si c'est impossible.
  start(): Promise<void> {
    this.starting ??= this.listen().then(
      () => {
        this.startError = undefined;
        log(`en attente de l'extension sur ${this.url}`);
      },
      (err: Error) => {
        this.starting = undefined;
        this.startError = err.message;
        log(`WebSocket indisponible sur le port ${this.port} : ${err.message}`);
        throw new Error(`Navigateur indisponible : le serveur WebSocket n'a pas démarré (${err.message})`);
      },
    );
    return this.starting;
  }

  // Ouvre le port et attend l'extension quelques secondes (ou timeoutMs). Renvoie true si elle est connectée.
  async connect(timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    await this.start();
    await this.waitForExtension(timeoutMs);
    return this.connected;
  }

  private async listen(): Promise<void> {
    try {
      return await this.bind();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
    await this.askRelease();
    // L'autre serveur ferme son port juste après avoir répondu.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.bind();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt === 20) throw err;
        await sleep(50);
      }
    }
  }

  private bind(): Promise<void> {
    const http = createServer((req, res) => this.onHttp(req, res));
    return new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.port, HOST, () => {
        http.off("error", reject);
        // Créé une fois le port obtenu : ws relaie sur son serveur les erreurs du serveur HTTP.
        const wss = new WebSocketServer({
          server: http,
          // N'importe quelle page web peut ouvrir un WebSocket vers localhost : on n'accepte que les extensions.
          verifyClient: ({ origin }: { origin?: string }) => typeof origin === "string" && origin.startsWith("moz-extension://"),
        });
        wss.on("error", (err) => log(`erreur du serveur WebSocket : ${err.message}`));
        wss.on("connection", (ws) => this.attach(ws));
        this.http = http;
        resolve();
      });
    });
  }

  // Requêtes HTTP simples : la sonde de l'extension (toute réponse lui suffit) et la demande de libération
  // du port par le serveur d'une autre session.
  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "POST" && req.url === RELEASE_PATH && req.headers[RELEASE_HEADER] === "release" && !req.headers.origin) {
      res.end("ok", () => this.release());
      return;
    }
    res.writeHead(426).end();
  }

  // Cède le port à une autre session. Un prochain appel d'outil dans cette session le reprendra.
  private release(): void {
    if (!this.http) return;
    log("port cédé à une autre session Claude Code");
    this.http.close();
    this.http.closeAllConnections();
    this.socket?.terminate();
    this.http = undefined;
    this.starting = undefined;
  }

  private askRelease(): Promise<void> {
    const busy = `port ${this.port} occupé par un autre programme (ou une ancienne version de firefox-jev-mcp)`;
    return new Promise((resolve, reject) => {
      const req = request(
        { host: HOST, port: this.port, method: "POST", path: RELEASE_PATH, headers: { [RELEASE_HEADER]: "release" }, timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(busy));
        },
      );
      req.on("timeout", () => req.destroy(new Error(busy)));
      req.on("error", reject);
      req.end();
    });
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private attach(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(4003, "hello attendu"), HELLO_TIMEOUT_MS);
    ws.once("message", (data) => {
      clearTimeout(timer);
      let hello: { type?: string; version?: string; profile?: string } | undefined;
      try {
        hello = JSON.parse(data.toString());
      } catch {}
      if (hello?.type !== "hello") return ws.close(4003, "hello attendu");
      // Une extension antérieure au profil habituel ne l'annonce pas : c'est alors le profil dédié.
      const profile: Profile = hello.profile === "default" ? "default" : "dedicated";
      if (profile === "dedicated" && this.connected) return ws.close(4002, "une autre fenêtre Firefox est pilotée");
      this.accept(ws, profile, hello.version);
    });
  }

  private accept(ws: WebSocket, profile: Profile, version?: string): void {
    this.socket?.close(4000, "remplacée par une nouvelle connexion");
    this.socket = ws;
    this.profile = profile;
    this.extensionVersion = version;
    ws.send(JSON.stringify({ type: "welcome" }));
    log(`extension connectée (profil ${profile === "default" ? "habituel" : "dédié"})`);
    for (const wake of [...this.waiters]) wake();
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.extensionVersion = undefined;
      this.profile = undefined;
      log("extension déconnectée");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("L'extension s'est déconnectée pendant la requête"));
        this.pending.delete(id);
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      log("message illisible de l'extension ignoré");
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
    if (!(await this.connect())) {
      throw new Error("Navigateur indisponible : l'extension Firefox n'est pas connectée (outil browser_launch, ou `npm run firefox` dans firefox-jev-mcp)");
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
