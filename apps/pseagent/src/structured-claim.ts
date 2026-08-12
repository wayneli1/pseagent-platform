import { createHash } from "node:crypto";
import { z } from "zod";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type {
  DeterministicRetrievalResult,
  RetrievedEvidence,
} from "./deterministic-retrieval.js";
import {
  InvalidModelPayloadError,
  type ModelClient,
} from "./model-client.js";
import type { KnowledgeDomain } from "./task-spec.js";
import { structuredTransformationInput } from "./structured-model-input.js";

export interface ClaimDraft {
  readonly claimId: `CL${number}`;
  readonly obligationId: `O${number}`;
  readonly domain: KnowledgeDomain;
  readonly text: string;
  readonly kind: "fact" | "method" | "boundary" | "gap";
  readonly citationIndexes: readonly number[];
  readonly coveredAspectIds: readonly string[];
}

export interface BoundClaim extends ClaimDraft {
  readonly support: "direct" | "synthesized" | "gap";
  readonly evidenceIdentities: readonly string[];
}

export type ClaimSupportVerdict = "supported" | "contradicted" | "insufficient";

export interface ClaimSupportDecision {
  readonly claimId: string;
  readonly claimHash: string;
  readonly citationIndexes: readonly number[];
  readonly verdict: ClaimSupportVerdict;
}

const claimDraftSchema = z.object({
  claimId: z.string().regex(/^CL[1-9]\d*$/u).transform((value) => value as `CL${number}`),
  obligationId: z.string().regex(/^O[1-9]\d*$/u).transform((value) => value as `O${number}`),
  domain: z.enum(["coremail-professional", "presales-general"]),
  text: z.string().trim().min(1).max(2_000)
    .refine((value) => !/\[\d+\]/u.test(value), "rendered_citation_forbidden"),
  kind: z.enum(["fact", "method", "boundary", "gap"]),
  citationIndexes: z.array(z.number().int().positive()).max(6),
  coveredAspectIds: z.array(z.string().regex(/^A[1-9]\d*$/u)).max(8),
});

const claimDraftListSchema = z.array(claimDraftSchema).min(1).max(18);
const claimDraftEnvelopeSchema = z.object({
  claims: claimDraftListSchema,
});

const supportDecisionSchema = z.object({
  claimId: z.string().regex(/^CL[1-9]\d*$/u),
  claimHash: z.string().regex(/^[a-f0-9]{64}$/u),
  citationIndexes: z.array(z.number().int().positive()).max(6),
  verdict: z.enum(["supported", "contradicted", "insufficient"]),
});

const supportDecisionListSchema = z.array(supportDecisionSchema).min(1).max(18);
const supportDecisionEnvelopeSchema = z.object({
  decisions: supportDecisionListSchema,
});

const CLAIM_DRAFT_PROMPT = `你根据已读取的正式证据，为每个原子义务生成最小、独立的结构化主张。
禁止复述或原样返回输入。只输出根对象 {"claims":[...]}，顶层不能出现 obligations 或 evidence。
每项严格包含 claimId、obligationId、domain、text、kind、citationIndexes、coveredAspectIds；示例：{"claims":[{"claimId":"CL1","obligationId":"O1","domain":"coremail-professional","text":"证据支持的主张","kind":"fact","citationIndexes":[1],"coveredAspectIds":["A1"]}]}。
text 中禁止写 [1] 之类引用标记；引用只放 citationIndexes。
不得跨义务或跨知识域借用证据，不得扩展证据没有支持的数字、版本、承诺或边界。
资料不足时生成 kind=gap 的明确缺口主张，citationIndexes 为空。`;

const CLAIM_VERIFY_PROMPT = `你是主张支持度裁判，只判断给定主张是否被指定证据支持。
禁止复述或原样返回输入，顶层不能出现 claims 或 evidence。不得改写主张，不得增加引用。
每条主张输出 supported、contradicted 或 insufficient。claimId、claimHash 和 citationIndexes 必须原样返回。
只输出根对象 {"decisions":[...]}，每项严格包含 claimId、claimHash、citationIndexes、verdict。`;

