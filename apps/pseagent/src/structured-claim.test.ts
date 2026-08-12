import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleModelClient, type ModelClient } from "./model-client.js";
import {
  hashClaimText,
  ModelClaimSupportVerifier,
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
    aspectRequirements: [{
      id: "A1",
      label: "migration capability",
      terms: ["migration", "capability"],
    }],
    sourceBoundary: "formal",
  }],
  references: [],
  evidenceLedger: {} as never,
} satisfies DeterministicRetrievalResult;

afterEach(() => vi.unstubAllGlobals());

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
      input.schema.parse({ claims: payload }));
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
    expect(completeJson).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining('{"claims":[...]}'),
      })]),
    }));
    const inputMessage = vi.mocked(completeJson).mock.calls[0]![0].messages[1]!.content;
    expect(inputMessage).toContain("禁止复制输入");
    expect(inputMessage.trimStart().startsWith("{")).toBe(false);
    expect(inputMessage).toContain('"label":"migration capability"');
    expect(inputMessage).toContain('"terms":["migration","capability"]');
    const systemMessage = vi.mocked(completeJson).mock.calls[0]![0].messages[0]!.content;
    expect(systemMessage).toContain("aspectRequirements");
  });

  it("rejects model text that embeds rendered Markdown citations", async () => {
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
      input.schema.parse({ claims: [{
        claimId: "CL1",
        obligationId: "O1",
        domain: "coremail-professional",
        text: "Coremail 支持迁移[1]。",
        kind: "fact",
        citationIndexes: [1],
        coveredAspectIds: ["A1"],
      }] }));
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

  it("uses a root object envelope through the real compatible client", async () => {
    const payload: ClaimDraft[] = [{
      claimId: "CL1", obligationId: "O1", domain: "coremail-professional",
      text: "Coremail 支持迁移。", kind: "fact", citationIndexes: [1],
      coveredAspectIds: ["A1"],
    }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ claims: payload }) } }],
    })));
    const model = new OpenAiCompatibleModelClient({
      baseUrl: "https://model.example/v1", apiKey: "secret", model: "fixed",
      timeoutMs: 1_000, maxTokens: 8_192,
    });

    await expect(new ModelStructuredClaimSynthesizer(model).draft({
      contract, retrieval, signal: new AbortController().signal,
    })).resolves.toEqual(payload);
  });
});

describe("ModelClaimSupportVerifier", () => {
  it("parses decisions from a root object envelope", async () => {
    const decisions = [{
      claimId: "CL1", claimHash: hashClaimText("Coremail 支持迁移。"), citationIndexes: [1],
      verdict: "supported" as const,
    }];
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
      input.schema.parse({ decisions }));
    const verifier = new ModelClaimSupportVerifier({
      completeJson, completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(verifier.verify({
      claims: [{
        claimId: "CL1", obligationId: "O1", domain: "coremail-professional",
        text: "Coremail 支持迁移。", kind: "fact", citationIndexes: [1],
        coveredAspectIds: ["A1"], support: "direct", evidenceIdentities: [],
      }],
      evidence: retrieval.evidence,
      signal: new AbortController().signal,
    })).resolves.toEqual(decisions);

    expect(completeJson).toHaveBeenCalledOnce();
    expect(completeJson).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining('{"decisions":[...]}'),
      })]),
    }));
    const inputMessage = vi.mocked(completeJson).mock.calls[0]![0].messages[1]!.content;
    expect(inputMessage).toContain("禁止复制输入");
    expect(inputMessage.trimStart().startsWith("{")).toBe(false);
  });
});
