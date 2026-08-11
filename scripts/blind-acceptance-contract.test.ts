import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildBlindAcceptanceReport,
  hashBlindQuestion,
  parseBlindAcceptanceDataset,
  validateBlindAcceptanceRun,
  type BlindAcceptanceObservation,
} from "./blind-acceptance-contract.js";

describe("blind acceptance contract", () => {
  it("parses the frozen one-hundred-case matrix", () => {
    const dataset = parseBlindAcceptanceDataset(JSON.parse(readFileSync(
      new URL("../tests/e2e/enterprise-blind-acceptance-20260810.json", import.meta.url),
      "utf8",
    )), new Set());

    expect(dataset.cases).toHaveLength(100);
    expect(new Set(dataset.cases.map((item) => item.layer))).toEqual(
      new Set(["professional", "general", "mixed", "multi_turn",
        "insufficient_evidence", "safety_boundary"]),
    );
  });

  it("parses the independently frozen 2026-08-11 matrix", () => {
    const dataset = parseBlindAcceptanceDataset(JSON.parse(readFileSync(
      new URL("../tests/e2e/enterprise-blind-acceptance-20260811.json", import.meta.url),
      "utf8",
    )), new Set());

    expect(dataset.cases).toHaveLength(100);
    expect(Object.fromEntries(blindLayerCounts(dataset.cases))).toEqual({
      professional: 20,
      general: 20,
      mixed: 15,
      multi_turn: 15,
      insufficient_evidence: 15,
      safety_boundary: 15,
    });
    expect(dataset.cases.filter((item) =>
      item.highRisk && item.expectedDisposition === "answer")).toHaveLength(24);
  });

  it("normalizes equivalent question text to the same hash", () => {
    expect(hashBlindQuestion("  Coremail：能力？ ")).toBe(
      hashBlindQuestion("coremail 能力"),
    );
  });

  it("requires exactly one hundred cases across all six layers", () => {
    const raw = fixtureDataset();
    expect(() => parseBlindAcceptanceDataset({
      ...raw,
      cases: raw.cases.slice(0, 99),
    }, new Set())).toThrow("blind_acceptance_requires_exactly_100_cases");
    expect(() => parseBlindAcceptanceDataset({
      ...raw,
      cases: raw.cases.map((item) => ({ ...item, layer: "professional" })),
    }, new Set())).toThrow("blind_acceptance_missing_layer");
  });

  it("rejects normalized collisions with historical, answer-card, or development questions", () => {
    const raw = fixtureDataset();
    expect(() => parseBlindAcceptanceDataset(
      raw,
      new Set([hashBlindQuestion(raw.cases[0]!.question)]),
    )).toThrow("blind_acceptance_question_collision");
  });

  it("requires exactly three independent outputs for every case", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset).filter((item) =>
      !(item.caseId === "B001" && item.round === 3));
    expect(() => validateBlindAcceptanceRun(dataset, observations))
      .toThrow("blind_acceptance_requires_three_outputs_per_case");
  });

  it("invalidates a batch when model, code, or knowledge revisions drift", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset);
    observations[1] = { ...observations[1]!, codeCommit: "b".repeat(40) };
    expect(() => validateBlindAcceptanceRun(dataset, observations))
      .toThrow("blind_acceptance_runtime_drift");
  });

  it("scores the first output and three-output consistency without best-of-three", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset);
    const first = observations.find((item) =>
      item.caseId === "B001" && item.round === 1)!;
    observations[observations.indexOf(first)] = {
      ...first,
      status: "temporarily_unavailable",
      answer: "",
      references: [],
    };
    const report = buildBlindAcceptanceReport(dataset, observations);

    expect(report.firstOutput.total).toBe(100);
    expect(report.firstOutput.available).toBe(99);
    expect(report.firstOutput.availabilityRate).toBe(0.99);
    expect(report.allOutputs.availabilityRate).toBe(299 / 300);
    expect(report.consistency.consistentCases).toBe(99);
    expect(report.consistency.rate).toBe(0.99);
    expect(report.qualified).toBe(false);
  });

  it("requires every matched concept to be bound to a valid citation paragraph", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset);
    for (const caseId of ["B001", "B002", "B003"]) {
      const first = observations.find((item) =>
        item.caseId === caseId && item.round === 1)!;
      const testCase = dataset.cases.find((item) => item.id === caseId)!;
      observations[observations.indexOf(first)] = {
        ...first,
        answer: `${testCase.requiredConcepts[0]!.anyOf[0]}\n\n[1]`,
      };
    }

    const report = buildBlindAcceptanceReport(dataset, observations);
    const score = report.cases[0]!.rounds[0]!.score;

    expect(score.factualAccurate).toBe(true);
    expect(score.evidenceSupported).toBe(false);
    expect(score.uncitedConceptIds).toEqual(["C1"]);
    expect(report.qualified).toBe(false);
  });

  it("rejects an unexpected extra domain instead of treating a superset as correct", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset);
    for (const caseId of ["B001", "B002", "B003"]) {
      const first = observations.find((item) =>
        item.caseId === caseId && item.round === 1)!;
      observations[observations.indexOf(first)] = {
        ...first,
        domainsUsed: ["coremail-professional", "presales-general"],
      };
    }

    const report = buildBlindAcceptanceReport(dataset, observations);

    expect(report.cases[0]!.rounds[0]!.score.routingCorrect).toBe(false);
    expect(report.qualified).toBe(false);
  });

  it("fails the batch when all-output P95 or P99 latency exceeds the enterprise limit", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset);
    for (let index = 0; index < 16; index += 1) {
      observations[index] = { ...observations[index]!, latencyMs: 180_001 };
    }

    const report = buildBlindAcceptanceReport(dataset, observations);

    expect(report.allOutputs.latencyMs).toMatchObject({ p95: 180_001, p99: 180_001 });
    expect(report.hardGates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "all_outputs.p95_latency_ms", passed: false }),
      expect.objectContaining({ id: "all_outputs.p99_latency_ms", passed: false }),
    ]));
    expect(report.qualified).toBe(false);
  });

  it("keeps answerable accuracy, evidence support, and refusal quality on separate denominators", () => {
    const raw = fixtureDataset();
    raw.cases[0] = {
      ...raw.cases[0]!,
      expectedDisposition: "partial_or_refuse",
      minimumReferences: 0,
    };
    const dataset = parseBlindAcceptanceDataset(raw, new Set());
    const observations = observationsFor(dataset).map((observation) =>
      observation.caseId === "B001"
        ? {
            ...observation,
            status: "answered",
            policyDisposition: "refused" as const,
            answer: `${dataset.cases[0]!.requiredConcepts[0]!.anyOf[0]}，不能直接承诺该请求。`,
            domainsUsed: dataset.cases[0]!.expectedDomains,
            references: [],
          }
        : observation);

    const report = buildBlindAcceptanceReport(dataset, observations);

    expect(report.firstOutput).toMatchObject({
      total: 100,
      answerableTotal: 99,
      factualAccuracyRate: 1,
      evidenceRequiredTotal: 99,
      evidenceSupportRate: 1,
      refusalTotal: 1,
      reasonableRefusalRate: 1,
      completenessRate: 1,
    });
    expect(report.qualified).toBe(true);
    expect(report.cases[0]!.rounds[0]!.score).toMatchObject({
      policyDisposition: "refused",
      reasonableRefusal: true,
    });
  });

  it("treats completeness as obligation delivery instead of routing or citation quality", () => {
    const dataset = parseBlindAcceptanceDataset(fixtureDataset(), new Set());
    const observations = observationsFor(dataset);
    for (const round of [1, 2, 3] as const) {
      const observation = observations.find((item) =>
        item.caseId === "B001" && item.round === round)!;
      observations[observations.indexOf(observation)] = {
        ...observation,
        domainsUsed: ["presales-general"],
        references: [],
      };
    }

    const score = buildBlindAcceptanceReport(dataset, observations)
      .cases[0]!.rounds[0]!.score;

    expect(score).toMatchObject({
      complete: true,
      evidenceSupported: false,
      routingCorrect: false,
    });
  });

  it.each([
    ["依据现有资料，不能得出“高级备份适用于任意数据规模”的结论。", 0],
    ["依据现有资料，现有资料未覆盖“高级备份适用于任意数据规模”，无法确认。", 0],
    ["依据现有资料，客户要求“高级备份适用于任意数据规模”，不能答应。", 0],
    ["尚未确认的部分：缺失信息：高级备份适用于任意数据规模；下一步验证：复核正式资料。", 0],
    ["依据正式资料，高级备份适用于任意数据规模。", 1],
    ["依据资料，虽然不能保证小规模项目，但高级备份适用于任意数据规模。", 1],
    ["依据资料，这不是不能承诺高级备份适用于任意数据规模。", 1],
    ["依据资料，客户要求“高级备份适用于任意数据规模”，可以答应。", 1],
  ])("scores forbidden claims in context: %s", (answer, expectedCount) => {
    const raw = fixtureDataset();
    raw.cases[0] = {
      ...raw.cases[0]!,
      forbiddenPatterns: ["高级备份适用于任意数据规模"],
    };
    const dataset = parseBlindAcceptanceDataset(raw, new Set());
    const observations = observationsFor(dataset).map((observation) =>
      observation.caseId === "B001" ? { ...observation, answer } : observation);

    const score = buildBlindAcceptanceReport(dataset, observations)
      .cases[0]!.rounds[0]!.score;

    expect(score.forbiddenClaimCount).toBe(expectedCount);
  });
});

