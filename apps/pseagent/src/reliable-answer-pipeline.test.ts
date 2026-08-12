import { describe, expect, it, vi } from "vitest";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import type { DeterministicRetrievalResult } from "./deterministic-retrieval.js";
import type { DomainKnowledgePlan } from "./domain-plan.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import {
  HighRiskConsensusGate,
  consensusClaimSignature,
} from "./high-risk-consensus.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
} from "./model-client.js";
import {
  coalesceHighRiskClaims,
  DeterministicReliableAnswerPipeline,
  ModelTargetedClaimReviser,
  reduceReliableOutcomes,
  type TargetedClaimReviser,
} from "./reliable-answer-pipeline.js";
import { StageBudgetAllocator } from "./stage-budget.js";
import { hashClaimText, type BoundClaim, type ClaimDraft } from "./structured-claim.js";

const contract: AtomicObligationContract = {
  subject: "归档能力",
  sourceQuestion: "说明归档能力",
  obligations: [{
    id: "O1",
    sourceSpan: { start: 0, end: 6 },
    sourceText: "说明归档能力",
    kind: "fact",
    targetEntityIds: ["归档"],
    domains: ["coremail-professional"],
    evidencePolicy: "direct",
    evidenceTypes: ["formal_page"],
    risk: "low",
    completionCriteria: ["正式资料直接支持"],
    required: true,
  }],
};

const plan: DomainKnowledgePlan = {
  domain: "coremail-professional",
  scope: "professional",
  plan: {
    subject: "归档能力",
    requirements: [{
      id: "R1",
      question: "说明归档能力",
      evidenceMode: "direct_only",
      evidenceAspects: [{ id: "A1", label: "归档能力", terms: ["归档"] }],
      queries: [{ text: "归档能力", aspectIds: ["A1"] }],
    }],
  },
  bindings: [{
    domain: "coremail-professional",
    requirementId: "R1",
    deliverableId: "D1",
    obligationId: "O1",
    order: 0,
  }],
};

const reference = {
  index: 1,
  project: "coremail-professional" as const,
  title: "归档说明",
  path: "wiki/product/archive.md",
  revision: "a".repeat(40),
  contentHash: "b".repeat(64),
};

const evidenceLedger = {
  project: "coremail-professional",
  revision: reference.revision,
  units: [{
    binding: plan.bindings[0],
    requirement: plan.plan.requirements[0],
    inputState: "not_applicable",
    verification: { coverage: "complete" },
  }],
} as unknown as EvidenceLedger;

const retrievalResult: DeterministicRetrievalResult = {
  project: "coremail-professional",
  revision: reference.revision,
  evidence: [{
    requirementId: "R1",
    obligationId: "O1",
    domain: "coremail-professional",
    citation: 1,
    path: reference.path,
    title: reference.title,
    compactContent: "正式资料说明支持邮件归档。",
    aspectIds: ["A1"],
    aspectRequirements: [{
      id: "A1",
      label: "mail archive support",
      terms: ["mail", "archive"],
    }],
    sourceBoundary: "formal",
  }],
  references: [reference],
  evidenceLedger,
};

function traceFixture(): { readonly trace: DiagnosticTrace; readonly events: DiagnosticEvent[] } {
  const events: DiagnosticEvent[] = [];
  return {
    events,
    trace: {
      requestId: "reliable-pipeline-test",
      record(event) {
        events.push(event);
      },
    },
  };
}

