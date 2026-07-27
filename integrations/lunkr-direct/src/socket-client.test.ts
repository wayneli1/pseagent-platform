import { describe, expect, it } from "vitest";
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
