import { createHash } from "node:crypto";
import { z } from "zod";
import type { RetrievedEvidence } from "./deterministic-retrieval.js";
import type { DiagnosticTrace } from "./diagnostics.js";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { observeModelCall } from "./model-observability.js";
import { structuredTransformationInput } from "./structured-model-input.js";
import {
  hashClaimText,
  type BoundClaim,
  type ClaimSupportDecision,
  type ClaimSupportVerdict,
} from "./structured-claim.js";

export interface ConsensusVerdict {
  readonly claimId: string;
  readonly claimHash: string;
  readonly citationIndexes: readonly number[];
  readonly verdict: ClaimSupportVerdict;
}

export interface HighRiskConsensusResult {
  readonly mode: "independent_models" | "repeated_same_model";
  readonly retainedClaimIds: readonly string[];
  readonly rejectedClaimIds: readonly string[];
  readonly agreed: boolean;
}

const consensusVerdictSchema = z.object({
  claimId: z.string().regex(/^CL[1-9]\d*$/u),
  claimHash: z.string().regex(/^[a-f0-9]{64}$/u),
  citationIndexes: z.array(z.number().int().positive()).max(6),
  verdict: z.enum(["supported", "contradicted", "insufficient"]),
}).strict();

const consensusVerdictListSchema = z.array(consensusVerdictSchema).min(1).max(18);
const consensusVerdictEnvelopeSchema = z.object({
  verdicts: consensusVerdictListSchema,
}).strict();

export class HighRiskConsensusGate {
  async evaluate(input: {
    readonly claims: readonly BoundClaim[];
    readonly firstVerdicts?: readonly ClaimSupportDecision[];
    readonly evidence?: readonly RetrievedEvidence[];
    readonly firstVerifier: ModelClient;
    readonly secondVerifier: ModelClient;
    readonly firstModelId: string;
    readonly secondModelId: string;
    readonly signal: AbortSignal;
    readonly trace?: DiagnosticTrace;
    readonly onModelAttempt?: () => void;
  }): Promise<HighRiskConsensusResult> {
    const mode = input.firstModelId === input.secondModelId
      ? "repeated_same_model" as const
      : "independent_models" as const;
    if (input.claims.length === 0) {
      return Object.freeze({
        mode,
        retainedClaimIds: Object.freeze([]),
        rejectedClaimIds: Object.freeze([]),
        agreed: true,
      });
    }
    const rejectAll = (): HighRiskConsensusResult => Object.freeze({
      mode,
      retainedClaimIds: Object.freeze([]),
      rejectedClaimIds: Object.freeze(input.claims.map((claim) => claim.claimId)),
      agreed: false,
    });
    try {
      const first = input.firstVerdicts === undefined
        ? await requestConsensusVerdictsWithSchemaRetry({
            model: input.firstVerifier,
            role: "verifier",
            operation: "verify",
            claims: input.claims,
            evidence: input.evidence ?? [],
            signal: input.signal,
            ...(input.trace === undefined ? {} : { trace: input.trace }),
            ...(input.onModelAttempt === undefined
              ? {}
              : { onModelAttempt: input.onModelAttempt }),
          })
        : firstConsensusVerdicts(input.claims, input.firstVerdicts);
      const second = await requestConsensusVerdictsWithSchemaRetry({
        model: input.secondVerifier,
        role: "consensus_verifier",
        operation: "consensus_verify",
        claims: input.claims,
        evidence: input.evidence ?? [],
        signal: input.signal,
        ...(input.trace === undefined ? {} : { trace: input.trace }),
        ...(input.onModelAttempt === undefined
          ? {}
          : { onModelAttempt: input.onModelAttempt }),
      });
      const firstById = new Map(first.map((verdict) => [verdict.claimId, verdict]));
      const secondById = new Map(second.map((verdict) => [verdict.claimId, verdict]));
      const retainedClaimIds: string[] = [];
      const rejectedClaimIds: string[] = [];
      for (const claim of input.claims) {
        const expectedHash = consensusClaimSignature(claim);
        const firstVerdict = firstById.get(claim.claimId);
        const secondVerdict = secondById.get(claim.claimId);
        const agreed = firstVerdict?.verdict === "supported" &&
          secondVerdict?.verdict === "supported" &&
          firstVerdict.claimHash === expectedHash &&
          secondVerdict.claimHash === expectedHash &&
          sameNumbers(firstVerdict.citationIndexes, claim.citationIndexes) &&
          sameNumbers(secondVerdict.citationIndexes, claim.citationIndexes);
        (agreed ? retainedClaimIds : rejectedClaimIds).push(claim.claimId);
      }
      return Object.freeze({
        mode,
        retainedClaimIds: Object.freeze(retainedClaimIds),
        rejectedClaimIds: Object.freeze(rejectedClaimIds),
        agreed: rejectedClaimIds.length === 0,
      });
    } catch {
      return rejectAll();
    }
  }
}

