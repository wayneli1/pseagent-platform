import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
  PSE_MODEL_BASE_URL: "https://model.example/v1",
  PSE_MODEL_API_KEY: "secret",
  PSE_MODEL_NAME: "model",
  PSE_MODEL_TIMEOUT_MS: "60000",
  KNOWLEDGE_MCP_COMMAND: "node",
  KNOWLEDGE_MCP_ENTRY_PATH: "C:\\app\\server.js",
};

describe("loadConfig", () => {
  it("selects exactly one model and an absolute formal MCP entry", () => {
    const config = loadConfig({
      ...baseEnv,
      JUDGE_MODEL_NAME: "forbidden",
    });
    expect(config.PSE_MODEL_NAME).toBe("model");
    expect(config).not.toHaveProperty("JUDGE_MODEL_NAME");
  });

  it("keeps Coremail historical fallback disabled by default", () => {
    expect(loadConfig(baseEnv).coremailMcp).toEqual({ enabled: false });
    expect(loadConfig({
      ...baseEnv,
      COREMAIL_MCP_ENABLED: "false",
    }).coremailMcp).toEqual({ enabled: false });
  });

  it("loads the enabled read-only Coremail MCP configuration", () => {
    expect(loadConfig({
      ...baseEnv,
      COREMAIL_MCP_ENABLED: "true",
      COREMAIL_MCP_COMMAND: "node",
      COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
      COREMAIL_MCP_TIMEOUT_MS: "30000",
    }).coremailMcp).toEqual({
      enabled: true,
      command: "node",
      entryPath: "C:\\runtime\\dist\\server.js",
      timeoutMs: 30000,
    });
  });

  it.each([
    "C:\\runtime\\dist\\import-browser.js",
    "C:\\runtime\\scripts\\login-browser.js",
    "C:\\runtime\\dist\\writeback.js",
  ])("rejects a Coremail entry that is not dist/server.js: %s", (entryPath) => {
    expect(() => loadConfig({
      ...baseEnv,
      COREMAIL_MCP_ENABLED: "true",
      COREMAIL_MCP_COMMAND: "node",
      COREMAIL_MCP_ENTRY_PATH: entryPath,
    })).toThrow();
  });

  it.each(["0", "no", "FALSE", ""])(
    "rejects ambiguous COREMAIL_MCP_ENABLED value %j",
    (enabled) => {
      expect(() => loadConfig({
        ...baseEnv,
        COREMAIL_MCP_ENABLED: enabled,
      })).toThrow();
    },
  );

  it.each(["999", "120001"])(
    "rejects Coremail timeout outside the safe range: %s",
    (timeoutMs) => {
      expect(() => loadConfig({
        ...baseEnv,
        COREMAIL_MCP_ENABLED: "true",
        COREMAIL_MCP_COMMAND: "node",
        COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
        COREMAIL_MCP_TIMEOUT_MS: timeoutMs,
      })).toThrow();
    },
  );

  it.each([
    {},
    {
      COREMAIL_MCP_COMMAND: " ",
      COREMAIL_MCP_ENTRY_PATH: "C:\\runtime\\dist\\server.js",
    },
    {
      COREMAIL_MCP_COMMAND: "node",
      COREMAIL_MCP_ENTRY_PATH: "dist\\server.js",
    },
  ])("rejects incomplete enabled Coremail configuration", (coremailEnv) => {
    expect(() => loadConfig({
      ...baseEnv,
      COREMAIL_MCP_ENABLED: "true",
      ...coremailEnv,
    })).toThrow();
  });
});
