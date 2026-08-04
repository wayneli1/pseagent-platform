import { homedir } from "node:os";
import { join } from "node:path";

export interface LunkrDirectConfig {
  readonly baseUrl: string;
  readonly apiPath: string;
  readonly sessionPath: string;
  readonly passwordPath: string;
  readonly connectTimeoutMs: number;
  readonly reconnectMaxMs: number;
  readonly messageDedupeTtlMs: number;
  readonly messageDedupeMax: number;
  readonly contextMaxTurns: number;
  readonly contextMaxChars: number;
  readonly messageMaxChars: number;
  readonly questionBudgetMs: number;
  readonly maxActivePeers: number;
  readonly maxPendingPerPeer: number;
  readonly sessionIdleMs: number;
  readonly feedbackReceiptTtlMs: number;
  readonly feedbackReceiptMax: number;
}

export function loadLunkrConfig(
  env: NodeJS.ProcessEnv = process.env,
): LunkrDirectConfig {
  const baseUrl = (env.LUNKR_BASE_URL ?? "https://lunkr.coremail.cn").replace(/\/+$/, "");
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:") {
    throw new Error("LUNKR_BASE_URL 必须使用 HTTPS");
  }
  const apiPath = env.LUNKR_API_PATH?.trim() || "/lunkr/s/json";
  if (!apiPath.startsWith("/")) {
    throw new Error("LUNKR_API_PATH 必须以 / 开头");
  }
  return {
    baseUrl,
    apiPath,
    sessionPath:
      env.LUNKR_SESSION_PATH?.trim() ||
      join(homedir(), ".config", "pseagent-lunkr", "session.json"),
    passwordPath:
      env.LUNKR_PASSWORD_PATH?.trim() ||
      join(homedir(), ".config", "pseagent-lunkr", "password.dpapi.json"),
    connectTimeoutMs: positiveInteger(env, "LUNKR_CONNECT_TIMEOUT_MS", 30_000),
    reconnectMaxMs: positiveInteger(env, "LUNKR_RECONNECT_MAX_MS", 30_000),
    messageDedupeTtlMs: positiveInteger(env, "LUNKR_MESSAGE_DEDUPE_TTL_MS", 600_000),
    messageDedupeMax: positiveInteger(env, "LUNKR_MESSAGE_DEDUPE_MAX", 2_000),
    contextMaxTurns: positiveInteger(env, "LUNKR_CONTEXT_MAX_TURNS", 6),
    contextMaxChars: positiveInteger(env, "LUNKR_CONTEXT_MAX_CHARS", 12_000),
    messageMaxChars: positiveInteger(env, "LUNKR_MESSAGE_MAX_CHARS", 1_000),
    questionBudgetMs: boundedInteger(
      env,
      "LUNKR_QUESTION_BUDGET_MS",
      300_000,
      30_000,
      1_800_000,
    ),
    maxActivePeers: positiveInteger(env, "LUNKR_MAX_ACTIVE_PEERS", 4),
    maxPendingPerPeer: positiveInteger(env, "LUNKR_MAX_PENDING_PER_PEER", 5),
    sessionIdleMs: positiveInteger(env, "LUNKR_SESSION_IDLE_MS", 86_400_000),
    feedbackReceiptTtlMs: boundedInteger(
      env,
      "LUNKR_FEEDBACK_RECEIPT_TTL_MS",
      30 * 60_000,
      60_000,
      24 * 60 * 60_000,
    ),
    feedbackReceiptMax: boundedInteger(
      env,
      "LUNKR_FEEDBACK_RECEIPT_MAX",
      2_000,
      1,
      100_000,
    ),
  };
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = positiveInteger(env, name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} 必须介于 ${minimum} 和 ${maximum} 之间`);
  }
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}
