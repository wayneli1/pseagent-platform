import { describe, expect, it } from "vitest";
import type { BridgeQuestionEvent } from "./bridge.js";
import {
  createRuntimeLogger,
  type LunkrRuntimeLogRecord,
} from "./runtime-log.js";

describe("createRuntimeLogger", () => {
  it("hashes peers and never serializes message content or credentials", () => {
    const lines: string[] = [];
    const log = createRuntimeLogger(
      (line) => lines.push(line),
      new Uint8Array(32).fill(7),
    );

    log({
      type: "answered",
      peerUid: "#secret-peer#U",
      questionId: 3,
      sessionEpoch: 2,
      pendingCount: 1,
      activePeerCount: 4,
      scope: "general",
      status: "answered",
      stopReason: "final",
      elapsedMs: 12_345,
      referenceCount: 2,
      historicalAttempted: true,
      historicalUsed: false,
    });

    const serialized = lines.join("");
    expect(serialized).not.toContain("#secret-peer#U");
    expect(serialized).not.toContain("password");
    expect(serialized).toContain('"questionId":3');
    expect(serialized).toContain('"sessionEpoch":2');
    expect(serialized).toContain('"referenceCount":2');
    expect(serialized).toContain('"historicalAttempted":true');
    expect(serialized).toContain('"historicalUsed":false');
    expect(serialized).toMatch(/"peer":"[0-9a-f]{16}"/u);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(serialized))).not.toEqual(
      expect.arrayContaining([
        "question",
        "answer",
        "content",
        "title",
        "url",
        "uid",
        "cookie",
        "sid",
        "token",
      ]),
    );
  });

  it("uses a stable peer hash only within one logger salt", () => {
    const firstLines: string[] = [];
    const secondLines: string[] = [];
    const first = createRuntimeLogger(
      (line) => firstLines.push(line),
      new Uint8Array(32).fill(1),
    );
    const second = createRuntimeLogger(
      (line) => secondLines.push(line),
      new Uint8Array(32).fill(2),
    );
    const event: BridgeQuestionEvent = {
      type: "received",
      peerUid: "#same-peer#U",
      questionId: 1,
      pendingCount: 0,
      activePeerCount: 1,
    };

    first(event);
    first({ ...event, type: "started" });
    second(event);

    const firstPeers = firstLines.map(readPeer);
    const secondPeer = readPeer(secondLines[0]!);
    expect(firstPeers[0]).toBe(firstPeers[1]);
    expect(firstPeers[0]).not.toBe(secondPeer);
  });

  it("writes only lifecycle fields that are present on the event", () => {
    const lines: string[] = [];
    const log = createRuntimeLogger(
      (line) => lines.push(line),
      new Uint8Array(32).fill(3),
    );

    log({
      type: "cancelled",
      peerUid: "#peer#U",
      sessionEpoch: 3,
      resetReason: "idle",
      pendingCount: 2,
      activePeerCount: 1,
    });

    const expected: LunkrRuntimeLogRecord = {
      event: "cancelled",
      peer: expect.stringMatching(/^[0-9a-f]{16}$/u),
      sessionEpoch: 3,
      resetReason: "idle",
      pendingCount: 2,
      activePeerCount: 1,
    };
    expect(JSON.parse(lines[0]!)).toEqual(expected);
  });
});

function readPeer(line: string): string {
  return String((JSON.parse(line) as { peer: unknown }).peer);
}
