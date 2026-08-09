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
  loadAnswerCardRegistry,
  resolveActiveAnswerCardCatalog,
} from "./answer-card-registry.js";
import {
  explicitNamedMethods,
  normalizeNamedMethod,
} from "./named-method.js";

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
  readonly answerTemplate?: string;
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
  confidence: z.enum(["high", "medium", "low", "none"]),
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
    const recalledCandidates = this.registry.familyCandidates(
      input.question,
      input.currentDomain,
    );
    if (recalledCandidates.length === 0) return this.none("no_family_candidate", 0);
    const namedMethods = explicitNamedMethods(input.question);
    const enumeratedLabels = explicitEnumeratedLabels(input.question);
    const candidates = recalledCandidates.filter((family) =>
      (namedMethods.length === 0 ||
        familySupportsNamedMethods(family, namedMethods, this.registry)) &&
      (enumeratedLabels.length === 0 ||
        familySupportsEnumeratedLabels(family, enumeratedLabels, this.registry))
    );
    if (candidates.length === 0) {
      return this.none("family_rejected", recalledCandidates.length);
    }

    let decision: z.infer<typeof familyDecisionSchema>;
    try {
      decision = await this.model.completeJson({
        messages: [
          {
            role: "system",
            content: [
              "你是答案卡问题族分类器，只输出 JSON。",
              "只能从候选 familyId 中选择；不属于任一候选时 familyId 为 null。",
              "familyId 为 null 时 confidence 必须为 none；选择候选时 confidence 只能为 high、medium 或 low。",
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
                  requiredConcepts: this.registry.card(binding.cardId)?.obligations.find(
                    (obligation) => obligation.id === binding.cardObligationId,
                  )?.requiredConcepts ?? [],
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
      const fallback = this.registry.deterministicFamilyCandidate(
        input.question,
        input.currentDomain,
      );
      if (fallback !== undefined) {
        const selected = fallback.bindings.filter((binding) => binding.required);
        return this.hitFromFamily(
          fallback,
          selected,
          "family",
          candidates.length,
        );
      }
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
    const selectedCardIds = new Set(selected.map((binding) => binding.cardId));
    const completeCardSelection = family.bindings.filter((binding) =>
      binding.required && selectedCardIds.has(binding.cardId));
    const requiredCount = family.bindings.filter((binding) => binding.required).length;
    return this.hitFromFamily(
      family,
      completeCardSelection,
      completeCardSelection.length === requiredCount ? "family" : "partial",
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

export class ReloadingAnswerCardMatcher implements AnswerCardMatcher {
  private sourceKey:string;
  private current:DefaultAnswerCardMatcher;

  constructor(
    private readonly catalogPath:string,
    private readonly snapshotRoot:string|undefined,
    private readonly model:ModelClient,
    private readonly required=false,
  ){
    const source=resolveActiveAnswerCardCatalog(catalogPath,snapshotRoot);
    this.sourceKey=source.key;
    this.current=this.create(source.catalogPath);
  }

  routeExact(question:string):AnswerCardRouteHint|undefined {
    return this.matcher().routeExact(question);
  }

  match(input:AnswerCardMatcherInput):Promise<AnswerCardMatch> {
    return this.matcher().match(input);
  }

  private matcher():DefaultAnswerCardMatcher {
    try{
      const source=resolveActiveAnswerCardCatalog(this.catalogPath,this.snapshotRoot);
      if(source.key!==this.sourceKey){
        const next=this.create(source.catalogPath);
        this.current=next;
        this.sourceKey=source.key;
      }
    }catch{
      // Keep serving the last validated immutable catalog when a new pointer is incomplete.
    }
    return this.current;
  }

  private create(catalogPath:string):DefaultAnswerCardMatcher {
    const registry=loadAnswerCardRegistry(catalogPath);
    if(this.required)registry.assertHasActiveCards();
    return new DefaultAnswerCardMatcher(registry,this.model);
  }
}

function familySupportsNamedMethods(
  family: QuestionFamily,
  methods: readonly string[],
  registry: AnswerCardRegistry,
): boolean {
  const governedText = normalizeNamedMethod(familyGovernedText(family, registry));
  return methods.every((method) => governedText.includes(method));
}

function explicitEnumeratedLabels(question: string): readonly string[] {
  const normalized = question.normalize("NFKC");
  for (const match of normalized.matchAll(
    /(?<prefix>.{0,160}?)(?<count>[二三四五六七八九十2-9])\s*类/gu,
  )) {
    const count = enumerationCount(match.groups?.count ?? "");
    if (count === undefined) continue;
    const parts = (match.groups?.prefix ?? "")
      .split(/(?:、|，|,|以及|及|和|与)/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < count) continue;
    const labels = parts.slice(-count);
    labels[0] = labels[0]?.replace(
      /^.*(?:识别|区分|说明|介绍|列出|比较|对比|包括|包含|分为|覆盖)/u,
      "",
    ).trim() ?? "";
    if (labels.every((label) => [...label].length >= 1 && [...label].length <= 40)) {
      return labels;
    }
  }
  for (const match of normalized.matchAll(
    /(?:怎样|如何|怎么)(?:使用|用|按|基于)?\s*(?<items>.{1,160}?)(?:来|去)?(?:标记|区分|比较|对比|说明|介绍|列出|评估|分析|覆盖)/gu,
  )) {
    const labels = (match.groups?.items ?? "")
      .split(/、/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (
      labels.length >= 3 &&
      labels.length <= 9 &&
      labels.every((label) => [...label].length >= 1 && [...label].length <= 40)
    ) {
      return labels;
    }
  }
  return [];
}

function enumerationCount(value: string): number | undefined {
  if (/^[2-9]$/u.test(value)) return Number(value);
  return ({
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  } as const)[value as "二" | "三" | "四" | "五" | "六" | "七" | "八" | "九" | "十"];
}

function familySupportsEnumeratedLabels(
  family: QuestionFamily,
  labels: readonly string[],
  registry: AnswerCardRegistry,
): boolean {
  const governedText = normalizeGovernedPhrase(familyGovernedText(family, registry));
  return labels.every((label) => governedText.includes(normalizeGovernedPhrase(label)));
}

function familyGovernedText(
  family: QuestionFamily,
  registry: AnswerCardRegistry,
): string {
  const cards = [...new Set(family.bindings.map((binding) => binding.cardId))]
    .flatMap((cardId) => {
      const card = registry.card(cardId);
      return card === undefined
        ? []
        : [
            card.title,
            card.canonicalQuestion,
            ...card.aliases,
            card.answerTemplate,
            ...card.obligations.flatMap((obligation) => [
              obligation.label,
              ...obligation.requiredConcepts,
            ]),
          ];
    });
  return [
    family.title,
    family.canonicalQuestion,
    ...family.aliases,
    ...family.bindings.map((binding) => binding.label),
    ...cards,
  ].join(" ");
}

function normalizeGovernedPhrase(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
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
    answerTemplate: card.answerTemplate,
  });
}