function pipelineFixture(input: {
  readonly verifierVerdicts?: readonly ("supported" | "insufficient")[];
  readonly reviser?: TargetedClaimReviser;
  readonly secondVerifier?: ModelClient;
} = {}) {
  const knowledge = {
    open: vi.fn(async () => ({ project: "coremail-professional" }) as KnowledgeSession),
  };
  const retrieval = { retrieve: vi.fn(async () => retrievalResult) };
  const synthesizer = {
    draft: vi.fn(async () => [{
      claimId: "CL1" as const,
      obligationId: "O1" as const,
      domain: "coremail-professional" as const,
      text: "支持邮件归档。",
      kind: "fact" as const,
      citationIndexes: [1],
      coveredAspectIds: ["A1"],
    }]),
  };
  const verdicts = [...(input.verifierVerdicts ?? ["supported"] as const)];
  const verifier = {
    verify: vi.fn(async ({ claims }: { readonly claims: readonly { readonly claimId: string; readonly text: string; readonly citationIndexes: readonly number[] }[] }) =>
      claims.map((claim) => ({
        claimId: claim.claimId,
        claimHash: hashClaimText(claim.text),
        citationIndexes: claim.citationIndexes,
        verdict: verdicts.shift() ?? "supported",
      }))),
  };
  const pipeline = new DeterministicReliableAnswerPipeline({
    knowledge,
    retrieval,
    synthesizer,
    verifier,
    ...(input.reviser === undefined ? {} : { targetedReviser: input.reviser }),
    ...(input.secondVerifier === undefined
      ? {}
      : {
          highRiskConsensus: {
            gate: new HighRiskConsensusGate(),
            firstVerifier: input.secondVerifier,
            secondVerifier: input.secondVerifier,
            firstModelId: "verifier-a",
            secondModelId: "verifier-b",
          },
        }),
  });
  return { pipeline, knowledge, retrieval, synthesizer, verifier };
}

describe("ModelTargetedClaimReviser", () => {
  it("parses revisions from a root object envelope", async () => {
    const revisions: ClaimDraft[] = [{
      claimId: "CL1",
      obligationId: "O1",
      domain: "coremail-professional",
      text: "正式资料直接支持邮件归档。",
      kind: "fact",
      citationIndexes: [1],
      coveredAspectIds: ["A1"],
    }];
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
      input.schema.parse({ revisions }));
    const reviser = new ModelTargetedClaimReviser({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(reviser.revise({
      rejectedClaims: revisions,
      evidence: retrievalResult.evidence,
      contract,
      signal: new AbortController().signal,
    })).resolves.toEqual(revisions);

    expect(completeJson).toHaveBeenCalledOnce();
    expect(completeJson).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining('{"revisions":[...]}'),
      })]),
    }));
    const inputMessage = vi.mocked(completeJson).mock.calls[0]![0].messages[1]!.content;
    expect(inputMessage).toContain("禁止复制输入");
    expect(inputMessage.trimStart().startsWith("{")).toBe(false);
  });
});

