import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCurrentRetrievalGoldReport,
  parseCurrentRetrievalGoldDataset,
  type CurrentRetrievalGoldObservation,
} from "./current-retrieval-gold-contract.js";

describe("current retrieval gold contract", () => {
  it("parses a revision-bound and balanced sixty-case matrix", () => {
    const dataset = fixtureDataset();

    expect(dataset.cases).toHaveLength(60);
    expect(dataset.cases.filter((item) => item.project === "coremail-professional"))
      .toHaveLength(30);
    expect(dataset.cases.filter((item) => item.project === "presales-general"))
      .toHaveLength(30);
    expect(dataset.topK).toBe(10);
    expect(dataset.minimumRecall).toBe(0.95);
  });

  it("passes only when the overall and both project recalls meet the floor", () => {
    const dataset = fixtureDataset();
    const observations = observationsFor(dataset);
    observations[0] = { ...observations[0]!, hits: [] };
    observations[30] = { ...observations[30]!, hits: [] };

    const report = buildCurrentRetrievalGoldReport(dataset, observations);

    expect(report.overall).toMatchObject({
      total: 60,
      available: 60,
      recalled: 58,
      recallRate: 0.966667,
    });
    expect(report.perProject["coremail-professional"].recallRate).toBe(0.966667);
    expect(report.perProject["presales-general"].recallRate).toBe(0.966667);
    expect(report.qualified).toBe(true);
  });

  it("fails below the recall floor and does not hide an unavailable search", () => {
    const dataset = fixtureDataset();
    const belowRecall = observationsFor(dataset);
    for (let index = 0; index < 3; index += 1) {
      belowRecall[index] = { ...belowRecall[index]!, hits: [] };
    }
    expect(buildCurrentRetrievalGoldReport(dataset, belowRecall).overall.recallRate)
      .toBe(0.95);
    expect(buildCurrentRetrievalGoldReport(dataset, belowRecall).qualified).toBe(false);

    const unavailable = observationsFor(dataset);
    unavailable[0] = { ...unavailable[0]!, hits: [], failure: "provider_unavailable" };
    const unavailableReport = buildCurrentRetrievalGoldReport(dataset, unavailable);
    expect(unavailableReport.overall.availabilityRate).toBe(0.983333);
    expect(unavailableReport.qualified).toBe(false);
  });

  it("rejects revision drift and missing observations", () => {
    const dataset = fixtureDataset();
    const observations = observationsFor(dataset);
    observations[0] = { ...observations[0]!, revision: "f".repeat(40) };

    expect(() => buildCurrentRetrievalGoldReport(dataset, observations))
      .toThrow("invalid_current_retrieval_gold_observation");
    expect(() => buildCurrentRetrievalGoldReport(dataset, observations.slice(1)))
      .toThrow("current_retrieval_gold_observation_count_invalid");
  });
});

function fixtureDataset() {
  return parseCurrentRetrievalGoldDataset(JSON.parse(readFileSync(
    new URL("../tests/regression/current-revision-retrieval-gold-20260811.json", import.meta.url),
    "utf8",
  )));
}

function observationsFor(
  dataset: ReturnType<typeof fixtureDataset>,
): CurrentRetrievalGoldObservation[] {
  return dataset.cases.map((item) => ({
    caseId: item.id,
    project: item.project,
    revision: dataset.knowledgeRevisions[item.project],
    hits: [{ path: item.expectedPaths[0]!, score: 1 }],
    latencyMs: 10,
  }));
}
