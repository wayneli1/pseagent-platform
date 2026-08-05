import type {
  AnswerCard,
  AnswerCardObligation,
  KnowledgeDomain,
  QuestionFamily,
} from "@pseagent/knowledge-governance-contracts";
import { z } from "zod";
import type { ModelClient } from "./model-client.js";
import {
  AnswerCardRegistry,
  hashAnswerCardIdentifier,
} from "./answer-card-registry.js";

export interface AnswerCardMatchBinding {
  readonly obligationId: string;
  readonly cardObligationId: string;
  readonly cardId: string;
  readonly label: string;
  readonly domain: KnowledgeDomain;
  readonly domains: readonly KnowledgeDomain[];
  readonly required: boolean;
  readonly evidencePolicy: "direct" | "synthesis" | "customer_input";
  readonly requiredConcepts: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly preferredEvidencePaths: readonly string[];
}

export type AnswerCardMatchType = "exact" | "family" | "partial" | "none";
export type AnswerCardMatchConfidence = "deterministic" | "high" | "none";

export type AnswerCardMatch =
  | {
      readonly matchType: "none";
      readonly confidence: "none";
      readonly reason:
        | "no_exact_match"
        | "stale_catalog"
        | "scope_mismatch"
        | "applicability_mismatch"
        | "family_disabled"
        | "no_family_candidate"
        | "family_rejected"
        | "family_match_unavailable";
      readonly catalogHash: string;
      readonly candidateCount: number;
    }
  | {
      readonly matchType: Exclude<AnswerCardMatchType, "none">;
      readonly confidence: Exclude<AnswerCardMatchConfidence, "none">;
      readonly catalogHash: string;
      readonly familyId?: string;
      readonly bindings: readonly AnswerCardMatchBinding[];
      readonly cardIdHashes: readonly string[];
      readonly expectedRevisions: Readonly<Partial<Record<KnowledgeDomain, string>>>;
      readonly candidateCount: number;
    };

const familyDecisionSchema = z.object({
  familyId: z.string().regex(/^[A-Z][A-Z0-9-]{2,63}$/u).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  matchedObligationIds: z.array(z.string().regex(/^O\d+$/u)).max(12),
}).strict();

export interface AnswerCardMatcherInput {
  readonly question: string;
  readonly currentDomain: KnowledgeDomain;
  readonly currentRevision: string;
  readonly familyEnabled: boolean;
  readonly signal?: AbortSignal;
}

export interface AnswerCardRouteHint {
  readonly domain: KnowledgeDomain;
  readonly expectedRevision: string;
}

export interface AnswerCardMatcher {
  routeExact?(question: string): AnswerCardRouteHint | undefined;
  match(input: AnswerCardMatcherInput): Promise<AnswerCardMatch>;
}

export class DefaultAnswerCardMatcher implements AnswerCardMatcher {
  constructor(
    private readonly registry: AnswerCardRegistry,
    private readonly model: ModelClient,
  ) {}

  routeExact(question: string): AnswerCardRouteHint | undefined {
    const card = this.registry.exactCard(question);
    if (
      card === undefined ||
      !this.registry.exactCardApplicable(card.cardId, question)
    ) {
      return undefined;
    }
    return {
      domain: card.domain,
      expectedRevision: this.registry.expectedRevision(card.domain),
    };
  }

