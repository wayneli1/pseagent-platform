import { describe, expect, it, vi } from "vitest";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type { DiagnosticEvent, DiagnosticTrace } from "./diagnostics.js";
import type { DeterministicRetrievalResult } from "./deterministic-retrieval.js";
import type { DomainKnowledgePlan } from "./domain-plan.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import {
  DeterministicReliableAnswerPipeline,
  type TargetedClaimReviser,
} from "./reliable-answer-pipeline.js";
import { StageBudgetAllocator } from "./stage-budget.js";
import { hashClaimText } from "./structured-claim.js";

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
  });
  return { pipeline, knowledge, retrieval, synthesizer, verifier };
}

describe("deterministic reliable answer pipeline", () => {
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
});