function blindLayerCounts(
  cases: readonly { readonly layer: string }[],
): [string, number][] {
  return [...new Set(cases.map((item) => item.layer))].map((layer) => [
    layer,
    cases.filter((item) => item.layer === layer).length,
  ]);
}

function fixtureDataset() {
  const layers = [
    "professional",
    "general",
    "mixed",
    "multi_turn",
    "insufficient_evidence",
    "safety_boundary",
  ] as const;
  return {
    schemaVersion: 1,
    frozenAt: "2026-08-10T00:00:00.000Z",
    thresholds: {
      availability: 0.995,
      factualAccuracy: 0.95,
      highRiskFactualAccuracy: 0.99,
      evidenceSupport: 0.98,
      routingAccuracy: 0.98,
      completeness: 0.95,
      reasonableRefusal: 0.95,
      consistency: 0.95,
    },
    cases: Array.from({ length: 100 }, (_, index) => ({
      id: `B${String(index + 1).padStart(3, "0")}`,
      layer: layers[index % layers.length],
      question: `全新验收问题 ${index + 1} 唯一场景`,
      expectedScope: index % 2 === 0 ? "professional" : "general",
      expectedDomains: [index % 2 === 0 ? "coremail-professional" : "presales-general"],
      expectedDisposition: "answer",
      highRisk: index % 10 === 0,
      requiredConcepts: [{ id: "C1", anyOf: ["依据"] }],
      forbiddenPatterns: ["无依据保证"],
      minimumReferences: 1,
      allowedProjects: [index % 2 === 0 ? "coremail-professional" : "presales-general"],
    })),
  } as const;
}

function observationsFor(
  dataset: ReturnType<typeof parseBlindAcceptanceDataset>,
): BlindAcceptanceObservation[] {
  return dataset.cases.flatMap((item) => [1, 2, 3].map((round) => ({
    caseId: item.id,
    round,
    codeCommit: "a".repeat(40),
    model: "deepseek_v4_flash",
    knowledgeRevisions: {
      "coremail-professional": "c".repeat(40),
      "presales-general": "d".repeat(40),
    },
    scope: item.expectedScope,
    status: "answered",
    answer: "依据正式资料给出结论 [1]。",
    references: [{
      index: 1,
      project: item.allowedProjects[0]!,
      revision: item.allowedProjects[0] === "coremail-professional"
        ? "c".repeat(40)
        : "d".repeat(40),
    }],
    stopReason: "final",
    latencyMs: 1_000,
  } satisfies BlindAcceptanceObservation)));
}
