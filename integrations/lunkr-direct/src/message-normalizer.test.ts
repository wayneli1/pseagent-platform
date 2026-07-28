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

  it.each([
    ["/new", "new"],
    ["  /new  ", "new"],
    ["\uFEFF/new", "new"],
    ["/\u200Bnew", "new"],
    ["／new", "new"],
    ["/help", "help"],
  ] as const)("recognizes exact normalized command %j", (subject, command) => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: `command-${command}-${subject.length}`,
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        subject,
      },
    }, "#bot#U")).toMatchObject({ command });
  });

  it.each(["/new 请继续", "前缀/new", "/newer", "```/new```"])(
    "does not widen command matching for %j",
    (subject) => {
      expect(normalizeDirectMessage({
        topic: "inbox",
        payload: {
          msgId: `ordinary-${subject}`,
          sourceId: "#peer#U",
          from: { uid: "#peer#U" },
          subject,
        },
      }, "#bot#U")).not.toHaveProperty("command");
    },
  );

  it("recognizes /new from the documented string payload content field", () => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: JSON.stringify({
        msgId: "documented-new",
        sourceId: "#peer#U",
        from: "#peer#U",
        content: "/new",
      }),
    }, "#bot#U")).toMatchObject({ command: "new" });
  });
});
