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
    expect(report.consistency.consistentCases).toBe(99);
    expect(report.consistency.rate).toBe(0.99);
    expect(report.qualified).toBe(false);
  });
});

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
