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

  it.each([
    "read",
    "receipt",
    "typing",
    "presence",
    "delivered",
    "open",
  ])("silently ignores the %s control message type", (contentType) => {
    expect(normalizeDirectMessage({
      topic: "/cim/message",
      payload: {
        msgId: `control-${contentType}`,
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        to: { uid: "#bot#U" },
        subject: "控制事件不得作为用户消息",
        contentType,
      },
    }, "#bot#U")).toBeUndefined();
  });

  it("rejects non-message CIM topics instead of treating them as attachments", () => {
    expect(normalizeDirectMessage({
      topic: "/cim/read",
      payload: {
        msgId: "window-open",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        to: { uid: "#bot#U" },
        subject: "打开聊天窗口",
        contentType: "read",
      },
    }, "#bot#U")).toBeUndefined();
  });

  it("silently ignores an unknown message type even when it carries text", () => {
    expect(normalizeDirectMessage({
      topic: "/cim/message",
      payload: {
        msgId: "unknown-window-state",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        to: { uid: "#bot#U" },
        subject: "未知客户端状态",
        contentType: "window-state-v2",
      },
    }, "#bot#U")).toBeUndefined();
  });

  it("does not treat empty attachment containers as real attachments", () => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: "ordinary-text-with-empty-attachments",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        subject: "正常文字消息",
        attachments: [],
        files: [],
        fileInfo: {},
        attachment: {},
        contentType: "text",
      },
    }, "#bot#U")).toMatchObject({
      text: "正常文字消息",
      hasAttachments: false,
    });

    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: "blank-control-with-empty-attachments",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        attachments: [],
        fileInfo: {},
      },
    }, "#bot#U")).toBeUndefined();
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

  it.each(["image", "file", "voice", "audio", "video", "card"])(
    "marks the explicit %s message type as non-text content",
    (contentType) => {
      expect(normalizeDirectMessage({
        topic: "/cim/message",
        payload: {
          msgId: `attachment-${contentType}`,
          sourceId: "#peer#U",
          from: { uid: "#peer#U" },
          to: { uid: "#bot#U" },
          contentType,
        },
      }, "#bot#U")).toMatchObject({
        text: "",
        hasAttachments: true,
      });
    },
  );

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

  it.each([
    ["%2Fnew", "/new", "new"],
    ["%2Fhelp", "/help", "help"],
    ["%EF%BC%8Fnew", "／new", "new"],
  ] as const)(
    "decodes the documented form-encoded subject %j before recognizing commands",
    (subject, text, command) => {
      expect(normalizeDirectMessage({
        topic: "inbox",
        payload: JSON.stringify({
          mid: `encoded-${command}`,
          uid: "#peer#U",
          from: { uid: "#peer#U" },
          subject,
        }),
      }, "#bot#U")).toMatchObject({ text, command });
    },
  );

  it("decodes ordinary form-encoded subject text exactly once", () => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: JSON.stringify({
        mid: "encoded-question",
        uid: "#peer#U",
        from: { uid: "#peer#U" },
        subject: "%E5%AE%A2%E6%88%B7+%E9%9C%80%E6%B1%82",
      }),
    }, "#bot#U")).toMatchObject({
      text: "客户 需求",
    });
  });

  it.each(["%252Fnew", "%2Fnew+please", "%E0%A4%A"])(
    "does not widen encoded command matching for %j",
    (subject) => {
      expect(normalizeDirectMessage({
        topic: "inbox",
        payload: JSON.stringify({
          mid: `encoded-ordinary-${subject}`,
          uid: "#peer#U",
          from: { uid: "#peer#U" },
          subject,
        }),
      }, "#bot#U")).not.toHaveProperty("command");
    },
  );
});
