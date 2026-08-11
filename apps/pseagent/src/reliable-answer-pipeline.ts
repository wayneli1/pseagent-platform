import { z } from "zod";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import { bindClaimsToEvidence, mergeBoundDomainClaims } from "./claim-evidence-graph.js";
import type { AnswerResult, FinalAction, Scope } from "./contracts.js";
import {
  DeterministicRetrievalCoordinator,
  type DeterministicRetrievalResult,
  type RetrievedEvidence,
} from "./deterministic-retrieval.js";
import { recordDiagnostic, type DiagnosticTrace } from "./diagnostics.js";
import type { DomainKnowledgePlan } from "./domain-plan.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
import type { KnowledgeSession } from "./knowledge-session.js";
import {
  HighRiskConsensusGate,
  type HighRiskConsensusResult,
} from "./high-risk-consensus.js";
import type { ModelClient } from "./model-client.js";
import { observeModelCall } from "./model-observability.js";
import {
  type ObligationOutcome,
} from "./obligation-outcome.js";
import { formatKnowledgeFinal } from "./response.js";
import type { StageBudgetAllocator } from "./stage-budget.js";
import {
  hashClaimText,
  type BoundClaim,
  type ClaimDraft,
  type ClaimSupportDecision,
  type ModelClaimSupportVerifier,
  type ModelStructuredClaimSynthesizer,
} from "./structured-claim.js";
import type { KnowledgeDomain } from "./task-spec.js";

export const PSE_MAX_OPEN_ENDED_CALLS = 3;

export interface ModelCallBudgetSnapshot {
  readonly maximumOpenEndedCalls: number;
  readonly usedOpenEndedCalls: number;
  readonly usedStructuredCalls: number;
}

export interface TargetedClaimReviser {
  revise(input: {
    readonly rejectedClaims: readonly ClaimDraft[];
    readonly evidence: readonly RetrievedEvidence[];
    readonly contract: AtomicObligationContract;
    readonly signal: AbortSignal;
  }): Promise<readonly ClaimDraft[]>;
}

export interface ReliableAnswerPipelineResult {
  readonly result: AnswerResult;
  readonly domainsUsed: readonly KnowledgeDomain[];
  readonly evidenceLedgers: readonly EvidenceLedger[];
  readonly outcomes: readonly ObligationOutcome[];
  readonly callBudget: ModelCallBudgetSnapshot;
}

export interface ReliableAnswerPipeline {
  answer(input: {
    readonly question: string;
    readonly scope: Exclude<Scope, "normal">;
    readonly contract: AtomicObligationContract;
    readonly plans: readonly DomainKnowledgePlan[];
    readonly budget: StageBudgetAllocator;
    readonly trace: DiagnosticTrace;
    readonly signal: AbortSignal;
  }): Promise<ReliableAnswerPipelineResult>;
}

interface RetrievalCoordinator {
  retrieve(input: {
    readonly plan: DomainKnowledgePlan;
    readonly session: KnowledgeSession;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
    readonly trace: DiagnosticTrace;
  }): Promise<DeterministicRetrievalResult>;
}

interface KnowledgeFactory {
  open(scope: Exclude<Scope, "normal">, signal?: AbortSignal): Promise<KnowledgeSession>;
}

interface StructuredClaimSynthesizer {
  draft: ModelStructuredClaimSynthesizer["draft"];
}

interface ClaimSupportVerifier {
  verify: ModelClaimSupportVerifier["verify"];
}

export class DeterministicReliableAnswerPipeline implements ReliableAnswerPipeline {
  private readonly maximumOpenEndedCalls: number;

  constructor(private readonly dependencies: {
    readonly knowledge: KnowledgeFactory;
    readonly retrieval?: RetrievalCoordinator;
    readonly synthesizer: StructuredClaimSynthesizer;
    readonly verifier: ClaimSupportVerifier;
    readonly targetedReviser?: TargetedClaimReviser;
    readonly highRiskConsensus?: {
      readonly gate: HighRiskConsensusGate;
      readonly firstVerifier: ModelClient;
      readonly secondVerifier: ModelClient;
      readonly firstModelId: string;
      readonly secondModelId: string;
    };
    readonly maximumOpenEndedCalls?: number;
  }) {
    this.maximumOpenEndedCalls = dependencies.maximumOpenEndedCalls ?? PSE_MAX_OPEN_ENDED_CALLS;
    if (!Number.isSafeInteger(this.maximumOpenEndedCalls) || this.maximumOpenEndedCalls < 1) {
      throw new Error("model_call_budget_invalid");
    }
  }

