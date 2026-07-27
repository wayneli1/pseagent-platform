import { describe, expect, it } from "vitest";
import { normalizeDirectMessage } from "./message-normalizer.js";

describe("normalizeDirectMessage", () => {
  it("normalizes string and object private-message payloads", () => {
    const message = normalizeDirectMessage({
      topic: "/cim/message",
      payload: JSON.stringify({
        msgId: "m1",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        to: { uid: "#bot#U" },
        subject: "你好",
        time: "2026-07-27 10:00:00",
      }),
    }, "#bot#U");
    expect(message).toMatchObject({
      id: "m1",
      peerUid: "#peer#U",
      senderUid: "#peer#U",
      text: "你好",
      hasAttachments: false,
    });
  });

  it("rejects groups, self messages and unknown events", () => {
    expect(normalizeDirectMessage({
      topic: "/cim/message",
      payload: {
        sourceId: "#group#G",
        from: { uid: "#peer#U" },
        to: { uid: "#group#G" },
        subject: "群消息",
      },
    }, "#bot#U")).toBeUndefined();
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        sourceId: "#bot#U",
        from: { uid: "#bot#U" },
        subject: "自己的回复",
      },
    }, "#bot#U")).toBeUndefined();
    expect(normalizeDirectMessage({ topic: "presence", payload: {} }, "#bot#U"))
      .toBeUndefined();
  });

  it("marks attachment-only private messages", () => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: "m2",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        attachments: [{ id: "file" }],
      },
    }, "#bot#U")).toMatchObject({
      id: "m2",
      text: "",
      hasAttachments: true,
    });
  });
});
