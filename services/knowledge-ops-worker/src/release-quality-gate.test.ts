import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateReleaseQualityGate,
  parseReleaseQualitySuites,
  type ReleaseQualityObservation,
  type ReleaseQualitySuite,
} from "./release-quality-gate.js";

const source = JSON.parse(readFileSync(
  new URL("../../../tests/regression/release-quality-suites.json", import.meta.url),
  "utf8",
));
const suites = parseReleaseQualitySuites(source);

describe("release quality gate", () => {
  it("keeps four parallel suites with five distinct question kinds each", () => {
    expect(suites).toHaveLength(4);
    expect(suites.flatMap((suite) => suite.cases)).toHaveLength(20);
    for (const suite of suites) {
      expect(suite.cases.map((item) => item.turn).sort()).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(suite.cases.map((item) => item.kind))).toEqual(new Set([
        "canonical", "alias", "typo", "follow_up", "negative",
      ]));
    }
  });

  it("passes only when all twenty fixed-model observations satisfy every check", () => {
    const report = evaluateReleaseQualityGate(source, perfectObservations(suites));
    expect(report).toMatchObject({
      model: "deepseek_v4_flash",
      passed: true,
      summary: { total: 20, completed: 20, passedCases: 20, safetyFailures: 0 },
    });
    expect(report.suites).toHaveLength(4);
    expect(report.kinds).toHaveLength(5);
    expect(report.consistencyChecks.every((item) => item.passed)).toBe(true);
  });

  it("fails closed on another model, a missing result, or an unsafe claim", () => {
    const observations = perfectObservations(suites);
    observations[0] = { ...observations[0]!, model: "another-model" };
    observations[1] = { caseId: observations[1]!.caseId, model: "deepseek_v4_flash", latencyMs: 1, failure: "timeout" };
    observations[19] = { ...observations[19]!, answer: "现已明确支持2035量子卫星邮件协议" };
    const report = evaluateReleaseQualityGate(source, observations);
    expect(report.passed).toBe(false);
    expect(report.summary.completed).toBe(19);
    expect(report.summary.safetyFailures).toBeGreaterThan(0);
    expect(report.cases.flatMap((item) => item.checks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "model", passed: false }),
      expect.objectContaining({ category: "availability", passed: false }),
      expect.objectContaining({ category: "safety", passed: false }),
    ]));
  });

  it("rejects duplicate observations instead of silently choosing one", () => {
    const observations = perfectObservations(suites);
    expect(() => evaluateReleaseQualityGate(source, [...observations, observations[0]!]))
      .toThrow(`duplicate_quality_observation:${observations[0]!.caseId}`);
  });

  it("fails when an expected answer card matches but is not activated", () => {
    const observations = perfectObservations(suites);
    const governedIndex = observations.findIndex((item) => item.matchType === "exact");
    observations[governedIndex] = {
      ...observations[governedIndex]!,
      answerCardActivated: false,
    };

    const report = evaluateReleaseQualityGate(source, observations);

    expect(report.passed).toBe(false);
    expect(report.cases.flatMap((item) => item.checks)).toContainEqual(
      expect.objectContaining({
        category: "answer_card",
        id: "activated",
        passed: false,
      }),
    );
  });
});

function perfectObservations(values: readonly ReleaseQualitySuite[]): ReleaseQualityObservation[] {
  return values.flatMap((suite) => suite.cases.map((testCase, index) => ({
    caseId: testCase.id,
    model: "deepseek_v4_flash",
    scope: testCase.expected.scopes[0]!,
    status: testCase.expected.statuses[0]!,
    answer: testCase.expected.requiredConcepts.map((concept) => concept.anyOf[0]).join("；"),
    referenceCount: testCase.expected.minimumReferences ?? 0,
    matchType: testCase.expected.matchTypes?.[0] ?? "none",
    answerCardActivated: testCase.expected.matchTypes?.some((type) => type !== "none") ?? false,
    latencyMs: 1_000 + index,
    stopReason: "final",
  })));
}
