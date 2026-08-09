import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { LunkrSession } from "./contracts.js";
import type { LunkrDirectConfig } from "./config.js";
import { SecureHttpClient } from "./http-client.js";
import { cookieHeader } from "./lunkr-api.js";
import {
  buildSocketEvent,
  parseEngineHandshake,
  parseSocketFrame,
} from "./socket-protocol.js";

export interface LunkrSocketHandlers {
  readonly onEvent: (name: string, data: unknown) => void;
  readonly onState?: (state: "connected" | "authenticated" | "disconnected") => void;
}

export class LunkrSocketClient {
  private socket: WebSocket | undefined;
  private closed = false;
  private authenticated = false;
  private reconnectAttempts = 0;
  private terminationResolve: (() => void) | undefined;
  private readonly termination = new Promise<void>((resolve) => {
    this.terminationResolve = resolve;
  });

  constructor(
    private readonly config: LunkrDirectConfig,
    private readonly session: LunkrSession,
    private readonly handlers: LunkrSocketHandlers,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly createSocket: (
      url: string,
      options: WebSocket.ClientOptions,
    ) => WebSocket = (url, options) => new WebSocket(url, options),
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    await this.connectOnce();
  }

  async wait(): Promise<void> {
    await this.termination;
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = undefined;
    this.terminationResolve?.();
    this.terminationResolve = undefined;
  }

  private async connectOnce(): Promise<void> {
    const api = new SecureHttpClient(
      this.config.baseUrl,
      this.config.connectTimeoutMs,
      this.fetchImpl,
    );
    const webSocketUrl = await api.lunkr<string | { webSocketURL?: unknown }>({
      apiPath: this.config.apiPath,
      func: "cim.common:getWebSocketURL",
      uid: this.session.email,
      sid: this.session.sid,
      cookie: cookieHeader(this.session),
      method: "GET",
    });
    if (webSocketUrl.body.code !== "S_OK") {
      throw new Error(`获取 Lunkr WebSocket 地址失败（code=${webSocketUrl.body.code}）`);
    }
    const socketOrigin = readSocketOrigin(webSocketUrl.body.var);
    await this.subscribe(api);
    const handshake = await this.pollHandshake(socketOrigin);
    await this.upgrade(socketOrigin, handshake.sid);
    this.startHeartbeat(handshake.pingInterval);
  }

  private async subscribe(client: SecureHttpClient): Promise<void> {
    const response = await client.lunkr({
      apiPath: this.config.apiPath,
      func: "cim.common:sioSubscribe",
      sid: this.session.sid,
      cookie: cookieHeader(this.session),
      method: "GET",
    });
    if (response.body.code !== "S_OK") {
      throw new Error(`Lunkr 实时消息订阅失败（code=${response.body.code}）`);
    }
  }

  private async pollHandshake(origin: URL) {
    const url = new URL("/socket.io/1/", origin);
    url.searchParams.set("t", Date.now().toString());
    url.searchParams.set("EIO", "3");
    url.searchParams.set("transport", "polling");
    const response = await this.fetchImpl(url, {
      headers: { Cookie: cookieHeader(this.session) },
      signal: AbortSignal.timeout(this.config.connectTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Socket.IO 握手失败（status=${response.status}）`);
    }
    return parseEngineHandshake(await response.text());
  }

  private async upgrade(origin: URL, engineSid: string): Promise<void> {
    const url = new URL("/socket.io/1/websocket/", origin);
    url.protocol = "wss:";
    url.searchParams.set("EIO", "3");
    url.searchParams.set("transport", "websocket");
    url.searchParams.set("sid", engineSid);
    await new Promise<void>((resolve, reject) => {
      let upgraded = false;
      const socket = this.createSocket(url.toString(), {
        headers: { Cookie: cookieHeader(this.session) },
        handshakeTimeout: this.config.connectTimeoutMs,
      });
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Socket.IO 认证超时"));
      }, this.config.connectTimeoutMs);
      socket.once("open", () => socket.send("2probe"));
      socket.on("message", (raw: RawData) => {
        const frame = raw.toString();
        if (!upgraded) {
          if (frame !== "3probe") {
            clearTimeout(timeout);
            reject(new Error("Socket.IO WebSocket 升级失败"));
            return;
          }
          upgraded = true;
          socket.send("5");
          return;
        }
        const action = parseSocketFrame(frame);
        if (action.type === "send") socket.send(action.frame);
        if (action.type === "connected") {
          this.handlers.onState?.("connected");
          socket.send(buildSocketEvent("auth", this.authPayload()));
        }
        if (action.type === "event") {
          if (action.name === "ready") {
            this.authenticated = true;
            this.reconnectAttempts = 0;
            clearTimeout(timeout);
            this.handlers.onState?.("authenticated");
            resolve();
          }
          if (action.name === "auth_error") {
            clearTimeout(timeout);
            reject(new Error("Lunkr Socket 认证失败"));
          }
          this.handlers.onEvent(action.name, action.data);
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.once("close", () => {
        clearTimeout(timeout);
        this.authenticated = false;
        this.handlers.onState?.("disconnected");
        if (!this.closed) this.scheduleReconnect();
      });
    });
  }

  private authPayload(): Record<string, string> {
    const cim = this.session.cookie.match(/(?:^|;\s*)Cim=([^;]+)/)?.[1] ?? "";
    return {
      username: this.session.email,
      clientId: `pc:${this.session.sid}_1`,
      password: `{SES}${this.session.sid}:${cim}`,
      uid: this.session.selfUid,
      uuid: randomUUID(),
    };
  }

  private startHeartbeat(intervalMs: number): void {
    const timer = setInterval(() => {
      if (
        this.socket?.readyState === WebSocket.OPEN &&
        this.authenticated
      ) {
        this.socket.send("2");
      }
    }, intervalMs);
    timer.unref();
    this.socket?.once("close", () => clearInterval(timer));
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(
      1_000 * 2 ** Math.min(this.reconnectAttempts - 1, 10),
      this.config.reconnectMaxMs,
    );
    const timer = setTimeout(() => {
      if (this.closed) return;
      void this.connectOnce().catch(() => this.scheduleReconnect());
    }, delay);
    timer.unref();
  }
}

function readSocketOrigin(value: unknown): URL {
  const raw = typeof value === "string"
    ? value
    : value !== null && typeof value === "object"
      ? (value as Record<string, unknown>).webSocketURL
      : undefined;
  if (typeof raw !== "string") throw new Error("Lunkr 未返回 WebSocket 地址");
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Lunkr WebSocket 地址必须使用 HTTPS/WSS");
  }
  return url;
}
