import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRoutingGoldReport,
  parseRoutingGoldDataset,
  type RoutingObservation,
} from "./probe-routing-gold-contract.js";

describe("routing gold contract", () => {
  it("parses the frozen routing set with five or more cases per category", () => {
    const dataset = parseRoutingGoldDataset(JSON.parse(readFileSync(
      new URL("../tests/regression/routing-gold.json", import.meta.url),
      "utf8",
    )));

    expect(dataset.cases).toHaveLength(35);
    expect(new Set(dataset.cases.map((item) => item.category)).size).toBe(7);
  });

  it("reports accuracy, per-class recall and the confusion matrix separately", () => {
    const dataset = parseRoutingGoldDataset(fixture());
    const observations: RoutingObservation[] = [
      { id: "G1", actualScope: "general" },
      { id: "P1", actualScope: "general" },
      { id: "N1", actualScope: "normal" },
    ];

    expect(buildRoutingGoldReport(dataset, observations)).toMatchObject({
      total: 3,
      correct: 2,
      accuracy: 2 / 3,
      confusionMatrix: {
        general: { general: 1, professional: 0, normal: 0 },
        professional: { general: 1, professional: 0, normal: 0 },
        normal: { general: 0, professional: 0, normal: 1 },
      },
      perScope: {
        general: { support: 1, correct: 1, recall: 1 },
        professional: { support: 1, correct: 0, recall: 0 },
        normal: { support: 1, correct: 1, recall: 1 },
      },
      qualified: false,
    });
  });

  it("refuses qualification when any declared category is undersampled", () => {
    const raw = fixture() as { minimumPerCategory: number };
    raw.minimumPerCategory = 2;
    const dataset = parseRoutingGoldDataset(raw);
    const observations = dataset.cases.map((item) => ({
      id: item.id,
      actualScope: item.expectedScope,
    }));

    expect(buildRoutingGoldReport(dataset, observations)).toMatchObject({
      insufficientCategories: ["general", "normal", "professional"],
      qualified: false,
    });
  });

  it("qualifies a complete set only when accuracy is at least 98 percent", () => {
    const dataset = parseRoutingGoldDataset(fixture());
    const observations = dataset.cases.map((item) => ({
      id: item.id,
      actualScope: item.expectedScope,
    }));

    expect(buildRoutingGoldReport(dataset, observations)).toMatchObject({
      accuracy: 1,
      insufficientCategories: [],
      qualified: true,
    });
  });
});

function fixture(): unknown {
  return {
    schemaVersion: 1,
    frozenAt: "2026-08-10T00:00:00.000Z",
    minimumPerCategory: 1,
    cases: [
      { id: "G1", category: "general", question: "通用问题", expectedScope: "general" },
      { id: "P1", category: "professional", question: "专业问题", expectedScope: "professional" },
      { id: "N1", category: "normal", question: "普通问题", expectedScope: "normal" },
    ],
  };
}
