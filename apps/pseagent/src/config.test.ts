import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("selects exactly one model and an absolute MCP entry", () => {
    const config = loadConfig({
      PSE_MODEL_BASE_URL: "https://model.example/v1",
      PSE_MODEL_API_KEY: "secret",
      PSE_MODEL_NAME: "model",
      PSE_MODEL_TIMEOUT_MS: "60000",
      KNOWLEDGE_MCP_COMMAND: "node",
      KNOWLEDGE_MCP_ENTRY_PATH: "C:\\app\\server.js",
      JUDGE_MODEL_NAME: "forbidden",
    });
    expect(config.PSE_MODEL_NAME).toBe("model");
    expect(config).not.toHaveProperty("JUDGE_MODEL_NAME");
  });
});
