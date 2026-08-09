import { describe, expect, it, vi } from "vitest";
import type { LunkrDirectConfig } from "./config.js";
import type { LunkrSession } from "./contracts.js";
import { LunkrSocketClient } from "./socket-client.js";
import {
  buildSocketEvent,
  parseEngineHandshake,
  parseSocketFrame,
} from "./socket-protocol.js";

describe("Socket.IO protocol", () => {
  it("parses the EIO=3 polling handshake", () => {
    expect(parseEngineHandshake(
      '96:0{"sid":"engine-sid","upgrades":["websocket"],"pingInterval":25000}',
    )).toEqual({ sid: "engine-sid", pingInterval: 25_000 });
  });

  it("handles connect, events and ping/pong frames", () => {
    expect(parseSocketFrame("40")).toEqual({ type: "connected" });
    expect(parseSocketFrame("2probe")).toEqual({ type: "send", frame: "3probe" });
    expect(parseSocketFrame('42["ready",{}]')).toEqual({
      type: "event",
      name: "ready",
      data: {},
    });
    expect(parseSocketFrame('42["message",{"topic":"inbox"}]')).toMatchObject({
      type: "event",
      name: "message",
    });
  });

  it("builds a Socket.IO auth event without changing the payload", () => {
    expect(buildSocketEvent("auth", { uid: "#bot#U" }))
      .toBe('42["auth",{"uid":"#bot#U"}]');
  });
});

describe("LunkrSocketClient", () => {
  it("subscribes with GET before starting the Socket.IO handshake", async () => {
    let subscribeRequest: RequestInit | undefined;
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      if (url.searchParams.get("func") === "cim.common:getWebSocketURL") {
        return Response.json({
          code: "S_OK",
          var: "https://sio.example.test",
        });
      }
      if (url.searchParams.get("func") === "cim.common:sioSubscribe") {
        subscribeRequest = init;
        return Response.json({ code: "S_OK" });
      }
      return new Response(
        '96:0{"sid":"engine-sid","upgrades":["websocket"],"pingInterval":25000}',
      );
    });
    const config: LunkrDirectConfig = {
      baseUrl: "https://lunkr.example.test",
      apiPath: "/lunkr/s/json",
      sessionPath: "session.json",
      passwordPath: "password.json",
      connectTimeoutMs: 30_000,
      reconnectMaxMs: 30_000,
      messageDedupeTtlMs: 600_000,
      messageDedupeMax: 2_000,
      contextMaxTurns: 6,
      contextMaxChars: 12_000,
      messageMaxChars: 1_000,
      questionBudgetMs: 300_000,
      maxActivePeers: 4,
      maxPendingPerPeer: 5,
      sessionIdleMs: 600_000,
      feedbackReceiptTtlMs: 1_800_000,
      feedbackReceiptMax: 2_000,
    };
    const session: LunkrSession = {
      email: "bot@example.test",
      selfUid: "#bot#U",
      deviceUuid: "device",
      sid: "session",
      cookie: "Cim=cookie",
      createdAt: "2026-08-09T00:00:00.000Z",
      lastVerifiedAt: "2026-08-09T00:00:00.000Z",
    };
    const client = new LunkrSocketClient(
      config,
      session,
      { onEvent: vi.fn() },
      fetchImpl as typeof fetch,
      () => {
        throw new Error("stop-before-websocket");
      },
    );

    await expect(client.connect()).rejects.toThrow("stop-before-websocket");

    expect(subscribeRequest?.method).toBe("GET");
    expect(subscribeRequest?.body).toBeUndefined();
  });
});