  async answer(input: {
    readonly question: string;
    readonly scope: Exclude<Scope, "normal">;
    readonly contract: AtomicObligationContract;
    readonly plans: readonly DomainKnowledgePlan[];
    readonly budget: StageBudgetAllocator;
    readonly trace: DiagnosticTrace;
    readonly signal: AbortSignal;
  }): Promise<ReliableAnswerPipelineResult> {
    const calls = new ModelCallBudget(this.maximumOpenEndedCalls);
    const retrievalCoordinator = this.dependencies.retrieval ??
      new DeterministicRetrievalCoordinator();
    const retrievalStartedAt = Date.now();
    const retrievalSignal = input.budget.signal("retrieval", input.signal);
    const retrievalSettled = await Promise.allSettled(input.plans.map(async (plan) => {
      const session = await this.dependencies.knowledge.open(plan.scope, retrievalSignal);
      const retrieval = await retrievalCoordinator.retrieve({
        plan,
        session,
        deadlineAt: input.budget.deadlineAt("retrieval"),
        signal: retrievalSignal,
        trace: input.trace,
      });
      return { plan, retrieval };
    }));
    const retrieved = retrievalSettled.flatMap((item) =>
      item.status === "fulfilled" ? [item.value] : []);
    recordStage(input, "retrieval", retrievalStartedAt, retrieved.length === input.plans.length
      ? "completed"
      : retrievalSignal.aborted ? "timeout" : "degraded");

    const mergedReferences = mergeBoundDomainClaims({
      domains: retrieved.map(({ retrieval }) => ({
        claims: [],
        references: retrieval.references,
      })),
    }).references;
    const globalized = globalizeRetrievals(retrieved.map((item) => item.retrieval), mergedReferences);

    const draftStartedAt = Date.now();
    const draftSignal = input.budget.signal("claim_draft", input.signal);
    const draftSettled = await Promise.allSettled(retrieved.map(async ({ plan, retrieval }) => {
      calls.useOpenEnded("synthesize");
      const drafts = await observeModelCall({
        trace: input.trace,
        role: "synthesizer",
        operation: "synthesize",
        signal: draftSignal,
        call: () => this.dependencies.synthesizer.draft({
          contract: input.contract,
          retrieval,
          signal: draftSignal,
        }),
      });
      return { domain: plan.domain, drafts };
    }));
    const localDraftGroups = draftSettled.flatMap((item) =>
      item.status === "fulfilled" ? [item.value] : []);
    recordStage(input, "claim_draft", draftStartedAt,
      draftSettled.every((item) => item.status === "fulfilled")
        ? "completed"
        : draftSignal.aborted ? "timeout" : "degraded");

    const globalDrafts = globalizeDrafts(localDraftGroups, globalized.localToGlobal);
    const firstBinding = bindClaimsToEvidence({
      claims: globalDrafts,
      contract: input.contract,
      retrievals: globalized.retrievals,
    });
    const firstVerificationStartedAt = Date.now();
    const verificationSignal = input.budget.signal("verification_consensus", input.signal);
    let finalConsensusSignal = verificationSignal;
    let verificationUnavailable = false;
    let firstDecisions: readonly ClaimSupportDecision[] = [];
    if (firstBinding.retained.length > 0) {
      try {
        calls.useStructured();
        firstDecisions = await observeModelCall({
          trace: input.trace,
          role: "verifier",
          operation: "verify",
          signal: verificationSignal,
          call: () => this.dependencies.verifier.verify({
            claims: firstBinding.retained,
            evidence: globalized.evidence,
            signal: verificationSignal,
          }),
        });
      } catch {
        verificationUnavailable = true;
      }
    }
    const initiallyAccepted = supportedClaims(firstBinding.retained, firstDecisions);
    const acceptedIds = new Set(initiallyAccepted.map((claim) => claim.claimId));
    const rejectedIds = new Set([
      ...firstBinding.rejected.map((reason) => reason.split(":", 1)[0]!),
      ...firstBinding.retained
        .filter((claim) => !acceptedIds.has(claim.claimId))
        .map((claim) => claim.claimId),
    ]);
    recordStage(input, "verification_consensus", firstVerificationStartedAt,
      verificationUnavailable
        ? verificationSignal.aborted ? "timeout" : "degraded"
        : "completed");

    let revisedAccepted: readonly BoundClaim[] = [];
    let revisedDecisions: readonly ClaimSupportDecision[] = [];
    const rejectedDrafts = globalDrafts.filter((claim) => rejectedIds.has(claim.claimId));
    if (
      rejectedDrafts.length > 0 &&
      !verificationUnavailable &&
      this.dependencies.targetedReviser !== undefined &&
      calls.hasOpenEndedCapacity()
    ) {
      const revisionStartedAt = Date.now();
      const revisionSignal = input.budget.signal("targeted_revision", input.signal);
      finalConsensusSignal = revisionSignal;
      try {
        calls.useOpenEnded("targeted_claim_revision");
        const allowedObligations = new Set(rejectedDrafts.map((claim) => claim.obligationId));
        const revisedDrafts = await observeModelCall({
          trace: input.trace,
          role: "synthesizer",
          operation: "targeted_claim_revision",
          signal: revisionSignal,
          call: () => this.dependencies.targetedReviser!.revise({
            rejectedClaims: rejectedDrafts,
            evidence: globalized.evidence.filter((item) =>
              allowedObligations.has(item.obligationId as `O${number}`)),
            contract: input.contract,
            signal: revisionSignal,
          }),
        });
        validateTargetedRevision(rejectedIds, revisedDrafts);
        const revisedBinding = bindClaimsToEvidence({
          claims: revisedDrafts,
          contract: input.contract,
          retrievals: globalized.retrievals,
        });
        if (revisedBinding.retained.length > 0) {
          calls.useStructured();
          revisedDecisions = await observeModelCall({
            trace: input.trace,
            role: "verifier",
            operation: "verify",
            signal: revisionSignal,
            call: () => this.dependencies.verifier.verify({
              claims: revisedBinding.retained,
              evidence: globalized.evidence,
              signal: revisionSignal,
            }),
          });
          revisedAccepted = supportedClaims(revisedBinding.retained, revisedDecisions);
        }
        recordStage(input, "targeted_revision", revisionStartedAt, "completed");
      } catch {
        recordStage(input, "targeted_revision", revisionStartedAt,
          revisionSignal.aborted ? "timeout" : "degraded");
      }
    }

    const consensusCandidates = stableClaims([
      ...initiallyAccepted,
      ...revisedAccepted,
    ]);
    const highRiskObligationIds = new Set(input.contract.obligations
      .filter((obligation) => obligation.risk === "high")
      .map((obligation) => obligation.id));
    const highRiskClaims = consensusCandidates.filter((claim) =>
      highRiskObligationIds.has(claim.obligationId));
    let consensusResult: HighRiskConsensusResult | undefined;
    if (highRiskClaims.length > 0) {
      if (this.dependencies.highRiskConsensus === undefined) {
        consensusResult = Object.freeze({
          mode: "repeated_same_model",
          retainedClaimIds: Object.freeze([]),
          rejectedClaimIds: Object.freeze(highRiskClaims.map((claim) => claim.claimId)),
          agreed: false,
        });
      } else {
        calls.useStructured();
        consensusResult = await this.dependencies.highRiskConsensus.gate.evaluate({
          claims: highRiskClaims,
          firstVerdicts: [...firstDecisions, ...revisedDecisions],
          evidence: globalized.evidence,
          firstVerifier: this.dependencies.highRiskConsensus.firstVerifier,
          secondVerifier: this.dependencies.highRiskConsensus.secondVerifier,
          firstModelId: this.dependencies.highRiskConsensus.firstModelId,
          secondModelId: this.dependencies.highRiskConsensus.secondModelId,
          signal: finalConsensusSignal,
          trace: input.trace,
        });
      }
      recordDiagnostic(input.trace, {
        event: "high_risk_consensus",
        mode: consensusResult.mode,
        claimCount: highRiskClaims.length,
        retainedCount: consensusResult.retainedClaimIds.length,
        rejectedCount: consensusResult.rejectedClaimIds.length,
        agreed: consensusResult.agreed,
      });
    }
    const consensusRetainedIds = new Set(consensusResult?.retainedClaimIds ?? []);
    const consensusRejectedIds = new Set(consensusResult?.rejectedClaimIds ?? []);
    const finalClaims = stableClaims(consensusCandidates.filter((claim) =>
      !highRiskObligationIds.has(claim.obligationId) || consensusRetainedIds.has(claim.claimId)));
    const consensusRejectedObligationIds = new Set(consensusCandidates
      .filter((claim) => consensusRejectedIds.has(claim.claimId))
      .map((claim) => claim.obligationId));
    const failedDomains = new Set(input.plans
      .filter((_plan, index) => retrievalSettled[index]?.status !== "fulfilled")
      .map((plan) => plan.domain));
    const draftFailedDomains = new Set(retrieved
      .filter((_item, index) => draftSettled[index]?.status !== "fulfilled")
      .map((item) => item.plan.domain));
    const outcomes = reduceToOutcomes({
      contract: input.contract,
      plans: input.plans,
      retrievals: globalized.retrievals,
      claims: finalClaims,
      failedDomains: new Set([...failedDomains, ...draftFailedDomains]),
      verificationUnavailable,
      consensusRejectedObligationIds,
    });
    const finalizationStartedAt = Date.now();
    const result = formatKnowledgeFinal(
      input.scope,
      emptyFinalAction(),
      mergedReferences,
      {
        obligationContract: input.contract,
        obligationOutcomes: outcomes,
      },
    );
    recordStage(input, "finalization", finalizationStartedAt, "completed");
    const callBudget = calls.snapshot();
    recordDiagnostic(input.trace, { event: "model_call_budget", ...callBudget });
    return Object.freeze({
      result,
      domainsUsed: Object.freeze(input.plans.map((plan) => plan.domain)),
      evidenceLedgers: Object.freeze(globalized.retrievals.map((item) => item.evidenceLedger)),
      outcomes: Object.freeze(outcomes),
      callBudget,
    });
  }
}

