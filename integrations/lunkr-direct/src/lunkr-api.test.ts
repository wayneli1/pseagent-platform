import { describe, expect, it, vi } from "vitest";
import type { LunkrDirectConfig } from "./config.js";
import type { LunkrSession } from "./contracts.js";
import { LunkrApi, splitText } from "./lunkr-api.js";

const config: LunkrDirectConfig = {
  baseUrl: "https://lunkr.example.test",
  apiPath: "/lunkr/s/json",
  sessionPath: "unused",
  passwordPath: "unused",
  connectTimeoutMs: 1_000,
  reconnectMaxMs: 1_000,
  messageDedupeTtlMs: 1_000,
  messageDedupeMax: 100,
  contextMaxTurns: 6,
  contextMaxChars: 12_000,
  messageMaxChars: 10,
  questionBudgetMs: 300_000,
  maxActivePeers: 4,
  maxPendingPerPeer: 5,
  sessionIdleMs: 86_400_000,
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
const combinedConfig: LunkrDirectConfig = {
  ...config,
  messageMaxChars: 1_000,
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

  it("sends a long answer as one native text post", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ code: "S_OK" })));
    await new LunkrApi(config, session, fetchImpl).sendPost(
      "#peer#U",
      "PSEAgent 问题 #7 的完整回答.txt",
      "一段超过普通消息限制的完整回答",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toContain("func=cim.file%3AuploadPost");
    expect(JSON.parse(String(init?.body))).toEqual({
      uid: "#peer#U",
      fileInfo: {
        title: "PSEAgent 问题 #7 的完整回答.txt",
        content: "一段超过普通消息限制的完整回答",
      },
    });
  });

  it("uploads UTF-8 text and sends the caption with the attachment in one reply", async () => {
    const content = "中文完整回答";
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const func = new URL(String(input)).searchParams.get("func");
      switch (func) {
        case "cim.file:prepare":
          return new Response(JSON.stringify({
            code: "S_OK",
            var: { attachmentId: 1729 },
          }));
        case "cim.file:directData":
          return new Response(JSON.stringify({ code: "S_OK" }), {
            headers: { "set-cookie": "Cim=rotated; Path=/; Secure" },
          });
        case "cim.file:moveToNetFolder":
          return new Response(JSON.stringify({
            code: "S_OK",
            var: { fileId: "file-1", uid: "#bot#U" },
          }));
        case "cim.msg:reply":
          return new Response(JSON.stringify({ code: "S_OK" }));
        default:
          throw new Error(`unexpected func: ${func}`);
      }
    });

    await new LunkrApi(combinedConfig, session, fetchImpl).sendTextFile(
      "#peer#U",
      "问题#7-完整回答.txt",
      content,
      "问题 #7 已处理完成\n本次回答涵盖：部署、监控。完整内容见附件。",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const calls = fetchImpl.mock.calls;
    const prepare = calls.find(([input]) =>
      String(input).includes("func=cim.file%3Aprepare"));
    expect(JSON.parse(String(prepare?.[1]?.body))).toMatchObject({
      size: new TextEncoder().encode(content).byteLength,
      composeId: expect.stringMatching(/^c:nf:cim\d+$/u),
      fileName: "问题#7-完整回答.txt",
      uid: "#bot#U",
      contentType: "text/plain",
    });

    const direct = calls.find(([input]) =>
      String(input).includes("func=cim.file%3AdirectData"));
    expect(String(direct?.[0])).toContain("attachmentId=1729");
    expect(String(direct?.[0])).toContain("uid=%23bot%23U");
    expect(new TextDecoder().decode(direct?.[1]?.body as Uint8Array)).toBe(content);

    const move = calls.find(([input]) =>
      String(input).includes("func=cim.file%3AmoveToNetFolder"));
    expect(move?.[1]?.headers).toMatchObject({
      Cookie: expect.stringContaining("Cim=rotated"),
    });
    expect(JSON.parse(String(move?.[1]?.body))).toMatchObject({
      attachmentId: "1729",
      fileName: "问题#7-完整回答.txt",
      uid: "#bot#U",
    });

    const reply = calls.find(([input]) =>
      String(input).includes("func=cim.msg%3Areply"));
    expect(JSON.parse(String(reply?.[1]?.body))).toEqual({
      uid: "#peer#U",
      clientMid: expect.any(String),
      content: "问题 #7 已处理完成\n本次回答涵盖：部署、监控。完整内容见附件。",
      attachments: [{ fileId: "file-1", uid: "#bot#U" }],
    });
  });

  it("retries only the final combined reply with one stable clientMid", async () => {
    let replyAttempt = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const func = new URL(String(input)).searchParams.get("func");
      if (func === "cim.file:prepare") {
        return new Response(JSON.stringify({
          code: "S_OK",
          var: { attachmentId: "attachment-1" },
        }));
      }
      if (func === "cim.file:moveToNetFolder") {
        return new Response(JSON.stringify({
          code: "S_OK",
          var: { fileId: "file-1", uid: "#bot#U" },
        }));
      }
      if (func === "cim.msg:reply") {
        replyAttempt += 1;
        return new Response(JSON.stringify({
          code: replyAttempt === 1 ? "E_BUSY" : "S_OK",
        }));
      }
      return new Response(JSON.stringify({ code: "S_OK" }));
    });

    await new LunkrApi(combinedConfig, session, fetchImpl).sendTextFile(
      "#peer#U",
      "回答.txt",
      "正文",
      "说明",
    );

    const replyBodies = fetchImpl.mock.calls
      .filter(([input]) => String(input).includes("func=cim.msg%3Areply"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(replyBodies).toHaveLength(2);
    expect(replyBodies[0].clientMid).toBe(replyBodies[1].clientMid);
    expect(fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes("func=cim.file%3Aprepare"))).toHaveLength(1);
  });

  it("validates combined attachment inputs before uploading", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = new LunkrApi(combinedConfig, session, fetchImpl);

    await expect(api.sendTextFile("#group#G", "回答.txt", "正文", "说明"))
      .rejects.toThrow("只允许");
    await expect(api.sendTextFile("#peer#U", " ", "正文", "说明"))
      .rejects.toThrow("附件标题不能为空");
    await expect(api.sendTextFile("#peer#U", "回答.txt", " ", "说明"))
      .rejects.toThrow("附件正文不能为空");
    await expect(api.sendTextFile("#peer#U", "回答.txt", "正文", " "))
      .rejects.toThrow("附件说明不能为空");
    await expect(api.sendTextFile(
      "#peer#U",
      "回答.txt",
      "正文",
      "甲".repeat(1_001),
    )).rejects.toThrow("附件说明超过");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects incomplete attachment identifiers", async () => {
    const prepareWithoutId = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "S_OK", var: {} })),
    );
    await expect(new LunkrApi(
      combinedConfig,
      session,
      prepareWithoutId,
    ).sendTextFile("#peer#U", "回答.txt", "正文", "说明"))
      .rejects.toThrow("attachmentId");

    const moveWithoutId = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const func = new URL(String(input)).searchParams.get("func");
      return new Response(JSON.stringify(
        func === "cim.file:prepare"
          ? { code: "S_OK", var: { attachmentId: "attachment-1" } }
          : { code: "S_OK", var: {} },
      ));
    });
    await expect(new LunkrApi(
      combinedConfig,
      session,
      moveWithoutId,
    ).sendTextFile("#peer#U", "回答.txt", "正文", "说明"))
      .rejects.toThrow("fileId");
  });

  it("validates native text post inputs before sending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = new LunkrApi(config, session, fetchImpl);

    await expect(api.sendPost("#group#G", "回答.txt", "正文"))
      .rejects.toThrow("只允许");
    await expect(api.sendPost("#peer#U", "  ", "正文"))
      .rejects.toThrow("标题不能为空");
    await expect(api.sendPost("#peer#U", "回答.txt", "  "))
      .rejects.toThrow("正文不能为空");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports native text post response failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ code: "E_DENIED" })));

    await expect(new LunkrApi(config, session, fetchImpl).sendPost(
      "#peer#U",
      "回答.txt",
      "正文",
    )).rejects.toThrow("长回答发送失败（code=E_DENIED）");
  });

  it("refuses group destinations", async () => {
    await expect(new LunkrApi(config, session).sendText("#group#G", "hello"))
      .rejects.toThrow("只允许");
  });
});