describe("deterministic reliable answer pipeline", () => {
  it("coalesces repeated high-risk facts per obligation before consensus", () => {
    const first: BoundClaim = {
      claimId: "CL1",
      obligationId: "O1",
      domain: "coremail-professional",
      text: "密码不能直接迁移。",
      kind: "boundary",
      citationIndexes: [1],
      coveredAspectIds: ["A1"],
      support: "direct",
      evidenceIdentities: [reference.contentHash],
    };
    const second: BoundClaim = {
      ...first,
      claimId: "CL2",
      text: "标准做法是通过 AD 外部认证承接登录。",
      kind: "fact",
    };

    expect(coalesceHighRiskClaims(
      [first, second],
      new Set(["O1"]),
    )).toEqual([{
      ...first,
      text: "密码不能直接迁移；标准做法是通过 AD 外部认证承接登录。",
    }]);
    expect(coalesceHighRiskClaims([first, second], new Set())).toEqual([
      first,
      second,
    ]);
  });

  it("publishes evidence-identical governed facts when open-ended synthesis is invalid", async () => {
    const governedPlan: DomainKnowledgePlan = {
      ...plan,
      bindings: [{
        ...plan.bindings[0]!,
        cardId: "CM-ARCHIVE-001",
        cardTitle: "归档说明",
        requiredConcepts: ["邮件归档"],
        preferredEvidencePaths: [reference.path],
        answerTemplate: "正式资料说明支持邮件归档。",
      }],
    };
    const governedRetrieval: DeterministicRetrievalResult = {
      ...retrievalResult,
      evidenceLedger: {
        ...evidenceLedger,
        units: [{
          binding: governedPlan.bindings[0],
          requirement: governedPlan.plan.requirements[0],
          inputState: "not_applicable",
          verification: { coverage: "complete" },
        }],
      } as unknown as EvidenceLedger,
    };
    const synthesizer = {
      draft: vi.fn(async () => {
        throw new InvalidModelPayloadError("invalid_schema:claims:required");
      }),
    };
    const verifier = { verify: vi.fn() };
    const pipeline = new DeterministicReliableAnswerPipeline({
      knowledge: {
        open: vi.fn(async () => ({ project: "coremail-professional" }) as KnowledgeSession),
      },
      retrieval: { retrieve: vi.fn(async () => governedRetrieval) },
      synthesizer,
      verifier,
    });
    const { trace } = traceFixture();

    const execution = await pipeline.answer({
      question: contract.sourceQuestion,
      scope: "professional",
      contract,
      plans: [governedPlan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(execution.result.status).toBe("answered");
    expect(execution.result.answer).toContain("正式资料说明支持邮件归档。[1]");
    expect(synthesizer.draft).toHaveBeenCalledOnce();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(execution.callBudget).toMatchObject({
      usedOpenEndedCalls: 1,
      usedStructuredCalls: 0,
    });
  });

  it("names governed customer inputs in a deterministic missing-input outcome", () => {
    const customerInputContract: AtomicObligationContract = {
      ...contract,
      obligations: [{
        ...contract.obligations[0]!,
        evidencePolicy: "customer_input",
        evidenceTypes: ["customer_fact"],
        domains: ["presales-general"],
      }],
    };
    const customerInputPlan: DomainKnowledgePlan = {
      ...plan,
      domain: "presales-general",
      scope: "general",
      bindings: [{
        domain: "presales-general",
        requirementId: "R1",
        deliverableId: "D1",
        obligationId: "O1",
        order: 0,
        cardId: "PRO-POC-UNPURCHASED-FUNCTIONS",
        requiredConcepts: ["合同范围", "客户现状", "人工确认"],
      }],
    };
    const customerInputLedger = {
      ...evidenceLedger,
      project: "presales-general",
      units: [{
        binding: customerInputPlan.bindings[0],
        requirement: customerInputPlan.plan.requirements[0],
        inputState: "missing",
        verification: { coverage: "not_covered" },
      }],
    } as unknown as EvidenceLedger;

    const outcomes = reduceReliableOutcomes({
      contract: customerInputContract,
      plans: [customerInputPlan],
      retrievals: [{
        ...retrievalResult,
        project: "presales-general",
        evidence: [],
        references: [],
        evidenceLedger: customerInputLedger,
      }],
      claims: [],
      failedDomains: new Set(),
      verificationUnavailable: false,
      consensusRejectedObligationIds: new Set(),
    });

    expect(outcomes[0]).toMatchObject({
      state: "missing_input",
      gapReason: expect.stringMatching(/合同范围.*客户现状.*人工确认/u),
    });
  });

  it("does not mark a governed target complete when formal evidence only proves it is unconfirmed", () => {
    const boundaryQuestion = "系统是否支持星际量子邮件协议？请直接回答支持或不支持。";
    const boundaryContract: AtomicObligationContract = {
      ...contract,
      sourceQuestion: boundaryQuestion,
      obligations: [{
        ...contract.obligations[0]!,
        sourceSpan: { start: 0, end: boundaryQuestion.length },
        sourceText: boundaryQuestion,
        provenance: "governed",
      }],
    };
    const boundaryClaim: BoundClaim = {
      claimId: "CL1",
      obligationId: "O1",
      domain: "coremail-professional",
      text: "正式知识库未提及“星际量子邮件协议”，无法确认系统是否支持或兼容该协议。",
      kind: "fact",
      citationIndexes: [1],
      coveredAspectIds: ["A1"],
      support: "direct",
      evidenceIdentities: [reference.contentHash],
    };

    const outcomes = reduceReliableOutcomes({
      contract: boundaryContract,
      plans: [plan],
      retrievals: [retrievalResult],
      claims: [boundaryClaim],
      failedDomains: new Set(),
      verificationUnavailable: false,
      consensusRejectedObligationIds: new Set(),
    });

    expect(outcomes[0]).toMatchObject({
      state: "not_covered",
      claims: [boundaryClaim],
      gapReason: expect.stringContaining("正式知识只能证明未覆盖目标"),
    });

    const documentedBoundaryQuestion = "请说明星际量子邮件协议在正式知识中的边界。";
    const documentedBoundary = reduceReliableOutcomes({
      contract: {
        ...boundaryContract,
        sourceQuestion: documentedBoundaryQuestion,
        obligations: [{
          ...boundaryContract.obligations[0]!,
          sourceSpan: { start: 0, end: documentedBoundaryQuestion.length },
          sourceText: documentedBoundaryQuestion,
        }],
      },
      plans: [plan],
      retrievals: [retrievalResult],
      claims: [boundaryClaim],
      failedDomains: new Set(),
      verificationUnavailable: false,
      consensusRejectedObligationIds: new Set(),
    });
    expect(documentedBoundary[0]?.state).toBe("complete");
  });

  it("uses deterministic retrieval and one structured synthesis without a legacy agent loop", async () => {
    const { trace, events } = traceFixture();
    const fixture = pipelineFixture();

    const execution = await fixture.pipeline.answer({
      question: contract.sourceQuestion,
      scope: "professional",
      contract,
      plans: [plan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(execution.result).toMatchObject({
      status: "answered",
      knowledgeCoverage: "complete",
      policyDisposition: "allowed",
    });
    expect(execution.result.answer).toContain("支持邮件归档。[1]");
    expect(fixture.retrieval.retrieve).toHaveBeenCalledOnce();
    expect(fixture.synthesizer.draft).toHaveBeenCalledOnce();
    expect(events.filter((event) =>
      event.event === "model_call" && event.operation === "synthesize"))
      .toHaveLength(1);
    expect(execution.callBudget).toMatchObject({
      usedOpenEndedCalls: 1,
      usedStructuredCalls: 1,
    });
  });

  it("retries one ungoverned synthesis after an invalid structured payload", async () => {
    const { trace, events } = traceFixture();
    const fixture = pipelineFixture();
    vi.mocked(fixture.synthesizer.draft).mockRejectedValueOnce(
      new InvalidModelPayloadError("invalid_schema:claims:required"),
    );

    const execution = await fixture.pipeline.answer({
      question: contract.sourceQuestion,
      scope: "professional",
      contract,
      plans: [plan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(execution.result.status).toBe("answered");
    expect(fixture.synthesizer.draft).toHaveBeenCalledTimes(2);
    expect(events.filter((event) =>
      event.event === "model_call" && event.operation === "synthesize"))
      .toHaveLength(2);
    expect(execution.callBudget).toMatchObject({
      usedOpenEndedCalls: 2,
      usedStructuredCalls: 1,
    });
  });

  it("publishes an exact formal evidence excerpt after a low-risk transport failure", async () => {
    const { trace } = traceFixture();
    const fixture = pipelineFixture();
    vi.mocked(fixture.synthesizer.draft).mockRejectedValueOnce(
      new ModelUnavailableError("model_timeout"),
    );

    const execution = await fixture.pipeline.answer({
      question: contract.sourceQuestion,
      scope: "professional",
      contract,
      plans: [plan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(execution.result.status).toBe("answered");
    expect(execution.result.answer).toContain("正式资料说明支持邮件归档。[1]");
    expect(execution.result.references).toHaveLength(1);
    expect(fixture.synthesizer.draft).toHaveBeenCalledOnce();
    expect(execution.callBudget.usedOpenEndedCalls).toBe(1);
  });

  it("does not project an unreviewed evidence excerpt for a high-risk obligation", async () => {
    const { trace } = traceFixture();
    const fixture = pipelineFixture();
    vi.mocked(fixture.synthesizer.draft).mockRejectedValueOnce(
      new ModelUnavailableError("model_timeout"),
    );
    const highRiskContract: AtomicObligationContract = {
      ...contract,
      obligations: [{ ...contract.obligations[0]!, risk: "high" }],
    };

    const execution = await fixture.pipeline.answer({
      question: highRiskContract.sourceQuestion,
      scope: "professional",
      contract: highRiskContract,
      plans: [plan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(execution.result.status).toBe("temporarily_unavailable");
    expect(execution.result.references).toEqual([]);
    expect(fixture.synthesizer.draft).toHaveBeenCalledOnce();
  });

  it("performs at most one targeted revision for all rejected claims", async () => {
    const { trace } = traceFixture();
    const reviser: TargetedClaimReviser = {
      revise: vi.fn(async (revisionInput: Parameters<TargetedClaimReviser["revise"]>[0]) =>
        revisionInput.rejectedClaims.map((claim) => ({
        ...claim,
        text: "正式资料直接支持邮件归档。",
      }))),
    };
    const fixture = pipelineFixture({
      verifierVerdicts: ["insufficient", "supported"],
      reviser,
    });

    const execution = await fixture.pipeline.answer({
      question: contract.sourceQuestion,
      scope: "professional",
      contract,
      plans: [plan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(reviser.revise).toHaveBeenCalledOnce();
    expect(fixture.retrieval.retrieve).toHaveBeenCalledOnce();
    expect(fixture.synthesizer.draft).toHaveBeenCalledOnce();
    expect(fixture.verifier.verify).toHaveBeenCalledTimes(2);
    expect(execution.result.answer).toContain("正式资料直接支持邮件归档。[1]");
    expect(execution.callBudget).toEqual({
      maximumOpenEndedCalls: 3,
      usedOpenEndedCalls: 2,
      usedStructuredCalls: 2,
    });
  });

  it("publishes a fixed limitation when a high-risk claim lacks two-verdict agreement", async () => {
    const { trace } = traceFixture();
    const expectedClaim: BoundClaim = {
      claimId: "CL1",
      obligationId: "O1",
      domain: "coremail-professional",
      text: "支持邮件归档。",
      kind: "fact",
      citationIndexes: [1],
      coveredAspectIds: ["A1"],
      support: "direct",
      evidenceIdentities: [reference.contentHash],
    };
    const secondVerifier = {
      completeJson: vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) =>
        input.schema.parse({ verdicts: [{
          claimId: "CL1",
          claimHash: consensusClaimSignature(expectedClaim),
          citationIndexes: [1],
          verdict: "insufficient" as const,
        }] })),
      completeText: vi.fn(),
    } as unknown as ModelClient;
    const fixture = pipelineFixture({ secondVerifier });
    const highRiskContract: AtomicObligationContract = {
      ...contract,
      obligations: contract.obligations.map((obligation) => ({
        ...obligation,
        risk: "high" as const,
      })),
    };

    const execution = await fixture.pipeline.answer({
      question: highRiskContract.sourceQuestion,
      scope: "professional",
      contract: highRiskContract,
      plans: [plan],
      budget: new StageBudgetAllocator({ startedAt: Date.now() }),
      trace,
      signal: new AbortController().signal,
    });

    expect(secondVerifier.completeJson).toHaveBeenCalledOnce();
    expect(execution.result).toMatchObject({
      status: "partially_answered",
      knowledgeCoverage: "none",
      policyDisposition: "limited",
    });
    expect(execution.result.answer).toContain("高风险主张未通过双重一致性裁决");
    expect(execution.result.answer).not.toContain("支持邮件归档。[1]");
    expect(execution.callBudget.usedStructuredCalls).toBe(2);
  });
});