const targetedClaimListSchema = z.array(z.object({
  claimId: z.string().regex(/^CL[1-9]\d*$/u).transform((value) => value as `CL${number}`),
  obligationId: z.string().regex(/^O[1-9]\d*$/u).transform((value) => value as `O${number}`),
  domain: z.enum(["coremail-professional", "presales-general"]),
  text: z.string().trim().min(1).max(2_000).refine((value) => !/\[\d+\]/u.test(value)),
  kind: z.enum(["fact", "method", "boundary", "gap"]),
  citationIndexes: z.array(z.number().int().positive()).max(6),
  coveredAspectIds: z.array(z.string().regex(/^A[1-9]\d*$/u)).max(8),
}).strict()).min(1).max(18);

export class ModelTargetedClaimReviser implements TargetedClaimReviser {
  constructor(private readonly model: ModelClient) {}

  async revise(input: {
    readonly rejectedClaims: readonly ClaimDraft[];
    readonly evidence: readonly RetrievedEvidence[];
    readonly contract: AtomicObligationContract;
    readonly signal: AbortSignal;
  }): Promise<readonly ClaimDraft[]> {
    return await this.model.completeJson({
      messages: [
        {
          role: "system",
          content: "仅修订给出的不合格主张。claimId、obligationId 和 domain 必须原样保留；只能使用给出的证据及其 citation，不得改写已通过主张，不得补充新主张。只输出 JSON 数组，text 中禁止写 [n] 引用。",
        },
        {
          role: "user",
          content: JSON.stringify({
            rejectedClaims: input.rejectedClaims,
            obligations: input.contract.obligations.filter((obligation) =>
              input.rejectedClaims.some((claim) => claim.obligationId === obligation.id)),
            allowedEvidence: input.evidence,
          }),
        },
      ],
      schema: targetedClaimListSchema,
      schemaDescription: "pse_targeted_claim_revision",
      signal: input.signal,
    });
  }
}

