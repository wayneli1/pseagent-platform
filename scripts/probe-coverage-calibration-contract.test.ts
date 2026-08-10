import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateDeterministicCoverageGate } from "../apps/pseagent/src/deterministic-coverage-gate.js";
import {
  buildCoverageCalibrationReport,
  parseCoverageCalibrationDataset,
  type CoverageCalibrationObservation,
} from "./probe-coverage-calibration-contract.js";

describe("coverage calibration contract", () => {
  it("parses the frozen gold set and preserves every expected gate decision", () => {
    const dataset = parseCoverageCalibrationDataset(JSON.parse(readFileSync(
      new URL("../tests/regression/coverage-verifier-calibration.json", import.meta.url),
      "utf8",
    )));

    expect(dataset.cases).toHaveLength(8);
    for (const item of dataset.cases) {
      expect(evaluateDeterministicCoverageGate({
        question: item.question,
        plan: item.plan,
        draft: item.draft,
        evidence: item.evidence,
        conditions: item.conditions,
      })).toMatchObject(item.expectedGate);
    }
  });

  it("refuses a calibration dataset without case-level gold", () => {
    expect(() => parseCoverageCalibrationDataset({
      schemaVersion: 1,
      frozenAt: "2026-08-10T00:00:00.000Z",
      cases: [{ id: "C01" }],
    })).toThrowError(/calibration_gold_required:C01/u);
  });

  it("counts false upgrades, false downgrades and correct holds", () => {
    const dataset = parseCoverageCalibrationDataset(datasetFixture());
    const observations: CoverageCalibrationObservation[] = [
      observation("C01", 1, "complete"),
      observation("C01", 2, "complete"),
      observation("C01", 3, "partial"),
      observation("C02", 1, "complete"),
      observation("C02", 2, "none"),
      observation("C02", 3, "partial"),
    ];

    expect(buildCoverageCalibrationReport(dataset, observations, 3))
      .toMatchObject({
        expectedRuns: 6,
        completedRuns: 6,
        falseUpgrades: 3,
        falseDowngrades: 1,
        correctHolds: 2,
        inconsistentCaseIds: ["C01", "C02"],
        qualified: false,
      });
  });

  it("qualifies only a complete, gold-backed and three-run consistent report", () => {
    const dataset = parseCoverageCalibrationDataset(datasetFixture());
    const observations = [1, 2, 3].flatMap((run) => [
      observation("C01", run, "partial"),
      observation("C02", run, "partial"),
    ]);

    expect(buildCoverageCalibrationReport(dataset, observations, 3))
      .toMatchObject({
        expectedRuns: 6,
        completedRuns: 6,
        falseUpgrades: 0,
        falseDowngrades: 0,
        correctHolds: 6,
        inconsistentCaseIds: [],
        qualified: true,
      });
  });

  it("does not qualify an incomplete run even when every result is correct", () => {
    const dataset = parseCoverageCalibrationDataset(datasetFixture());
    const observations = [
      observation("C01", 1, "partial"),
      observation("C02", 1, "partial"),
    ];

    expect(buildCoverageCalibrationReport(dataset, observations, 3))
      .toMatchObject({ completedRuns: 2, qualified: false });
  });
});

function observation(
  caseId: string,
  run: number,
  coverage: "complete" | "partial" | "none",
): CoverageCalibrationObservation {
  return {
    caseId,
    run,
    coverage,
    gateDisposition: "semantic_required",
    elapsedMs: 10,
  };
}

function datasetFixture(): unknown {
  const calibrationCase = (id: string) => ({
    id,
    category: "support_boundary",
    question: "是否支持目标协议？",
    gold: {
      coverage: "partial",
      authority: "人工逐句核对正式正文",
    },
    expectedGate: { disposition: "semantic_required", risk: "high" },
    plan: {
      subject: "协议支持",
      requirements: [{
        id: "R1",
        question: "是否支持目标协议",
        evidenceMode: "direct_only",
        evidenceAspects: [{ id: "A1", label: "支持边界", terms: ["支持"] }],
        queries: [{ text: "目标协议 支持边界", aspectIds: ["A1"] }],
      }],
    },
    draft: {
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "资料只支持部分场景 [1]。",
        citations: [1],
      }],
      citations: [1],
    },
    evidence: [{
      requirementId: "R1",
      citation: 1,
      title: "协议边界",
      path: "wiki/concepts/协议边界.md",
      content: "目标协议只在指定场景受到支持，其他场景待确认。",
      aspectIds: ["A1"],
    }],
    conditions: [],
  });
  return {
    schemaVersion: 1,
    frozenAt: "2026-08-10T00:00:00.000Z",
    cases: [calibrationCase("C01"), calibrationCase("C02")],
  };
}
