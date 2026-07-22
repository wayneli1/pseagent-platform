import { z } from "zod";

const envSchema = z.object({
  PSE_MODEL_BASE_URL: z.string().url(),
  PSE_MODEL_API_KEY: z.string().trim().min(1),
  PSE_MODEL_NAME: z.string().trim().min(1),
  PSE_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(180_000).default(60_000),
  KNOWLEDGE_MCP_COMMAND: z.string().trim().min(1),
  KNOWLEDGE_MCP_ENTRY_PATH: z.string().trim().min(1),
}).strict();
export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse({
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
  return parsed;
}
