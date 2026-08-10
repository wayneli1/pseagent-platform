import { z } from "zod";

export const scopeSchema = z.enum(["professional", "general", "normal"]);
export const answerStatusSchema = z.enum(["answered", "partially_answered", "not_covered", "temporarily_unavailable"]);
export const coverageSchema = z.enum(["complete", "partial", "none"]);
export const knowledgeCoverageSchema = coverageSchema;
export const caseAssessabilitySchema = z.enum([
  "sufficient",
  "insufficient",
  "conflicting",
  "not_applicable",
]);
export const evidenceModeSchema = z.enum(["direct_only", "synthesis_allowed"]);
export const routeActionSchema = z.object({ action: z.literal("route"), scope: scopeSchema }).strict();
export const knowledgeRequirementIdSchema = z.string().regex(/^R[1-6]$/u);
export const evidenceAspectIdSchema = z.string().regex(/^A[1-8]$/u);
export const evidenceAspectSchema = z.object({
  id: evidenceAspectIdSchema,
  label: z.string().trim().min(1).max(256),
  terms: z.array(z.string().trim().min(1).max(128)).min(1).max(8),
}).strict().superRefine((aspect, context) => {
  const normalizedTerms = aspect.terms.map(normalizeSemanticText);
  if (new Set(normalizedTerms).size !== normalizedTerms.length) {
    context.addIssue({
      code: "custom",
      path: ["terms"],
      message: "duplicate_aspect_terms",
    });
  }
});
export const knowledgeQuerySchema = z.object({
  text: z.string().trim().min(1).max(1_024),
  aspectIds: z.array(evidenceAspectIdSchema).min(1).max(8),
}).strict().superRefine((query, context) => {
  if (new Set(query.aspectIds).size !== query.aspectIds.length) {
    context.addIssue({
      code: "custom",
      path: ["aspectIds"],
      message: "duplicate_query_aspect_ids",
    });
  }
});
export const knowledgeRequirementSchema = z.object({
  id: knowledgeRequirementIdSchema,
  question: z.string().trim().min(1).max(1_024),
  evidenceMode: evidenceModeSchema,
  evidenceAspects: z.array(evidenceAspectSchema).min(1).max(8),
  queries: z.array(knowledgeQuerySchema).min(1).max(3),
}).strict().superRefine((requirement, context) => {
  const aspectIds = requirement.evidenceAspects.map((aspect) => aspect.id);
  if (new Set(aspectIds).size !== aspectIds.length) {
    context.addIssue({
      code: "custom",
      path: ["evidenceAspects"],
      message: "duplicate_evidence_aspect_ids",
    });
  }
  requirement.evidenceAspects.forEach((aspect, index) => {
    if (aspect.id !== `A${index + 1}`) {
      context.addIssue({
        code: "custom",
        path: ["evidenceAspects", index, "id"],
        message: "evidence_aspect_ids_must_be_sequential",
      });
    }
  });

  const knownAspectIds = new Set(aspectIds);
  requirement.queries.forEach((query, queryIndex) => {
    query.aspectIds.forEach((aspectId, aspectIndex) => {
      if (!knownAspectIds.has(aspectId)) {
        context.addIssue({
          code: "custom",
          path: ["queries", queryIndex, "aspectIds", aspectIndex],
          message: "query_references_unknown_aspect",
        });
      }
    });
  });
  for (const aspectId of aspectIds) {
    if (!requirement.queries.some((query) => query.aspectIds.includes(aspectId))) {
      context.addIssue({
        code: "custom",
        path: ["evidenceAspects", aspectIds.indexOf(aspectId), "id"],
        message: "evidence_aspect_requires_query",
      });
    }
  }

  const normalizedQueries = requirement.queries.map((query) =>
    normalizeSemanticText(query.text));
  if (new Set(normalizedQueries).size !== normalizedQueries.length) {
    context.addIssue({
      code: "custom",
      path: ["queries"],
      message: "duplicate_queries",
    });
  }
  if (looksLikeOpaqueKnowledgeIdentifier(requirement.queries[0]?.text ?? "")) {
    context.addIssue({
      code: "custom",
      path: ["queries", 0, "text"],
      message: "primary_query_must_be_semantic",
    });
  }
});
export const knowledgePlanSchema = z.object({
  subject: z.string().trim().min(1).max(1_024),
  requirements: z.array(knowledgeRequirementSchema).min(1).max(6),
}).strict().superRefine((plan, context) => {
  const ids = plan.requirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["requirements"],
      message: "duplicate_requirement_ids",
    });
  }
  plan.requirements.forEach((requirement, index) => {
    if (requirement.id !== `R${index + 1}`) {
      context.addIssue({
        code: "custom",
        path: ["requirements", index, "id"],
        message: "requirement_ids_must_be_sequential",
      });
    }
  });
});
const searchActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.search"),
  input: z.object({
    requirementId: knowledgeRequirementIdSchema,
    query: z.string().trim().min(1).max(16_384),
    aspectIds: z.array(evidenceAspectIdSchema).min(1).max(8),
    topK: z.number().int().min(1).max(10).default(5),
  }).strict().superRefine((input, context) => {
    if (new Set(input.aspectIds).size !== input.aspectIds.length) {
      context.addIssue({
        code: "custom",
        path: ["aspectIds"],
        message: "duplicate_search_aspect_ids",
      });
    }
  }),
}).strict();
const readActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.read_page"),
  input: z.object({
    requirementId: knowledgeRequirementIdSchema,
    path: z.string().trim().min(1).max(1_024),
  }).strict(),
}).strict();
const readPagesActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.read_pages"),
  input: z.object({
    pages: z.array(z.object({
      requirementId: knowledgeRequirementIdSchema,
      path: z.string().trim().min(1).max(1_024),
    }).strict()).min(1).max(12),
}).strict(),
}).strict().superRefine((action, context) => {
  const keys = action.input.pages.map((page) => `${page.requirementId}\u0000${page.path}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["input", "pages"],
      message: "batch_read_requires_distinct_requirement_paths",
    });
  }
});
const graphActionSchema = z.object({
  action: z.literal("tool"),
  tool: z.literal("kb.graph"),
  input: z.object({
    requirementId: knowledgeRequirementIdSchema,
    path: z.string().trim().min(1).max(1_024),
    topK: z.number().int().min(1).max(10).default(5),
  }).strict(),
}).strict();
export const toolActionSchema = z.discriminatedUnion("tool", [
  searchActionSchema,
  readActionSchema,
  readPagesActionSchema,
  graphActionSchema,
]);
export const relatedContextItemSchema = z.object({
  statement: z.string().trim().min(1).max(16_384),
  citations: z.array(z.number().int().positive()).min(1).max(4),
}).strict();
export const requirementCoverageSchema = z.object({
  id: knowledgeRequirementIdSchema,
  coverage: coverageSchema,
  answer: z.string().trim().min(1).max(16_384),
  citations: z.array(z.number().int().positive()).max(20),
  relatedContext: z.array(relatedContextItemSchema).max(3).optional(),
}).superRefine((requirement, context) => {
  if (requirement.coverage !== "none" && requirement.relatedContext !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["relatedContext"],
      message: "related_context_requires_none_coverage",
    });
  }
});
export const finalActionSchema = z.object({
  action: z.literal("final"),
  requirements: z.array(requirementCoverageSchema).min(1).max(6),
  citations: z.array(z.number().int().positive()).max(20),
}).strict();
export const coverageVerificationReasonSchema = z.enum([
  "direct_support",
  "explicit_negative_support",
  "synthesized_support",
  "partial_support",
  "related_only",
  "target_omitted",
  "unsupported_claim_removed",
]);
const coverageVerificationRequirementSchema = z.object({
  id: knowledgeRequirementIdSchema,
  targetDecision: z.enum(["retain", "retain_partial", "not_covered"]),
  retainedTargetSegmentIndexes: z.array(z.number().int().nonnegative()).max(64),
  synthesizedTargetSegmentIndexes: z.array(z.number().int().nonnegative()).max(64),
  retainedRelatedContextIndexes: z.array(z.number().int().nonnegative()).max(3),
  coveredAspectIds: z.array(evidenceAspectIdSchema).max(8).optional(),
  reason: coverageVerificationReasonSchema,
}).strict().superRefine((requirement, context) => {
  for (const [field, message] of [
    [
      "retainedTargetSegmentIndexes",
      "target_segment_indexes_must_be_unique_and_ordered",
    ],
    [
      "synthesizedTargetSegmentIndexes",
      "synthesized_segment_indexes_must_be_unique_and_ordered",
    ],
    [
      "retainedRelatedContextIndexes",
      "related_context_indexes_must_be_unique_and_ordered",
    ],
  ] as const) {
    const indexes = requirement[field];
    if (
      new Set(indexes).size !== indexes.length ||
      indexes.some((value, index) => index > 0 && value <= indexes[index - 1]!)
    ) {
      context.addIssue({
        code: "custom",
        path: [field],
        message,
      });
    }
  }
  const coveredAspectIds = requirement.coveredAspectIds ?? [];
  if (
    new Set(coveredAspectIds).size !== coveredAspectIds.length ||
    coveredAspectIds.some(
      (value, index) =>
        index > 0 &&
        Number(value.slice(1)) <= Number(coveredAspectIds[index - 1]!.slice(1)),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["coveredAspectIds"],
      message: "covered_aspect_ids_must_be_unique_and_ordered",
    });
  }
});
export const coverageVerificationActionSchema = z.object({
  action: z.literal("verify"),
  requirements: z.array(coverageVerificationRequirementSchema).min(1).max(6),
}).strict();
export const agentActionSchema = z.preprocess(
  sanitizeModelAction,
  z.union([toolActionSchema, finalActionSchema]),
);
export const finalOnlyActionSchema = z.preprocess(
  sanitizeModelAction,
  finalActionSchema,
);
export const pseAnswerInputSchema = z.object({
  question: z.string().trim().min(1).max(16_384),
  conversationContext: z.string().max(32_768).optional(),
}).strict();
export const referenceSchema = z.object({
  index: z.number().int().positive(),
  project: z.enum(["coremail-professional", "presales-general"]),
  title: z.string().min(1),
  path: z.string().min(1),
  revision: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const HISTORICAL_ANSWER_WARNING =
  "以下内容来自补充历史资料，并非正式知识库答案，也未经过产品或售前人员验证。内容可能存在较多错误、过时信息、资料缺失或版本不匹配，请仅作为继续核实的线索，不能直接用于客户答复、投标、部署、升级或变更决策。";
export const historicalReferenceSchema = z.object({
  sourceType: z.enum(["jira", "wiki"]),
  id: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  title: z.string().min(1),
  url: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  versions: z.array(z.string().min(1)).max(20).optional(),
  status: z.string().min(1).optional(),
}).strict();
export const historicalAnswerSchema = z.object({
  provider: z.literal("coremail_mcp"),
  verified: z.literal(false),
  confidence: z.enum(["low", "medium", "high"]),
  warning: z.literal(HISTORICAL_ANSWER_WARNING),
  answer: z.string().min(1).max(32_768),
  references: z.array(historicalReferenceSchema).min(1).max(20),
}).strict();
export const historicalRejectionReasonSchema = z.enum([
  "topic_mismatch",
  "low_confidence",
  "no_reliable_source",
]);
export const historicalNoticeSchema = z.object({
  provider: z.literal("coremail_mcp"),
  searched: z.literal(true),
  displayed: z.literal(false),
  reason: historicalRejectionReasonSchema,
}).strict();
export const answerResultSchema = z.object({
  scope: scopeSchema,
  status: answerStatusSchema,
  answer: z.string(),
  references: z.array(referenceSchema),
  knowledgeCoverage: knowledgeCoverageSchema.optional(),
  caseAssessability: caseAssessabilitySchema.optional(),
  historicalAnswer: historicalAnswerSchema.optional(),
  historicalNotice: historicalNoticeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.historicalAnswer !== undefined && value.historicalNotice !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["historicalNotice"],
      message: "historical_answer_and_notice_are_mutually_exclusive",
    });
  }
});
export type Scope = z.infer<typeof scopeSchema>;
export type EvidenceMode = z.infer<typeof evidenceModeSchema>;
export type RouteAction = z.infer<typeof routeActionSchema>;
export type EvidenceAspect = z.infer<typeof evidenceAspectSchema>;
export type KnowledgeQuery = z.infer<typeof knowledgeQuerySchema>;
export type KnowledgeRequirement = z.infer<typeof knowledgeRequirementSchema>;
export type KnowledgePlan = z.infer<typeof knowledgePlanSchema> & {
  /** Internal retrieval strategy. It is never accepted from model JSON. */
  readonly retrievalStrategy?: "coverage_units";
};
export type RelatedContextItem = {
  readonly statement: string;
  readonly citations: readonly number[];
};
type ParsedRequirementCoverage = z.infer<typeof requirementCoverageSchema>;
export type RequirementCoverage = {
  readonly id: ParsedRequirementCoverage["id"];
  readonly coverage: ParsedRequirementCoverage["coverage"];
  readonly answer: ParsedRequirementCoverage["answer"];
  readonly citations: readonly number[];
  readonly relatedContext?: readonly RelatedContextItem[] | undefined;
};
export type AgentAction = z.infer<typeof agentActionSchema>;
export type ToolAction = z.infer<typeof toolActionSchema>;
export type FinalAction = {
  readonly action: "final";
  readonly requirements: readonly RequirementCoverage[];
  readonly citations: readonly number[];
};
export type CoverageVerificationAction = z.infer<typeof coverageVerificationActionSchema>;
export type CoverageVerificationReason = z.infer<typeof coverageVerificationReasonSchema>;
export type AnswerResult = z.infer<typeof answerResultSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type HistoricalReference = z.infer<typeof historicalReferenceSchema>;
export type HistoricalAnswer = z.infer<typeof historicalAnswerSchema>;
export type HistoricalRejectionReason = z.infer<
  typeof historicalRejectionReasonSchema
>;
export type HistoricalNotice = z.infer<typeof historicalNoticeSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type KnowledgeCoverage = z.infer<typeof knowledgeCoverageSchema>;
export type CaseAssessability = z.infer<typeof caseAssessabilitySchema>;
export type AnswerStatus = z.infer<typeof answerStatusSchema>;

function sanitizeModelAction(value: unknown): unknown {
  if (!isRecord(value) || value.action !== "final" || !Array.isArray(value.requirements)) {
    return value;
  }
  const requirements = value.requirements.map((requirement) => {
    if (!isRecord(requirement) || requirement.relatedContext === undefined) {
      return requirement;
    }
    const { relatedContext: _relatedContext, ...rest } = requirement;
    if (requirement.coverage !== "none" || !Array.isArray(requirement.relatedContext)) {
      return rest;
    }
    const retained = requirement.relatedContext
      .flatMap((item) => sanitizeRelatedContextItem(item))
      .slice(0, 3);
    return retained.length === 0 ? rest : { ...rest, relatedContext: retained };
  });
  const derivedCitations = stableUniqueNumbers(
    requirements.flatMap((requirement) => {
      if (!isRecord(requirement)) return [];
      const direct = Array.isArray(requirement.citations)
        ? requirement.citations.filter(isPositiveInteger)
        : [];
      const related = Array.isArray(requirement.relatedContext)
        ? requirement.relatedContext.flatMap((item) =>
            isRecord(item) && Array.isArray(item.citations)
              ? item.citations.filter(isPositiveInteger)
              : [])
        : [];
      return [...direct, ...related];
    }),
  );
  return {
    ...value,
    requirements,
    // This field only aggregates per-requirement metadata. Models frequently
    // omit it even when every requirement has valid citations, so reconstruct
    // that harmless redundancy deterministically at the schema boundary.
    ...(!Array.isArray(value.citations) ? { citations: derivedCitations } : {}),
  };
}

function sanitizeRelatedContextItem(value: unknown): {
  readonly statement: string;
  readonly citations: readonly number[];
}[] {
  if (!isRecord(value) || typeof value.statement !== "string") return [];
  const statement = value.statement.trim();
  if (
    statement.length === 0 ||
    statement.length > 16_384 ||
    !Array.isArray(value.citations) ||
    value.citations.length < 1 ||
    value.citations.length > 4
  ) {
    return [];
  }
  const citations = value.citations;
  if (
    !citations.every((citation): citation is number =>
      typeof citation === "number" &&
      Number.isInteger(citation) &&
      citation > 0) ||
    new Set(citations).size !== citations.length
  ) {
    return [];
  }
  const inline = stableUniqueNumbers(
    [...statement.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
  );
  if (!sameNumberSet(inline, citations)) return [];
  return [{ statement, citations }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function stableUniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length &&
    left.every((value) => right.includes(value));
}

function looksLikeOpaqueKnowledgeIdentifier(query: string): boolean {
  const normalized = query.trim();
  return /^(?:(?:page|wiki|confluence|source|页面|来源|附件)\s*(?:id|编号)?\s*[:#_-]?\s*)?\d{6,}(?:\s*[-_:#]|$)/iu
    .test(normalized)
    || /^(?:[a-f\d]{8}-){3,}[a-f\d-]+$/iu.test(normalized);
}

function normalizeSemanticText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}
