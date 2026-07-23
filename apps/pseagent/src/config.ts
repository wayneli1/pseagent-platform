import path from "node:path";
import { z } from "zod";

const baseEnvSchema = z.object({
  PSE_MODEL_BASE_URL: z.string().url(),
  PSE_MODEL_API_KEY: z.string().trim().min(1),
  PSE_MODEL_NAME: z.string().trim().min(1),
  PSE_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),
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
};

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = baseEnvSchema.parse({
    PSE_MODEL_BASE_URL: env.PSE_MODEL_BASE_URL,
    PSE_MODEL_API_KEY: env.PSE_MODEL_API_KEY,
    PSE_MODEL_NAME: env.PSE_MODEL_NAME,
    PSE_MODEL_TIMEOUT_MS: env.PSE_MODEL_TIMEOUT_MS,
    KNOWLEDGE_MCP_COMMAND: env.KNOWLEDGE_MCP_COMMAND,
    KNOWLEDGE_MCP_ENTRY_PATH: env.KNOWLEDGE_MCP_ENTRY_PATH,
  });
  if (!/^[A-Za-z]:[\\/]/u.test(parsed.KNOWLEDGE_MCP_ENTRY_PATH)) {
    throw new Error("KNOWLEDGE_MCP_ENTRY_PATH must be absolute.");
  }

  const enabled = z.enum(["true", "false"]).parse(
    env.COREMAIL_MCP_ENABLED ?? "false",
  );
  if (enabled === "false") {
    return { ...parsed, coremailMcp: { enabled: false } };
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
  };
}
