import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContentCipher } from "./crypto.js";
import { KnowledgeOpsService } from "./service.js";
import { InMemoryKnowledgeOpsStore } from "./store.js";

describe("release quality report import", () => {
  it("records a consistent 4x5 deepseek_v4_flash gate for release use", async () => {
    const store = new InMemoryKnowledgeOpsStore();
    const service = new KnowledgeOpsService(store, new ContentCipher(randomBytes(32)));
    const run = await service.recordRegressionRun(
      { actorId: "release-manager", roles: ["release_manager"] },
      report(true),
    );
    expect(run).toMatchObject({ status: "passed", totalCases: 20, passedCases: 20 });
    expect((await service.listRegressionRuns(
      { actorId: "viewer", roles: ["viewer"] },
      { limit: 25, offset: 0 },
    )).items[0]?.runId).toBe(run.runId);
  });

  it("rejects a report whose headline contradicts its failures", async () => {
    const service = new KnowledgeOpsService(
      new InMemoryKnowledgeOpsStore(),
      new ContentCipher(randomBytes(32)),
    );
    const inconsistent = {
      ...report(true),
      summary: { ...report(true).summary, safetyFailures: 1 },
    };
    await expect(service.recordRegressionRun(
      { actorId: "release-manager", roles: ["release_manager"] },
      inconsistent,
    )).rejects.toThrow();
  });

  it("does not allow a legacy green run to bypass the 4x5 release gate", async () => {
    const store = new InMemoryKnowledgeOpsStore();
    const service = new KnowledgeOpsService(store, new ContentCipher(randomBytes(32)));
    const timestamp = new Date().toISOString();
    const legacy = await store.createRegressionRun({
      runId: crypto.randomUUID(),
      status: "passed",
      totalCases: 1,
      passedCases: 1,
      report: { legacy: true },
      createdAt: timestamp,
      completedAt: timestamp,
    });
    await expect(service.requestRelease(
      { actorId: "publisher", roles: ["release_manager"] },
      manifest(legacy.runId),
    )).rejects.toThrow("passing_release_quality_gate_required");

    const quality = await service.recordRegressionRun(
      { actorId: "publisher", roles: ["release_manager"] },
      report(true),
    );
    await expect(service.requestRelease(
      { actorId: "publisher", roles: ["release_manager"] },
      manifest(quality.runId),
    )).resolves.toMatchObject({ release: { regressionRunId: quality.runId } });
  });
});

function report(passed: boolean) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: "deepseek_v4_flash",
    passed,
    summary: {
      total: 20,
      completed: 20,
      passedCases: passed ? 20 : 19,
      averageScore: passed ? 1 : 0.95,
      p95LatencyMs: 12_000,
      safetyFailures: 0,
      availabilityFailures: 0,
    },
    suites: Array.from({ length: 4 }, (_, index) => ({
      suiteId: `suite-${index}`,
      passed,
      passedCases: passed ? 5 : index === 0 ? 4 : 5,
      averageScore: passed ? 1 : index === 0 ? 0.8 : 1,
    })),
    kinds: ["canonical", "alias", "typo", "follow_up", "negative"].map((kind) => ({
      kind,
      passed,
      passedCases: passed ? 4 : 3,
      averageScore: passed ? 1 : 0.75,
    })),
    consistencyChecks: [],
    cases: Array.from({ length: 20 }, (_, index) => ({ caseId: `case-${index}` })),
  };
}

function manifest(regressionRunId: string) {
  return {
    schemaVersion: 1,
    releaseId: "KR-2026-08-QUALITY",
    professionalRevision: "a".repeat(40),
    generalRevision: "b".repeat(40),
    answerContractRevision: "c".repeat(40),
    cardCatalogHash: "d".repeat(64),
    regressionRunId,
    approvedBy: ["independent-reviewer"],
    createdAt: new Date().toISOString(),
  };
}
