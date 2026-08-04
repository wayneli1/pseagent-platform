import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(config.PSE_MODEL_MAX_TOKENS).toBe(8_192);
    expect(config.PSE_REQUEST_TIMEOUT_MS).toBe(300_000);
    expect(config.PSE_ACTIVE_DEADLINE_MS).toBe(270_000);
    expect(config.taskSpecShadow).toEqual({ enabled: false });
    expect(config.taskSpecActiveEnabled).toBe(false);
    expect(config.multiDomainActiveEnabled).toBe(false);
    expect(config).not.toHaveProperty("JUDGE_MODEL_NAME");
  });

  it("loads a bounded opt-in TaskSpec shadow configuration", () => {
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
    }).taskSpecShadow).toEqual({
      enabled: true,
      timeoutMs: 15_000,
    });
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_SHADOW_TIMEOUT_MS: "30000",
    }).taskSpecShadow).toEqual({
      enabled: true,
      timeoutMs: 30_000,
    });
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_SHADOW_TIMEOUT_MS: "999",
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "yes",
    })).toThrow();
  });

  it("requires TaskSpec shadow analysis before active plan replacement", () => {
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
    }).taskSpecActiveEnabled).toBe(true);
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
    })).toThrow("PSE_TASK_SPEC_ACTIVE_ENABLED requires PSE_TASK_SPEC_SHADOW_ENABLED=true");
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_ACTIVE_ENABLED: "yes",
    })).toThrow();
  });

  it("enables multi-domain execution only after both TaskSpec prerequisites", () => {
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
    }).multiDomainActiveEnabled).toBe(true);

    expect(() => loadConfig({
      ...baseEnv,
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
    })).toThrow(
      "PSE_MULTI_DOMAIN_ACTIVE_ENABLED requires PSE_TASK_SPEC_SHADOW_ENABLED=true and PSE_TASK_SPEC_ACTIVE_ENABLED=true",
    );
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
    })).toThrow(
      "PSE_MULTI_DOMAIN_ACTIVE_ENABLED requires PSE_TASK_SPEC_SHADOW_ENABLED=true and PSE_TASK_SPEC_ACTIVE_ENABLED=true",
    );
  });

  it("rejects an invalid multi-domain feature flag instead of silently enabling it", () => {
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "yes",
    })).toThrow();
  });

  it("loads bounded request and active deadline budgets", () => {
    const config = loadConfig({
      ...baseEnv,
      PSE_REQUEST_TIMEOUT_MS: "570000",
      PSE_ACTIVE_DEADLINE_MS: "540000",
    });
    expect(config.PSE_REQUEST_TIMEOUT_MS).toBe(570_000);
    expect(config.PSE_ACTIVE_DEADLINE_MS).toBe(540_000);
    expect(() => loadConfig({
      ...baseEnv,
      PSE_REQUEST_TIMEOUT_MS: "29999",
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      PSE_ACTIVE_DEADLINE_MS: "1800001",
    })).toThrow();
  });

  it("requires the active deadline to precede the request timeout", () => {
    expect(() => loadConfig({
      ...baseEnv,
      PSE_REQUEST_TIMEOUT_MS: "540000",
      PSE_ACTIVE_DEADLINE_MS: "540000",
    })).toThrow("PSE_ACTIVE_DEADLINE_MS must be less than PSE_REQUEST_TIMEOUT_MS");
  });

  it("accepts a bounded model output token budget", () => {
    expect(loadConfig({
      ...baseEnv,
      PSE_MODEL_MAX_TOKENS: "16384",
    }).PSE_MODEL_MAX_TOKENS).toBe(16_384);
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MODEL_MAX_TOKENS: "1023",
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MODEL_MAX_TOKENS: "32769",
    })).toThrow();
  });

  it("keeps Coremail historical fallback disabled by default", () => {
    expect(loadConfig(baseEnv).coremailMcp).toEqual({ enabled: false });
    expect(loadConfig({
      ...baseEnv,
      COREMAIL_MCP_ENABLED: "false",
    }).coremailMcp).toEqual({ enabled: false });
  });

  it("keeps diagnostics disabled by default and restricts enabled logs to the temp tree", () => {
    expect(loadConfig(baseEnv).diagnostics).toEqual({ enabled: false });
    const directory = join(tmpdir(), "pseagent-diagnostics-custom");
    expect(loadConfig({
      ...baseEnv,
      PSE_DIAGNOSTICS_ENABLED: "true",
      PSE_DIAGNOSTICS_DIR: directory,
    }).diagnostics).toEqual({
      enabled: true,
      directory,
    });
    expect(() => loadConfig({
      ...baseEnv,
      PSE_DIAGNOSTICS_ENABLED: "true",
      PSE_DIAGNOSTICS_DIR: "C:\\pseagent-production-logs",
    })).toThrow("system temporary directory");
  });

  it.each(["1", "yes", "TRUE", ""])(
    "rejects ambiguous PSE_DIAGNOSTICS_ENABLED value %j",
    (enabled) => {
      expect(() => loadConfig({
        ...baseEnv,
        PSE_DIAGNOSTICS_ENABLED: enabled,
      })).toThrow();
    },
  );

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
