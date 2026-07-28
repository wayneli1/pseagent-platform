import { createHash } from "node:crypto";
import type { DirectCommand, LunkrDirectMessage } from "./contracts.js";

const INVISIBLE_COMMAND_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/gu;

export function normalizeDirectMessage(
  event: unknown,
  selfUid: string,
  now = Date.now(),
): LunkrDirectMessage | undefined {
  const envelope = asRecord(event);
  if (envelope === undefined) return undefined;
  const topic = typeof envelope.topic === "string" ? envelope.topic : "";
  if (topic !== "" && topic !== "inbox" && !topic.includes("/cim/")) {
    return undefined;
  }
  const payload = parsePayload(envelope.payload);
  if (payload === undefined) return undefined;
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
  const hasAttachments = detectsAttachments(payload);
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

function detectsAttachments(payload: Record<string, unknown>): boolean {
  for (const key of ["attachments", "files", "fileInfo", "attachment"]) {
    const value = payload[key];
    if (Array.isArray(value) && value.length > 0) return true;
    if (value !== null && typeof value === "object") return true;
  }
  const type = firstString(payload, ["contentType", "content_type", "msgType"]);
  return type !== undefined && !/^(?:text|plain|message)$/i.test(type);
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
