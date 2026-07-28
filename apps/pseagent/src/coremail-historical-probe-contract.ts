import { z } from "zod";
import {
  HISTORICAL_ANSWER_WARNING,
  answerResultSchema,
} from "./contracts.js";
import { NOT_COVERED_TEXT } from "./response.js";

const directHistoricalAnswerSchema = z.object({
  answer: z.string().min(1).max(32_768),
  confidence: z.enum(["low", "medium", "high"]),
  sources: z.array(z.object({
    source_type: z.string(),
  }).passthrough()).min(1),
}).passthrough();

export function validateHistoricalProbe(
  pseInput: unknown,
  directInput: unknown,
) {
  const pseResult = answerResultSchema.parse(pseInput);
  const directResult = directHistoricalAnswerSchema.parse(directInput);
  if (pseResult.status !== "not_covered") {
    throw new Error("unexpected_primary_status");
  }
  if (pseResult.references.length === 0) {
    if (pseResult.answer !== NOT_COVERED_TEXT) {
      throw new Error("unexpected_primary_answer");
    }
  } else {
    validateFormalRelatedReferences(pseResult);
  }
  const historical = pseResult.historicalAnswer;
  if (!historical) throw new Error("missing_historical_answer");
  if (historical.references.length < 1) {
    throw new Error("missing_historical_reference");
  }
  if (!historical.references.every((reference) =>
    reference.sourceType === "jira" || reference.sourceType === "wiki")) {
    throw new Error("unexpected_historical_source_type");
  }
  if (historical.warning !== HISTORICAL_ANSWER_WARNING) {
    throw new Error("unexpected_historical_warning");
  }
  if (historical.confidence !== directResult.confidence) {
    throw new Error("unexpected_historical_confidence");
  }
  if (!directResult.sources.some((source) =>
    source.source_type === "jira" || source.source_type === "wiki")) {
    throw new Error("missing_direct_historical_reference");
  }
  if (historical.answer !== directResult.answer) {
    throw new Error("historical_answer_rewritten");
  }
  return {
    mainRefs: pseResult.references.length,
    historyRefs: historical.references.length,
    confidence: historical.confidence,
    rawEqual: true as const,
    warning: true as const,
  };
}

function validateFormalRelatedReferences(
  result: ReturnType<typeof answerResultSchema.parse>,
): void {
  if (result.scope !== "professional") {
    throw new Error("unexpected_primary_scope");
  }
  if (result.references.length === 0) {
    throw new Error("missing_formal_reference");
  }
  const relatedHeading = "正式知识库相关信息：";
  const conclusionHeading = "覆盖结论：";
  const sourcesHeading = "正式知识库资料来源：";
  const relatedStart = result.answer.indexOf(relatedHeading);
  const conclusionStart = result.answer.indexOf(conclusionHeading);
  const sourcesStart = result.answer.indexOf(sourcesHeading);
  if (
    relatedStart < 0 ||
    conclusionStart <= relatedStart ||
    sourcesStart <= conclusionStart
  ) {
    throw new Error("unexpected_primary_answer");
  }

  const relatedSection = result.answer.slice(
    relatedStart + relatedHeading.length,
    conclusionStart,
  );
  const sourcesSection = result.answer.slice(sourcesStart + sourcesHeading.length);
  const relatedCitations = new Set(
    [...relatedSection.matchAll(/\[(\d+)\]/gu)].map((match) =>
      Number.parseInt(match[1] ?? "", 10)),
  );
  const referenceIndexes = new Set(
    result.references.map((reference) => reference.index),
  );
  if (
    referenceIndexes.size !== result.references.length ||
    relatedCitations.size !== referenceIndexes.size ||
    [...referenceIndexes].some((index) => !relatedCitations.has(index))
  ) {
    throw new Error("formal_reference_partition_mismatch");
  }
  for (const reference of result.references) {
    if (reference.project !== "coremail-professional") {
      throw new Error("unexpected_formal_source_type");
    }
    if (
      !sourcesSection.includes(`[${reference.index}]`) ||
      !sourcesSection.includes(reference.title) ||
      !sourcesSection.includes(`${reference.project}/${reference.path}`)
    ) {
      throw new Error("formal_reference_not_visible");
    }
  }
}
