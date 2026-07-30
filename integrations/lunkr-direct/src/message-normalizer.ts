import { createHash } from "node:crypto";
import type { DirectCommand, LunkrDirectMessage } from "./contracts.js";

const INVISIBLE_COMMAND_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;
const TEXT_MESSAGE_TYPE = /^(?:text(?:\/plain)?|plain|message)$/iu;
const ATTACHMENT_MESSAGE_TYPE =
  /^(?:(?:image|audio|video|application)\/|image|img|file|voice|audio|video|attachment|card|richtext|html)(?:$|[/:_.-])/iu;
const CONTROL_MESSAGE_TYPE =
  /^(?:read|read[_-]?receipt|receipt|seen|ack|typing(?:[_-](?:start|stop))?|presence(?:[_-]?update)?|delivered|delivery[_-]?receipt|open|chat[_-]?open|window[_-]?open|focus|blur|status|system|notice|notification|event|sync)$/iu;

export function normalizeDirectMessage(
  event: unknown,
  selfUid: string,
  now = Date.now(),
): LunkrDirectMessage | undefined {
  const envelope = asRecord(event);
  if (envelope === undefined) return undefined;
  const topic = typeof envelope.topic === "string" ? envelope.topic : "";
  if (!isDirectMessageTopic(topic)) return undefined;
  const payload = parsePayload(envelope.payload);
  if (payload === undefined) return undefined;
  const messageType = firstString(
    payload,
    ["contentType", "content_type", "msgType", "eventType"],
  );
  if (messageType !== undefined && CONTROL_MESSAGE_TYPE.test(messageType.trim())) {
    return undefined;
  }
  if (
    messageType !== undefined &&
    !TEXT_MESSAGE_TYPE.test(messageType.trim()) &&
    !ATTACHMENT_MESSAGE_TYPE.test(messageType.trim())
  ) {
    return undefined;
  }
  const sourceUid = firstString(payload, ["sourceId", "source_id", "uid"]);
  const from = asRecord(payload.from);
  const senderUid =
    firstString(from, ["uid", "id"]) ??
    (typeof payload.from === "string" && payload.from.endsWith("#U")
      ? payload.from
      : undefined) ??
    sourceUid;
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
    destinationUid !== selfUid &&
    !destinationUid.endsWith("#U")
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
  const id =
    firstString(payload, ["msgId", "messageId", "mid", "clientMid", "id"]) ??
    createHash("sha256")
      .update(`${peerUid}:${timestamp}:${text}:${JSON.stringify(payload)}`)
      .digest("hex");
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

function isDirectMessageTopic(topic: string): boolean {
  return topic === "" ||
    topic === "inbox" ||
    /^\/cim\/message\/?$/iu.test(topic);
}

function detectsAttachments(
  payload: Record<string, unknown>,
  messageType: string | undefined,
): boolean {
  for (const key of ["attachments", "files", "fileInfo", "attachment"]) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 0) return true;
    if (
      value !== null &&
      typeof value === "object" &&
      Object.keys(value).length > 0
    ) {
      return true;
    }
    if (typeof value === "string" && value.trim() !== "") return true;
    if (value === true) return true;
  }
  if (messageType === undefined) return false;
  const normalizedType = messageType.trim();
  if (TEXT_MESSAGE_TYPE.test(normalizedType)) return false;
  return ATTACHMENT_MESSAGE_TYPE.test(normalizedType);
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
