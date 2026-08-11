import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseBlindAcceptanceDataset,
  validateBlindAcceptanceRun,
  type BlindAcceptanceObservation,
} from "./blind-acceptance-contract.js";
import {
  requirePinnedKnowledgeRevisions,
  validateColdRunEnvironment,
} from "./blind-run-contract.js";

describe("cold blind acceptance contract", () => {
  it("rejects cold acceptance when qualified cache is enabled", () => {
    expect(() => validateColdRunEnvironment(validEnvironment({
      PSE_QUALIFIED_CACHE_ENABLED: "true",
    }))).toThrow("blind_acceptance_requires_cache_disabled");
  });

  it("rejects a disabled deterministic reliability control plane", () => {
    expect(() => validateColdRunEnvironment(validEnvironment({
      PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "false",
    }))).toThrow("blind_acceptance_requires_reliability_control_plane");
  });

  it("rejects external write configuration", () => {
    expect(() => validateColdRunEnvironment(validEnvironment({
      KNOWLEDGE_OPS_FEEDBACK_URL: "http://127.0.0.1:19830",
    }))).toThrow("blind_acceptance_external_writes_must_be_disabled");
  });

  it("pins every model role including the independent consensus verifier", () => {
    expect(() => validateColdRunEnvironment(validEnvironment({
      PSE_CONSENSUS_VERIFIER_MODEL_NAME: "another-model",
    }))).toThrow("blind_acceptance_requires_deepseek_v4_flash");
  });

  it("returns an immutable cold identity fragment", () => {
    expect(validateColdRunEnvironment(validEnvironment())).toEqual({
      cacheMode: "cold_disabled",
      releaseId: "release-20260812-fourth",
    });
  });

  it("requires both pinned knowledge revisions", () => {
    expect(() => requirePinnedKnowledgeRevisions(validEnvironment()))
      .toThrow("blind_acceptance_requires_pinned_knowledge_revisions");
  });

  it("rejects any observation containing a cache hit", () => {
    const dataset = parseBlindAcceptanceDataset(JSON.parse(readFileSync(new URL(
      "../tests/e2e/enterprise-blind-acceptance-20260811-third.json",
      import.meta.url,
    ), "utf8")), new Set());
    const observations = dataset.cases.flatMap((testCase) => [1, 2, 3].map((round) => ({
      caseId: testCase.id,
      round,
      codeCommit: "a".repeat(40),
      model: "deepseek_v4_flash",
      knowledgeRevisions: {
        "coremail-professional": "b".repeat(40),
        "presales-general": "c".repeat(40),
      },
      cacheMode: "cold_disabled",
      scorerVersion: 3,
      policyVersion: "policy-contract-v1",
      releaseId: "release-20260812-fourth",
      answer: "",
      references: [],
      stopReason: "final",
      latencyMs: 1,
      diagnostics: {
        cache: { hitCount: testCase.id === dataset.cases[0]!.id && round === 1 ? 1 : 0,
          missCount: 0, bypassCount: 0, writeCount: 0, writeFailureCount: 0 },
      },
    } as BlindAcceptanceObservation)));

    expect(() => validateBlindAcceptanceRun(dataset, observations))
      .toThrow("blind_acceptance_cache_hit_forbidden");
  });
});

function validEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PSE_MODEL_NAME: "deepseek_v4_flash",
    PSE_RESOLVER_MODEL_NAME: "deepseek_v4_flash",
    PSE_PLANNER_MODEL_NAME: "deepseek_v4_flash",
    PSE_SYNTHESIZER_MODEL_NAME: "deepseek_v4_flash",
    PSE_VERIFIER_MODEL_NAME: "deepseek_v4_flash",
    PSE_CONSENSUS_VERIFIER_MODEL_NAME: "deepseek_v4_flash",
    PSE_RELIABILITY_CONTROL_PLANE_ENABLED: "true",
    PSE_QUALIFIED_CACHE_ENABLED: "false",
    PSE_RELEASE_ID: "release-20260812-fourth",
    ...overrides,
  };
}