class ModelCallBudget {
  private usedOpenEndedCalls = 0;
  private usedStructuredCalls = 0;

  constructor(private readonly maximumOpenEndedCalls: number) {}

  hasOpenEndedCapacity(): boolean {
    return this.usedOpenEndedCalls < this.maximumOpenEndedCalls;
  }

  useOpenEnded(operation: string): void {
    if (!this.hasOpenEndedCapacity()) {
      throw new Error(`open_ended_model_call_budget_exhausted:${operation}`);
    }
    this.usedOpenEndedCalls += 1;
  }

  useStructured(): void {
    this.usedStructuredCalls += 1;
  }

  snapshot(): ModelCallBudgetSnapshot {
    return Object.freeze({
      maximumOpenEndedCalls: this.maximumOpenEndedCalls,
      usedOpenEndedCalls: this.usedOpenEndedCalls,
      usedStructuredCalls: this.usedStructuredCalls,
    });
  }
}

function globalizeRetrievals(
  retrievals: readonly DeterministicRetrievalResult[],
  references: readonly DeterministicRetrievalResult["references"][number][],
): {
  readonly retrievals: readonly DeterministicRetrievalResult[];
  readonly evidence: readonly RetrievedEvidence[];
  readonly localToGlobal: ReadonlyMap<string, number>;
} {
  const globalByIdentity = new Map(references.map((reference) =>
    [referenceIdentity(reference), reference.index] as const));
  const localToGlobal = new Map<string, number>();
  const mapped = retrievals.map((retrieval) => {
    for (const reference of retrieval.references) {
      const globalIndex = globalByIdentity.get(referenceIdentity(reference));
      if (globalIndex === undefined) throw new Error("global_reference_mapping_missing");
      localToGlobal.set(localCitationKey(retrieval.project, reference.index), globalIndex);
    }
    const evidence = retrieval.evidence.map((item) => {
      const citation = localToGlobal.get(localCitationKey(item.domain, item.citation));
      if (citation === undefined) throw new Error("global_evidence_mapping_missing");
      return Object.freeze({ ...item, citation });
    });
    return Object.freeze({
      ...retrieval,
      evidence: Object.freeze(evidence),
      references: Object.freeze(references.filter((reference) =>
        reference.project === retrieval.project)),
    });
  });
  return Object.freeze({
    retrievals: Object.freeze(mapped),
    evidence: Object.freeze(mapped.flatMap((item) => item.evidence)),
    localToGlobal,
  });
}

