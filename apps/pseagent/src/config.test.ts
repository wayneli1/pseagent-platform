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
    expect(config.PSE_MODEL_MAX_CONCURRENCY).toBe(4);
    expect(config.PSE_MODEL_MAX_QUEUE).toBe(32);
    expect(config.PSE_MODEL_QUEUE_TIMEOUT_MS).toBe(60_000);
    expect(config.PSE_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(config.PSE_ACTIVE_DEADLINE_MS).toBe(165_000);
    expect(config.taskSpecShadow).toEqual({ enabled: false });
    expect(config.taskSpecActiveEnabled).toBe(false);
    expect(config.multiDomainActiveEnabled).toBe(false);
    expect(config.reliabilityControlPlaneEnabled).toBe(false);
    expect(config.qualifiedCache).toEqual({ enabled: false });
    expect(config.answerCards).toEqual({
      enabled: false,
      required: false,
      exactActiveEnabled: false,
      familyActiveEnabled: false,
    });
    expect(config).not.toHaveProperty("JUDGE_MODEL_NAME");
  });

  it("derives independent model-role names and provider JSON capability", () => {
    const shared = loadConfig(baseEnv);
    expect(shared.modelRoles).toEqual({
      resolver: "model",
      planner: "model",
      synthesizer: "model",
      verifier: "model",
      consensusVerifier: "model",
    });
    expect(shared.modelCapabilities).toEqual({ jsonResponseFormat: true });

    const split = loadConfig({
      ...baseEnv,
      PSE_RESOLVER_MODEL_NAME: "resolver-model",
      PSE_PLANNER_MODEL_NAME: "planner-model",
      PSE_SYNTHESIZER_MODEL_NAME: "synth-model",
      PSE_VERIFIER_MODEL_NAME: "verifier-model",
      PSE_CONSENSUS_VERIFIER_MODEL_NAME: "consensus-model",
      PSE_MODEL_JSON_RESPONSE_FORMAT: "false",
    });
    expect(split.modelRoles).toEqual({
      resolver: "resolver-model",
      planner: "planner-model",
      synthesizer: "synth-model",
      verifier: "verifier-model",
      consensusVerifier: "consensus-model",
    });
    expect(split.modelCapabilities).toEqual({ jsonResponseFormat: false });
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MODEL_JSON_RESPONSE_FORMAT: "auto",
    })).toThrow();
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
    const active = loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
    });
    expect(active.taskSpecActiveEnabled).toBe(true);
    expect(active.taskSpecShadow).toEqual({ enabled: true, timeoutMs: 60_000 });
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

  it("enables the reliable control plane only on the active multi-domain path", () => {
    const config = loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
    });
    expect(config.reliabilityControlPlaneEnabled).toBe(true);
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
    }).reliabilityControlPlaneEnabled).toBe(true);
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "false",
    }).reliabilityControlPlaneEnabled).toBe(false);
    expect(() => loadConfig({
      ...baseEnv,
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
    })).toThrow(
      "PSE_RELIABILITY_CONTROL_PLANE_ENABLED requires active TaskSpec and multi-domain execution",
    );
  });

  it("requires a reliable control plane, absolute directory, and release for qualified cache", () => {
    const enabled = loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_DIRECTORY: "C:\\cache\\qualified",
      PSE_RELEASE_ID: "release-20260812",
    });
    expect(enabled.qualifiedCache).toEqual({
      enabled: true,
      directory: "C:\\cache\\qualified",
      releaseId: "release-20260812",
    });
    expect(() => loadConfig({
      ...baseEnv,
      PSE_QUALIFIED_CACHE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_DIRECTORY: "C:\\cache\\qualified",
      PSE_RELEASE_ID: "release-20260812",
    })).toThrow("requires PSE_RELIABILITY_CONTROL_PLANE_ENABLED=true");
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_ENABLED: "true",
      PSE_QUALIFIED_CACHE_DIRECTORY: "relative/cache",
      PSE_RELEASE_ID: "release-20260812",
    })).toThrow("must be absolute");
  });

  it("rejects an invalid multi-domain feature flag instead of silently enabling it", () => {
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "yes",
    })).toThrow();
  });

  it("loads answer-card shadow and gates exact and family activation in order", () => {
    const catalogPath = "C:\\pseagent\\answer-card-catalog.json";
    expect(loadConfig({
      ...baseEnv,
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    }).answerCards).toEqual({
      enabled: true,
      required: false,
      catalogPath,
      exactActiveEnabled: false,
      familyActiveEnabled: false,
    });
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_EXACT_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    }).answerCards).toMatchObject({ exactActiveEnabled: true });
    expect(() => loadConfig({
      ...baseEnv,
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_EXACT_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    })).toThrow("requires answer-card shadow and active TaskSpec");
    expect(() => loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_EXACT_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_FAMILY_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    })).toThrow("requires exact activation and active multi-domain execution");
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_MULTI_DOMAIN_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_EXACT_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_FAMILY_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    }).answerCards).toMatchObject({ familyActiveEnabled: true });
  });

  it("accepts only an absolute answer-card snapshot directory",()=>{
    const catalogPath="C:\\pseagent\\answer-card-catalog.json";
    const snapshotRoot="C:\\pseagent\\knowledge-ops\\snapshots";
    expect(loadConfig({...baseEnv,PSE_ANSWER_CARD_SHADOW_ENABLED:"true",PSE_ANSWER_CARD_CATALOG_PATH:catalogPath,PSE_ANSWER_CARD_SNAPSHOT_ROOT:snapshotRoot}).answerCards)
      .toMatchObject({snapshotRoot});
    expect(()=>loadConfig({...baseEnv,PSE_ANSWER_CARD_SHADOW_ENABLED:"true",PSE_ANSWER_CARD_CATALOG_PATH:catalogPath,PSE_ANSWER_CARD_SNAPSHOT_ROOT:"relative/snapshots"}))
      .toThrow("PSE_ANSWER_CARD_SNAPSHOT_ROOT must be an absolute directory");
    expect(loadConfig({...baseEnv,PSE_ANSWER_CARD_SHADOW_ENABLED:"true",PSE_ANSWER_CARD_CATALOG_PATH:catalogPath,KNOWLEDGE_OPS_SNAPSHOT_ROOT:snapshotRoot}).answerCards)
      .toMatchObject({snapshotRoot});
  });

  it("fails startup configuration when governed answer cards are required but not active", () => {
    const catalogPath = "C:\\pseagent\\answer-card-catalog.json";
    expect(() => loadConfig({
      ...baseEnv,
      PSE_ANSWER_CARD_REQUIRED: "true",
    })).toThrow("requires answer-card shadow and exact activation");
    expect(() => loadConfig({
      ...baseEnv,
      PSE_ANSWER_CARD_REQUIRED: "true",
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    })).toThrow("requires answer-card shadow and exact activation");
    expect(loadConfig({
      ...baseEnv,
      PSE_TASK_SPEC_SHADOW_ENABLED: "true",
      PSE_TASK_SPEC_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_REQUIRED: "true",
      PSE_ANSWER_CARD_SHADOW_ENABLED: "true",
      PSE_ANSWER_CARD_EXACT_ACTIVE_ENABLED: "true",
      PSE_ANSWER_CARD_CATALOG_PATH: catalogPath,
    }).answerCards).toMatchObject({
      enabled: true,
      required: true,
      exactActiveEnabled: true,
    });
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

  it("loads bounded model admission controls", () => {
    const config = loadConfig({
      ...baseEnv,
      PSE_MODEL_MAX_CONCURRENCY: "4",
      PSE_MODEL_MAX_QUEUE: "40",
      PSE_MODEL_QUEUE_TIMEOUT_MS: "12000",
    });
    expect(config.PSE_MODEL_MAX_CONCURRENCY).toBe(4);
    expect(config.PSE_MODEL_MAX_QUEUE).toBe(40);
    expect(config.PSE_MODEL_QUEUE_TIMEOUT_MS).toBe(12_000);
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MODEL_MAX_CONCURRENCY: "0",
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MODEL_MAX_QUEUE: "1025",
    })).toThrow();
    expect(() => loadConfig({
      ...baseEnv,
      PSE_MODEL_QUEUE_TIMEOUT_MS: "180001",
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
