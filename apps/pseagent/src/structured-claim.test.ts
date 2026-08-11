import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "./model-client.js";
import {
  ModelStructuredClaimSynthesizer,
  type ClaimDraft,
} from "./structured-claim.js";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type { DeterministicRetrievalResult } from "./deterministic-retrieval.js";

const contract: AtomicObligationContract = {
  subject: "迁移能力",
  sourceQuestion: "Coremail 是否支持迁移？",
  obligations: [{
    id: "O1",
    sourceSpan: { start: 0, end: 15 },
    sourceText: "Coremail 是否支持迁移",
    kind: "fact",
    targetEntityIds: [],
    domains: ["coremail-professional"],
    evidencePolicy: "direct",
    evidenceTypes: ["formal_page"],
    risk: "low",
    completionCriteria: ["claim_supported"],
    required: true,
  }],
};

const retrieval = {
  project: "coremail-professional",
  revision: "a".repeat(40),
  evidence: [{
    requirementId: "R1",
    obligationId: "O1",
    domain: "coremail-professional",
    citation: 1,
    path: "wiki/queries/migration.md",
    title: "迁移能力",
    compactContent: "正式资料说明迁移能力。",
    aspectIds: ["A1"],
    sourceBoundary: "formal",
  }],
  references: [],
  evidenceLedger: {} as never,
} satisfies DeterministicRetrievalResult;

describe("ModelStructuredClaimSynthesizer", () => {
  it("drafts structured claims without rendering citation markers", async () => {
    const payload: ClaimDraft[] = [{
      claimId: "CL1",
      obligationId: "O1",
      domain: "coremail-professional",
      text: "Coremail 支持迁移。",
      kind: "fact",
      citationIndexes: [1],
      coveredAspectIds: ["A1"],
    }];
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
      input.schema.parse(payload));
    const synthesizer = new ModelStructuredClaimSynthesizer({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(synthesizer.draft({
      contract,
      retrieval,
      signal: new AbortController().signal,
    })).resolves.toEqual(payload);
    expect(completeJson).toHaveBeenCalledOnce();
  });

  it("rejects model text that embeds rendered Markdown citations", async () => {
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
      input.schema.parse([{
        claimId: "CL1",
        obligationId: "O1",
        domain: "coremail-professional",
        text: "Coremail 支持迁移[1]。",
        kind: "fact",
        citationIndexes: [1],
        coveredAspectIds: ["A1"],
      }]));
    const synthesizer = new ModelStructuredClaimSynthesizer({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(synthesizer.draft({
      contract,
      retrieval,
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });
});
