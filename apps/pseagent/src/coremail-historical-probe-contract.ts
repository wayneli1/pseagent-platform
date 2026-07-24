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
  if (pseResult.answer !== NOT_COVERED_TEXT) {
    throw new Error("unexpected_primary_answer");
  }
  if (pseResult.references.length !== 0) {
    throw new Error("unexpected_primary_references");
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
