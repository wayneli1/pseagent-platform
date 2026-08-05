import { describe, expect, it } from "vitest";
import {
  normalizeDirectMessage,
  parseFeedbackCommand,
} from "./message-normalizer.js";

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

  it("accepts a structurally valid USER message without relying on its topic", () => {
    expect(normalizeDirectMessage({
      topic: "server-channel-v2",
      payload: JSON.stringify({
        fid: 2,
        uid: "#peer#U",
        mid: "server-mid",
        type: "USER",
        from: { uid: "#peer#U" },
        to: { uid: "#bot#U" },
        subject: "%E7%9C%9F%E5%AE%9E%E6%96%87%E5%AD%97%E6%B6%88%E6%81%AF",
        clientMid: "client-mid",
      }),
    }, "#bot#U")).toMatchObject({
      id: "server-mid",
      peerUid: "#peer#U",
      senderUid: "#peer#U",
      text: "真实文字消息",
      hasAttachments: false,
    });
  });

  it("requires a real message id and explicit sender structure", () => {
    expect(normalizeDirectMessage({
      topic: "server-channel-v2",
      payload: {
        uid: "#peer#U",
        from: { uid: "#peer#U" },
        to: { uid: "#bot#U" },
        subject: "缺少消息 ID",
      },
    }, "#bot#U")).toBeUndefined();
    expect(normalizeDirectMessage({
      topic: "server-channel-v2",
      payload: {
        mid: "missing-sender",
        uid: "#peer#U",
        to: { uid: "#bot#U" },
        subject: "缺少发送者",
      },
    }, "#bot#U")).toBeUndefined();
  });

  it("ignores clearUnread and P2P negotiation payloads on CIM topics", () => {
    expect(normalizeDirectMessage({
      topic: "/cim/inbox/control",
      payload: {
        op_type: "clearUnread",
        uid: "#peer#U",
        user_type: "USER",
        last_mid: "last-read-mid",
      },
    }, "#bot#U")).toBeUndefined();
    expect(normalizeDirectMessage({
      topic: "/cim/p2p",
      payload: {
        uid: "#peer#U",
        action: "start",
        attachments: [{
          uid: "#bot#U",
          title: "connection metadata",
          file_size: 1,
        }],
      },
    }, "#bot#U")).toBeUndefined();
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

  it.each(["chat-text-v2", "custom-text-v2", "html", "richtext", "card"])(
    "treats the non-control %s message type as ordinary text",
    (contentType) => {
      expect(normalizeDirectMessage({
        topic: "/cim/message",
        payload: {
          msgId: `ordinary-${contentType}`,
          sourceId: "#peer#U",
          from: { uid: "#peer#U" },
          to: { uid: "#bot#U" },
          subject: "未知类型文字",
          contentType,
        },
      }, "#bot#U")).toMatchObject({
        text: "未知类型文字",
        hasAttachments: false,
      });
    },
  );

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

    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: "ordinary-text-with-status-metadata",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        subject: "状态元数据不是附件",
        fileInfo: { status: "none" },
      },
    }, "#bot#U")).toMatchObject({
      text: "状态元数据不是附件",
      hasAttachments: false,
    });
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
    "image",
    "image/png",
    "file",
    "application/pdf",
    "voice",
    "audio/ogg",
    "video/mp4",
    "attachment",
  ])(
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
    ["/status", "status"],
    ["/feedback #12 useful", "feedback"],
    ["/q 1", "feedback"],
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

  it("parses valid feedback without widening invalid feedback into a question", () => {
    expect(parseFeedbackCommand("／feedback ＃１２ incorrect  缺少版本边界 "))
      .toEqual({
        questionId: 12,
        classification: "incorrect",
        comment: "缺少版本边界",
      });
    expect(parseFeedbackCommand("/feedback #2 useful")).toEqual({
      questionId: 2,
      classification: "useful",
      comment: "",
    });
    expect(parseFeedbackCommand("/feedback #2 missing")).toBeUndefined();
    expect(parseFeedbackCommand("／q ２  版本判断错误 ")).toEqual({
      classification: "incorrect",
      comment: "版本判断错误",
    });
    expect(parseFeedbackCommand("/q 3")).toEqual({
      classification: "missing",
      comment: "",
    });
    expect(parseFeedbackCommand("/q #12 4 请帮我核对正式文档"))
      .toEqual({
        questionId: 12,
        classification: "review_requested",
        comment: "请帮我核对正式文档",
      });
    expect(parseFeedbackCommand("/q 4")).toEqual({
      classification: "review_requested",
      comment: "",
    });

    const malformed = normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: "invalid-feedback",
        sourceId: "#peer#U",
        from: { uid: "#peer#U" },
        subject: "/feedback #2 evidence",
      },
    }, "#bot#U");
    expect(malformed).toMatchObject({ command: "feedback" });
    expect(malformed).not.toHaveProperty("feedback");
  });

  it.each([
    "/feedback #0 useful",
    "/feedback #999999999999999999999 useful",
    `/feedback #1 incorrect ${"x".repeat(4_001)}`,
    "/q 0",
    "/q #0 1",
    `/q 2 ${"x".repeat(4_001)}`,
  ])("rejects unsafe feedback payload %j", (text) => {
    expect(parseFeedbackCommand(text)).toBeUndefined();
  });

  it("normalizes the visible Lunkr chat name without exposing control text", () => {
    expect(normalizeDirectMessage({
      topic: "inbox",
      payload: {
        msgId: "named-message",
        sourceId: "#peer#U",
        from: { uid: "#peer#U", displayName: "  Wayne\u0000  黎政良  " },
        to: { uid: "#bot#U" },
        subject: "测试问题",
      },
    }, "#bot#U")).toMatchObject({
      userDisplayName: "Wayne 黎政良",
    });
  });

  it.each(["/new 请继续", "前缀/new", "/newer", "```/new```", "/feedbacker", "/query"])(
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