const CLAIM_ASPECT_GUIDANCE = `输入证据的 aspectRequirements 给出该证据应核对的覆盖语义。非 gap 主张应在 compactContent 确实支持时明确覆盖相应 label 或 terms，并把对应 id 放入 coveredAspectIds；aspectRequirements 只说明核对目标，不能替代证据正文。`;

export class ModelStructuredClaimSynthesizer {
  constructor(private readonly model: ModelClient) {}

  async draft(input: {
    readonly contract: AtomicObligationContract;
    readonly retrieval: DeterministicRetrievalResult;
    readonly signal: AbortSignal;
  }): Promise<readonly ClaimDraft[]> {
    const obligations = input.contract.obligations.filter((obligation) =>
      obligation.domains.includes(input.retrieval.project));
    const envelope = await this.model.completeJson({
      messages: [
        {
          role: "system",
          content: `${CLAIM_DRAFT_PROMPT}\n${CLAIM_ASPECT_GUIDANCE}`,
        },
        {
          role: "user",
          content: structuredTransformationInput("claims", {
            obligations,
            evidence: input.retrieval.evidence.map(compactEvidenceForModel),
          }),
        },
      ],
      schema: claimDraftEnvelopeSchema,
      schemaDescription: "pse_structured_claim_drafts",
      signal: input.signal,
    });
    const claims = envelope.claims;
    if (
      new Set(claims.map((claim) => claim.claimId)).size !== claims.length ||
      claims.some((claim, index) => claim.claimId !== `CL${index + 1}`)
    ) {
      throw new InvalidModelPayloadError(
        "claim_ids_must_be_unique_and_sequential",
        undefined,
        "pse_structured_claim_drafts",
      );
    }
    return Object.freeze(claims.map((claim) => Object.freeze({ ...claim })));
  }
}

export class ModelClaimSupportVerifier {
  constructor(private readonly model: ModelClient) {}

  async verify(input: {
    readonly claims: readonly BoundClaim[];
    readonly evidence: readonly RetrievedEvidence[];
    readonly signal: AbortSignal;
  }): Promise<readonly ClaimSupportDecision[]> {
    const expected = input.claims.map((claim) => ({
      claimId: claim.claimId,
      claimHash: hashClaimText(claim.text),
      citationIndexes: [...claim.citationIndexes],
    }));
    const envelope = await this.model.completeJson({
      messages: [
        { role: "system", content: CLAIM_VERIFY_PROMPT },
        {
          role: "user",
          content: structuredTransformationInput("decisions", {
            claims: input.claims.map((claim, index) => ({
              ...expected[index],
              text: claim.text,
            })),
            evidence: input.evidence.map(compactEvidenceForModel),
          }),
        },
      ],
      schema: supportDecisionEnvelopeSchema,
      schemaDescription: "pse_claim_support_decisions",
      signal: input.signal,
    });
    const decisions = envelope.decisions;
    if (
      decisions.length !== expected.length ||
      decisions.some((decision, index) =>
        decision.claimId !== expected[index]?.claimId ||
        decision.claimHash !== expected[index]?.claimHash ||
        !sameNumbers(decision.citationIndexes, expected[index]?.citationIndexes ?? []))
    ) {
      throw new InvalidModelPayloadError(
        "claim_support_identity_mismatch",
        undefined,
        "pse_claim_support_decisions",
      );
    }
    return Object.freeze(decisions.map((decision) => Object.freeze({ ...decision })));
  }
}

export function hashClaimText(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC"), "utf8").digest("hex");
}

function compactEvidenceForModel(evidence: RetrievedEvidence) {
  return {
    obligationId: evidence.obligationId,
    domain: evidence.domain,
    citation: evidence.citation,
    title: evidence.title,
    compactContent: evidence.compactContent,
    aspectIds: evidence.aspectIds,
    aspectRequirements: evidence.aspectRequirements,
    sourceBoundary: evidence.sourceBoundary,
  };
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
