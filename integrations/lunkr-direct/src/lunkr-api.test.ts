import { describe, expect, it, vi } from "vitest";
import type { LunkrDirectConfig } from "./config.js";
import type { LunkrSession } from "./contracts.js";
import { LunkrApi, splitText } from "./lunkr-api.js";

const config: LunkrDirectConfig = {
  baseUrl: "https://lunkr.example.test",
  apiPath: "/lunkr/s/json",
  sessionPath: "unused",
  connectTimeoutMs: 1_000,
  reconnectMaxMs: 1_000,
  messageDedupeTtlMs: 1_000,
  messageDedupeMax: 100,
  contextMaxTurns: 6,
  contextMaxChars: 12_000,
  messageMaxChars: 10,
  maxActivePeers: 4,
  maxPendingPerPeer: 5,
};
const session: LunkrSession = {
  email: "bot@example.test",
  selfUid: "#bot#U",
  deviceUuid: "device",
  sid: "sid",
  cookie: "Cim=cookie",
  createdAt: "2026-07-27T00:00:00.000Z",
  lastVerifiedAt: "2026-07-27T00:00:00.000Z",
};

describe("LunkrApi", () => {
  it("splits long answers at readable boundaries", () => {
    const chunks = splitText("第一段文字。第二段文字。第三段文字。", 10);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks.join("")).toBe("第一段文字。第二段文字。第三段文字。");
  });

  it("sends all chunks to the same private peer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ code: "S_OK" })));
    await new LunkrApi(config, session, fetchImpl)
      .sendText("#peer#U", "123456789012345678901");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(String(input)).toContain("func=cim.msg%3Areply");
      expect(JSON.parse(String(init?.body))).toMatchObject({ uid: "#peer#U" });
    }
  });

  it("refuses group destinations", async () => {
    await expect(new LunkrApi(config, session).sendText("#group#G", "hello"))
      .rejects.toThrow("只允许");
  });
});
