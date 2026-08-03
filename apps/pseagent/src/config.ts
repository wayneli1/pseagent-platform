import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const baseEnvSchema = z.object({
  PSE_MODEL_BASE_URL: z.string().url(),
  PSE_MODEL_API_KEY: z.string().trim().min(1),
  PSE_MODEL_NAME: z.string().trim().min(1),
  PSE_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),
  PSE_MODEL_MAX_TOKENS: z.coerce.number().int().min(1_024).max(32_768).default(8_192),
  PSE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(300_000),
  PSE_ACTIVE_DEADLINE_MS: z.coerce.number().int().min(30_000).max(1_800_000).default(270_000),
  KNOWLEDGE_MCP_COMMAND: z.string().trim().min(1),
  KNOWLEDGE_MCP_ENTRY_PATH: z.string().trim().min(1),
}).strict();

const enabledCoremailMcpSchema = z.object({
  command: z.string().trim().min(1),
  entryPath: z.string().trim().min(1),
  timeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
}).strict();

type BaseConfig = z.infer<typeof baseEnvSchema>;
export type CoremailMcpConfig =
  | { readonly enabled: false }
  | {
    readonly enabled: true;
    readonly command: string;
    readonly entryPath: string;
    readonly timeoutMs: number;
  };
export type AppConfig = BaseConfig & {
  readonly coremailMcp: CoremailMcpConfig;
  readonly diagnostics:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly directory: string };
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = baseEnvSchema.parse({
    PSE_MODEL_BASE_URL: env.PSE_MODEL_BASE_URL,
    PSE_MODEL_API_KEY: env.PSE_MODEL_API_KEY,
    PSE_MODEL_NAME: env.PSE_MODEL_NAME,
    PSE_MODEL_TIMEOUT_MS: env.PSE_MODEL_TIMEOUT_MS,
    PSE_MODEL_MAX_TOKENS: env.PSE_MODEL_MAX_TOKENS,
    PSE_REQUEST_TIMEOUT_MS: env.PSE_REQUEST_TIMEOUT_MS,
    PSE_ACTIVE_DEADLINE_MS: env.PSE_ACTIVE_DEADLINE_MS,
    KNOWLEDGE_MCP_COMMAND: env.KNOWLEDGE_MCP_COMMAND,
    KNOWLEDGE_MCP_ENTRY_PATH: env.KNOWLEDGE_MCP_ENTRY_PATH,
  });
  if (!/^[A-Za-z]:[\\/]/u.test(parsed.KNOWLEDGE_MCP_ENTRY_PATH)) {
    throw new Error("KNOWLEDGE_MCP_ENTRY_PATH must be absolute.");
  }
  if (parsed.PSE_ACTIVE_DEADLINE_MS >= parsed.PSE_REQUEST_TIMEOUT_MS) {
    throw new Error("PSE_ACTIVE_DEADLINE_MS must be less than PSE_REQUEST_TIMEOUT_MS.");
  }

  const enabled = z.enum(["true", "false"]).parse(
    env.COREMAIL_MCP_ENABLED ?? "false",
  );
  const diagnostics = loadDiagnosticsConfig(env);
  if (enabled === "false") {
    return { ...parsed, coremailMcp: { enabled: false }, diagnostics };
  }

  const coremail = enabledCoremailMcpSchema.parse({
    command: env.COREMAIL_MCP_COMMAND,
    entryPath: env.COREMAIL_MCP_ENTRY_PATH,
    timeoutMs: env.COREMAIL_MCP_TIMEOUT_MS,
  });
  const normalizedEntry = path.normalize(coremail.entryPath);
  if (
    !path.isAbsolute(normalizedEntry) ||
    path.basename(normalizedEntry).toLowerCase() !== "server.js" ||
    path.basename(path.dirname(normalizedEntry)).toLowerCase() !== "dist"
  ) {
    throw new Error("COREMAIL_MCP_ENTRY_PATH must be an absolute dist/server.js path.");
  }
  return {
    ...parsed,
    coremailMcp: {
      enabled: true,
      command: coremail.command,
      entryPath: normalizedEntry,
      timeoutMs: coremail.timeoutMs,
    },
    diagnostics,
  };
}

function loadDiagnosticsConfig(env: NodeJS.ProcessEnv): AppConfig["diagnostics"] {
  const enabled = z.enum(["true", "false"]).parse(
    env.PSE_DIAGNOSTICS_ENABLED ?? "false",
  );
  if (enabled === "false") return { enabled: false };
  const temporaryRoot = path.resolve(tmpdir());
  const directory = path.resolve(
    env.PSE_DIAGNOSTICS_DIR?.trim() || path.join(temporaryRoot, "pseagent-diagnostics"),
  );
  const relative = path.relative(temporaryRoot, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PSE_DIAGNOSTICS_DIR must be a subdirectory of the system temporary directory.");
  }
  return { enabled: true, directory };
}
