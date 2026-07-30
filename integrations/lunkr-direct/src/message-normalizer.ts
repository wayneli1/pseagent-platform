import type { DirectCommand, LunkrDirectMessage } from "./contracts.js";

const INVISIBLE_COMMAND_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;
const ATTACHMENT_MESSAGE_TYPE =
  /^(?:(?:image|audio|video|application)\/[a-z0-9.+-]+|image|img|file|voice|audio|video|attachment)(?:$|[/:_.-])/iu;
const CONTROL_MESSAGE_TYPE =
  /^(?:read|read[_-]?receipt|receipt|seen|ack|typing(?:[_-](?:start|stop))?|presence(?:[_-]?update)?|delivered|delivery[_-]?receipt|open|chat[_-]?open|window[_-]?open|focus|blur|status|system|notice|notification|event|sync)$/iu;
const ATTACHMENT_DETAIL_KEY =
  /^(?:id|file[_-]?id|attachment[_-]?id|name|file[_-]?name|filename|url|download[_-]?url|path|size|file[_-]?size|content[_-]?type|mime[_-]?type)$/iu;

export function normalizeDirectMessage(
  event: unknown,
  selfUid: string,
  now = Date.now(),
): LunkrDirectMessage | undefined {
  const envelope = asRecord(event);
  if (envelope === undefined) return undefined;
  const payload = parsePayload(envelope.payload);
  if (payload === undefined) return undefined;
  const id = firstString(
    payload,
    ["msgId", "messageId", "mid", "clientMid", "id"],
  );
  if (id === undefined) return undefined;
  const messageType = firstString(
    payload,
    ["contentType", "content_type", "msgType", "eventType"],
  );
  if (messageType !== undefined && CONTROL_MESSAGE_TYPE.test(messageType.trim())) {
    return undefined;
  }
  const sourceUid = firstString(payload, ["sourceId", "source_id", "uid"]);
  const from = asRecord(payload.from);
  const senderUid =
    firstString(from, ["uid", "id"]) ??
    (typeof payload.from === "string" && payload.from.endsWith("#U")
      ? payload.from
      : undefined);
  if (senderUid === undefined || senderUid === selfUid) return undefined;
  if (sourceUid !== undefined && !sourceUid.endsWith("#U")) return undefined;
  const peerUid =
    sourceUid?.endsWith("#U") === true
      ? sourceUid
      : senderUid.endsWith("#U")
        ? senderUid
        : undefined;
  if (peerUid === undefined) return undefined;
  const to = asRecord(payload.to);
  const destinationUid = firstString(to, ["uid", "id"]);
  if (
    destinationUid !== undefined &&
    destinationUid !== selfUid
  ) {
    return undefined;
  }
  const subject = firstString(payload, ["subject"]);
  const text = subject === undefined
    ? firstString(payload, ["content", "text", "body"]) ?? ""
    : decodeLunkrSubject(subject);
  const hasAttachments = detectsAttachments(payload, messageType);
  if (text.trim() === "" && !hasAttachments) return undefined;
  const timestamp = parseTimestamp(payload.time ?? payload.timestamp, now);
  const command = recognizeDirectCommand(text);
  return {
    id,
    peerUid,
    senderUid,
    timestamp,
    text: text.trim(),
    hasAttachments,
    ...(command === undefined ? {} : { command }),
  };
}

export function recognizeDirectCommand(text: string): DirectCommand | undefined {
  const normalized = text
    .normalize("NFKC")
    .replace(INVISIBLE_COMMAND_CHARACTERS, "")
    .trim();
  if (normalized === "/new") return "new";
  if (normalized === "/help") return "help";
  return undefined;
}

function decodeLunkrSubject(subject: string): string {
  try {
    return decodeURIComponent(subject.replace(/\+/gu, " "));
  } catch {
    return subject;
  }
}

function parsePayload(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function detectsAttachments(
  payload: Record<string, unknown>,
  messageType: string | undefined,
): boolean {
  for (const key of ["attachments", "files", "fileInfo", "attachment"]) {
    if (hasConcreteAttachment(payload[key])) return true;
  }
  if (messageType === undefined) return false;
  return ATTACHMENT_MESSAGE_TYPE.test(messageType.trim());
}

function hasConcreteAttachment(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasConcreteAttachment(item));
  }
  if (typeof value === "string") return value.trim() !== "";
  if (value === true) return true;
  const record = asRecord(value);
  if (record === undefined) return false;
  for (const [key, detail] of Object.entries(record)) {
    if (ATTACHMENT_DETAIL_KEY.test(key) && hasAttachmentDetailValue(detail)) {
      return true;
    }
    if (
      detail !== null &&
      typeof detail === "object" &&
      hasConcreteAttachment(detail)
    ) {
      return true;
    }
  }
  return false;
}

function hasAttachmentDetailValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  return value === true;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value === "string" && value !== "") {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? value.replace(" ", "T")
      : value;
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function firstString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}