function globalizeDrafts(
  groups: readonly { readonly domain: KnowledgeDomain; readonly drafts: readonly ClaimDraft[] }[],
  localToGlobal: ReadonlyMap<string, number>,
): readonly ClaimDraft[] {
  const drafts: ClaimDraft[] = [];
  for (const group of groups) {
    for (const draft of group.drafts) {
      drafts.push(Object.freeze({
        ...draft,
        claimId: `CL${drafts.length + 1}`,
        citationIndexes: Object.freeze(draft.citationIndexes.map((citation) =>
          localToGlobal.get(localCitationKey(group.domain, citation)) ?? citation)),
      }));
    }
  }
  return Object.freeze(drafts);
}

function supportedClaims(
  claims: readonly BoundClaim[],
  decisions: readonly ClaimSupportDecision[],
): readonly BoundClaim[] {
  const decisionById = new Map(decisions.map((decision) => [decision.claimId, decision]));
  return Object.freeze(claims.filter((claim) => {
    const decision = decisionById.get(claim.claimId);
    return decision?.verdict === "supported" &&
      decision.claimHash === hashClaimText(claim.text) &&
      sameNumbers(decision.citationIndexes, claim.citationIndexes);
  }));
}

function validateTargetedRevision(
  rejectedIds: ReadonlySet<string>,
  revised: readonly ClaimDraft[],
): void {
  const seen = new Set<string>();
  for (const claim of revised) {
    if (!rejectedIds.has(claim.claimId)) throw new Error("targeted_revision_claim_not_rejected");
    if (seen.has(claim.claimId)) throw new Error("targeted_revision_claim_duplicate");
    seen.add(claim.claimId);
  }
}

