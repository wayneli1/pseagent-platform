export type SocketProtocolAction =
  | { readonly type: "none" }
  | { readonly type: "send"; readonly frame: string }
  | { readonly type: "connected" }
  | { readonly type: "disconnected" }
  | { readonly type: "event"; readonly name: string; readonly data: unknown };

export interface EngineHandshake {
  readonly sid: string;
  readonly pingInterval: number;
}

export function parseEngineHandshake(raw: string): EngineHandshake {
  const start = raw.indexOf('0{"sid"');
  const frame = start >= 0 ? raw.slice(start) : raw;
  if (!frame.startsWith("0{")) throw new Error("Socket.IO 握手响应格式无效");
  const value = JSON.parse(frame.slice(1)) as {
    sid?: unknown;
    pingInterval?: unknown;
    upgrades?: unknown;
  };
  if (
    typeof value.sid !== "string" ||
    !Array.isArray(value.upgrades) ||
    !value.upgrades.includes("websocket")
  ) {
    throw new Error("Socket.IO 服务端不支持 WebSocket 升级");
  }
  return {
    sid: value.sid,
    pingInterval:
      typeof value.pingInterval === "number" && value.pingInterval > 0
        ? value.pingInterval
        : 25_000,
  };
}

export function parseSocketFrame(frame: string): SocketProtocolAction {
  if (frame === "") return { type: "none" };
  if (frame === "2" || frame.startsWith("2")) {
    return { type: "send", frame: `3${frame.slice(1)}` };
  }
  if (frame === "40") return { type: "connected" };
  if (frame === "41") return { type: "disconnected" };
  if (!frame.startsWith("42")) return { type: "none" };
  let value: unknown;
  try {
    value = JSON.parse(frame.slice(2));
  } catch {
    return { type: "none" };
  }
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return { type: "none" };
  }
  return { type: "event", name: value[0], data: value[1] };
}

export function buildSocketEvent(name: string, data: unknown): string {
  return `42${JSON.stringify([name, data])}`;
}