  async match(input: AnswerCardMatcherInput): Promise<AnswerCardMatch> {
    const exact = this.registry.exactCard(input.question);
    if (exact !== undefined) {
      if (exact.domain !== input.currentDomain) {
        return this.none("scope_mismatch", 1);
      }
      if (!this.registry.snapshotCurrent(exact.domain, input.currentRevision)) {
        return this.none("stale_catalog", 1);
      }
      if (!this.registry.exactCardApplicable(exact.cardId, input.question)) {
        return this.none("applicability_mismatch", 1);
      }
      return this.hitFromCard(exact);
    }
    if (!input.familyEnabled) return this.none("family_disabled", 0);
    if (!this.registry.snapshotCurrent(input.currentDomain, input.currentRevision)) {
      return this.none("stale_catalog", 0);
    }
    const candidates = this.registry.familyCandidates(
      input.question,
      input.currentDomain,
    );
    if (candidates.length === 0) return this.none("no_family_candidate", 0);

    let decision: z.infer<typeof familyDecisionSchema>;
    try {
      decision = await this.model.completeJson({
        messages: [
          {
            role: "system",
            content: [
              "你是答案卡问题族分类器，只输出 JSON。",
              "只能从候选 familyId 中选择；不属于任一候选时 familyId 为 null。",
              "只有语义目标和适用对象明确一致时才能给 high。",
              "matchedObligationIds 只能包含候选 bindings 中确实被当前问题要求的 obligationId。",
              "不得回答问题，不得补充事实。",
            ].join(""),
          },
          {
            role: "user",
            content: JSON.stringify({
              question: input.question,
              candidates: candidates.map((family) => ({
                familyId: family.familyId,
                title: family.title,
                canonicalQuestion: family.canonicalQuestion,
                aliases: family.aliases,
                obligations: family.bindings.map((binding) => ({
                  obligationId: binding.obligationId,
                  label: binding.label,
                  domain: binding.domain,
                })),
              })),
            }),
          },
        ],
        schema: familyDecisionSchema,
        schemaDescription: "pse_answer_card_family_match",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch {
      return this.none("family_match_unavailable", candidates.length);
    }
    const family = decision.familyId === null
      ? undefined
      : candidates.find((candidate) => candidate.familyId === decision.familyId);
    if (family === undefined || decision.confidence !== "high") {
      return this.none("family_rejected", candidates.length);
    }
    const bindingIds = new Set(decision.matchedObligationIds);
    const selected = family.bindings.filter((binding) => bindingIds.has(binding.obligationId));
    if (
      selected.length === 0 ||
      bindingIds.size !== selected.length ||
      selected.some((binding) => !binding.required)
    ) {
      return this.none("family_rejected", candidates.length);
    }
    const requiredCount = family.bindings.filter((binding) => binding.required).length;
    return this.hitFromFamily(
      family,
      selected,
      selected.length === requiredCount ? "family" : "partial",
      candidates.length,
    );
  }

  private hitFromCard(card: AnswerCard): AnswerCardMatch {
    const bindings = card.obligations.map((obligation) =>
      bindingFromCardObligation(card, obligation.id, obligation));
    return {
      matchType: "exact",
      confidence: "deterministic",
      catalogHash: this.registry.catalogHash,
      bindings,
      cardIdHashes: [hashAnswerCardIdentifier(card.cardId)],
      expectedRevisions: {
        [card.domain]: this.registry.expectedRevision(card.domain),
      },
      candidateCount: 1,
    };
  }

  private hitFromFamily(
    family: QuestionFamily,
    selected: QuestionFamily["bindings"],
    matchType: "family" | "partial",
    candidateCount: number,
  ): AnswerCardMatch {
    const bindings = selected.map((binding) => {
      const card = this.registry.card(binding.cardId)!;
      const obligation = card.obligations.find((candidate) =>
        candidate.id === binding.cardObligationId)!;
      return bindingFromCardObligation(
        card,
        binding.obligationId,
        obligation,
        binding.label,
      );
    });
    const cardIds = [...new Set(bindings.map((binding) => binding.cardId))];
    const domains = [...new Set(bindings.map((binding) => binding.domain))];
    return {
      matchType,
      confidence: "high",
      catalogHash: this.registry.catalogHash,
      familyId: family.familyId,
      bindings,
      cardIdHashes: cardIds.map(hashAnswerCardIdentifier),
      expectedRevisions: Object.fromEntries(domains.map((domain) => [
        domain,
        this.registry.expectedRevision(domain),
      ])),
      candidateCount,
    };
  }

  private none(
    reason: Extract<AnswerCardMatch, { matchType: "none" }>["reason"],
    candidateCount: number,
  ): AnswerCardMatch {
    return {
      matchType: "none",
      confidence: "none",
      reason,
      catalogHash: this.registry.catalogHash,
      candidateCount,
    };
  }
}

function bindingFromCardObligation(
  card: AnswerCard,
  obligationId: string,
  obligation: AnswerCardObligation,
  label = obligation.label,
): AnswerCardMatchBinding {
  return Object.freeze({
    obligationId,
    cardObligationId: obligation.id,
    cardId: card.cardId,
    label,
    domain: card.domain,
    domains: Object.freeze([...obligation.domains]),
    required: obligation.required,
    evidencePolicy: obligation.evidencePolicy,
    requiredConcepts: Object.freeze([...obligation.requiredConcepts]),
    forbiddenClaims: Object.freeze([...obligation.forbiddenClaims]),
    preferredEvidencePaths: Object.freeze([...obligation.preferredEvidencePaths]),
  });
}