function reduceToOutcomes(input: {
  readonly contract: AtomicObligationContract;
  readonly plans: readonly DomainKnowledgePlan[];
  readonly retrievals: readonly DeterministicRetrievalResult[];
  readonly claims: readonly BoundClaim[];
  readonly failedDomains: ReadonlySet<KnowledgeDomain>;
  readonly verificationUnavailable: boolean;
  readonly consensusRejectedObligationIds: ReadonlySet<string>;
}): readonly ObligationOutcome[] {
  return Object.freeze(input.contract.obligations.map((obligation) => {
    const claims = input.claims.filter((claim) => claim.obligationId === obligation.id);
    const units = input.retrievals.flatMap((retrieval) => retrieval.evidenceLedger.units)
      .filter((unit) => unit.binding.obligationId === obligation.id);
    const requiredDomains = new Set(input.plans
      .filter((plan) => plan.bindings.some((binding) => binding.obligationId === obligation.id))
      .map((plan) => plan.domain));
    const domainFailed = [...requiredDomains].some((domain) => input.failedDomains.has(domain));
    const missingInput = units.some((unit) => unit.inputState === "missing");
    const allComplete = requiredDomains.size > 0 &&
      !domainFailed &&
      units.length >= requiredDomains.size &&
      units.every((unit) =>
        unit.verification.coverage === "complete" &&
        unit.requirement.evidenceAspects.every((aspect) =>
          claims.some((claim) =>
            claim.domain === unit.binding.domain &&
            claim.coveredAspectIds.includes(aspect.id))));
    if (input.consensusRejectedObligationIds.has(obligation.id)) {
      return Object.freeze({
        obligationId: obligation.id,
        state: "policy_blocked" as const,
        claims: Object.freeze(claims),
        gapReason: "高风险主张未通过双重一致性裁决，不能作为正式结论发布。",
      });
    }
    if (missingInput) {
      return Object.freeze({
        obligationId: obligation.id,
        state: "missing_input" as const,
        claims: Object.freeze(claims),
        gapReason: "缺少完成该义务所需的客户事实。",
      });
    }
    if (claims.length > 0) {
      return Object.freeze({
        obligationId: obligation.id,
        state: allComplete ? "complete" as const : "partial" as const,
        claims: Object.freeze(claims),
        ...(allComplete ? {} : { gapReason: "仅有部分义务证据通过验证。" }),
      });
    }
    if (domainFailed || input.verificationUnavailable) {
      return Object.freeze({
        obligationId: obligation.id,
        state: "unavailable" as const,
        claims: Object.freeze([]),
      });
    }
    return Object.freeze({
      obligationId: obligation.id,
      state: "not_covered" as const,
      claims: Object.freeze([]),
    });
  }));
}

function stableClaims(claims: readonly BoundClaim[]): readonly BoundClaim[] {
  const byId = new Map(claims.map((claim) => [claim.claimId, claim] as const));
  return Object.freeze([...byId.values()].sort((left, right) =>
    Number(left.claimId.slice(2)) - Number(right.claimId.slice(2))));
}

function emptyFinalAction(): FinalAction {
  return {
    action: "final",
    requirements: [{ id: "R1", coverage: "none", answer: "", citations: [] }],
    citations: [],
  };
}

function recordStage(
  input: {
    readonly budget: StageBudgetAllocator;
    readonly trace: DiagnosticTrace;
  },
  stage: Parameters<StageBudgetAllocator["remainingMs"]>[0],
  startedAt: number,
  result: "completed" | "degraded" | "timeout" | "cancelled",
): void {
  recordDiagnostic(input.trace, {
    event: "stage_budget",
    stage,
    result,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    remainingMs: input.budget.remainingMs(stage),
  });
}

function referenceIdentity(reference: {
  readonly project: string;
  readonly path: string;
  readonly revision: string;
  readonly contentHash: string;
}): string {
  return [reference.project, reference.path, reference.revision, reference.contentHash].join("\u0000");
}

function localCitationKey(domain: string, citation: number): string {
  return `${domain}\u0000${citation}`;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
