import { describe, expect, it } from "vitest";
import { resolveRepairRoute } from "./worker.js";

describe("repair route", () => {
  const revision="a".repeat(40);

  it("keeps a knowledge gap blocked at the exact revision when no formal evidence exists", () => {
    expect(resolveRepairRoute({category:"knowledge_gap",domain:"coremail-professional",revision,located:undefined,hasEvidence:false})).toMatchObject({targetKind:"knowledge_page",targetDomain:"coremail-professional",baseGitRevision:revision,publishableAllowed:false});
  });

  it("allows newly discovered formal evidence to enter answer-card generation", () => {
    expect(resolveRepairRoute({category:"knowledge_gap",domain:"coremail-professional",revision,located:undefined,hasEvidence:true})).toEqual({targetKind:"answer_card",targetDomain:"coremail-professional",baseGitRevision:revision,publishableAllowed:true});
  });

  it("never turns a system defect into a knowledge edit", () => {
    expect(resolveRepairRoute({category:"logic_gap",domain:"coremail-professional",revision,located:undefined,hasEvidence:true})).toMatchObject({targetKind:"system_fix",publishableAllowed:false});
  });
});