async function requestConsensusVerdictsWithSchemaRetry(input: {
  readonly model: ModelClient;
  readonly role: "verifier" | "consensus_verifier";
  readonly operation: "verify" | "consensus_verify";
  readonly claims: readonly BoundClaim[];
  readonly evidence: readonly RetrievedEvidence[];
  readonly signal: AbortSignal;
  readonly trace?: DiagnosticTrace;
  readonly onModelAttempt?: () => void;
}): Promise<readonly ConsensusVerdict[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    input.onModelAttempt?.();
    try {
      return await requestConsensusVerdicts(input);
    } catch (error) {
      if (
        attempt > 0 ||
        input.signal.aborted ||
        !(error instanceof InvalidModelPayloadError)
      ) {
        throw error;
      }
    }
  }
  throw new Error("consensus_schema_retry_exhausted");
}

export function consensusClaimSignature(claim: BoundClaim): string {
  const normalizedText = claim.text.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, " ")
    .trim();
  const citationIdentities = [...new Set(claim.evidenceIdentities)].sort();
  return createHash("sha256")
    .update(JSON.stringify({ normalizedText, citationIdentities }), "utf8")
    .digest("hex");
}

function firstConsensusVerdicts(
  claims: readonly BoundClaim[],
  decisions: readonly ClaimSupportDecision[],
): readonly ConsensusVerdict[] {
  const byId = new Map(decisions.map((decision) => [decision.claimId, decision]));
  return Object.freeze(claims.map((claim) => {
    const decision = byId.get(claim.claimId);
    const valid = decision !== undefined &&
      decision.claimHash === hashClaimText(claim.text) &&
      sameNumbers(decision.citationIndexes, claim.citationIndexes);
    return Object.freeze({
      claimId: claim.claimId,
      claimHash: consensusClaimSignature(claim),
      citationIndexes: Object.freeze([...claim.citationIndexes]),
      verdict: valid ? decision.verdict : "insufficient",
    });
  }));
}

async function requestConsensusVerdicts(input: {
  readonly model: ModelClient;
  readonly role: "verifier" | "consensus_verifier";
  readonly operation: "verify" | "consensus_verify";
  readonly claims: readonly BoundClaim[];
  readonly evidence: readonly RetrievedEvidence[];
  readonly signal: AbortSignal;
  readonly trace?: DiagnosticTrace;
}): Promise<readonly ConsensusVerdict[]> {
  const expectedIds = new Set<string>(input.claims.map((claim) => claim.claimId));
  const raw = await raceWithSignal(() => observeModelCall({
    trace: input.trace,
    role: input.role,
    operation: input.operation,
    signal: input.signal,
    call: () => input.model.completeJson({
      messages: [
        {
          role: "system",
          content: "你是高风险主张的独立证据裁决器。禁止复述或原样返回输入，顶层不能出现 claims 或 evidence。只判断每条主张是否被指定正式证据直接支持，不得改写主张或改变引用。claimId、claimHash、citationIndexes 必须原样返回。只输出根对象 {\"verdicts\":[...]}，每项严格包含 claimId、claimHash、citationIndexes、verdict。",
        },
        {
          role: "user",
          content: structuredTransformationInput("verdicts", {
            claims: input.claims.map((claim) => ({
              claimId: claim.claimId,
              claimHash: consensusClaimSignature(claim),
              citationIndexes: claim.citationIndexes,
              obligationId: claim.obligationId,
              domain: claim.domain,
              text: claim.text,
            })),
            evidence: input.evidence.map((item) => ({
              obligationId: item.obligationId,
              domain: item.domain,
              citation: item.citation,
              title: item.title,
              compactContent: item.compactContent,
              aspectIds: item.aspectIds,
              sourceBoundary: item.sourceBoundary,
            })),
          }),
        },
      ],
      schema: consensusVerdictEnvelopeSchema,
      schemaDescription: "pse_high_risk_consensus_verdicts",
      signal: input.signal,
    }),
  }), input.signal);
  const verdicts = raw.verdicts;
  if (
    verdicts.length !== input.claims.length ||
    new Set(verdicts.map((verdict) => verdict.claimId)).size !== verdicts.length ||
    verdicts.some((verdict) => !expectedIds.has(verdict.claimId))
  ) {
    throw new Error("consensus_verdict_identity_mismatch");
  }
  return Object.freeze(verdicts.map((verdict) => Object.freeze({
    ...verdict,
    citationIndexes: Object.freeze(verdict.citationIndexes),
  })));
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function raceWithSignal<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const promise = call();
  let removeAbortListener: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("consensus_verifier_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeAbortListener();
  }
}
