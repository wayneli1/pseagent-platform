import { z } from "zod";
import {
  answerResultSchema,
} from "./contracts.js";
import { evaluateCoremailHistoricalAnswer } from "./coremail-mcp-client.js";
import {
  HISTORICAL_BODY_MAX_CHARS,
  HISTORICAL_NOTICE_MESSAGES,
  HISTORICAL_REFERENCE_LIMIT,
} from "./historical-display.js";
import { formatMcpText } from "./mcp-server.js";
import { NOT_COVERED_TEXT } from "./response.js";

const probeQuestionSchema = z.string().trim().min(1).max(16_384);

export function validateHistoricalProbe(
  questionInput: unknown,
  pseInput: unknown,
  directInput: unknown,
  renderedInput: unknown,
) {
  const question = probeQuestionSchema.parse(questionInput);
  const pseResult = answerResultSchema.parse(pseInput);
  const rendered = z.string().parse(renderedInput);
  validateNotCoveredPrimary(pseResult);
  if (rendered !== formatMcpText(pseResult)) {
    throw new Error("unexpected_rendered_history");
  }

  const expected = evaluateCoremailHistoricalAnswer(question, directInput);
  if (expected.outcome === "unavailable") {
    throw new Error("unexpected_direct_unavailable");
  }
  if (expected.outcome === "hidden") {
    if (pseResult.historicalAnswer !== undefined) {
      throw new Error("unexpected_hidden_historical_answer");
    }
    if (pseResult.historicalNotice?.reason !== expected.reason) {
      throw new Error("unexpected_historical_notice");
    }
    if (!rendered.includes(HISTORICAL_NOTICE_MESSAGES[expected.reason])) {
      throw new Error("missing_historical_notice_text");
    }
    return {
      outcome: "hidden" as const,
      mainRefs: pseResult.references.length,
      historyRefs: 0 as const,
      reason: expected.reason,
    };
  }

  if (pseResult.historicalNotice !== undefined) {
    throw new Error("unexpected_display_notice");
  }
  const historical = pseResult.historicalAnswer;
  if (historical === undefined) throw new Error("missing_historical_answer");
  if (canonicalJson(historical) !== canonicalJson(expected.answer)) {
    throw new Error("unexpected_displayed_history");
  }
  if (
    historical.answer.length > HISTORICAL_BODY_MAX_CHARS ||
    historical.references.length > HISTORICAL_REFERENCE_LIMIT
  ) {
    throw new Error("historical_display_limit_exceeded");
  }
  if (
    /https?:\/\//iu.test(historical.answer) ||
    historical.references.some((reference) => reference.url !== undefined) ||
    /https?:\/\//iu.test(rendered)
  ) {
    throw new Error("historical_internal_url_visible");
  }
  return {
    outcome: "display" as const,
    mainRefs: pseResult.references.length,
    historyRefs: historical.references.length,
    confidence: historical.confidence,
  };
}

export function validateHistoricalUnavailableProbe(
  pseInput: unknown,
  renderedInput: unknown,
) {
  const pseResult = answerResultSchema.parse(pseInput);
  const rendered = z.string().parse(renderedInput);
  validateNotCoveredPrimary(pseResult);
  if (
    pseResult.historicalAnswer !== undefined ||
    pseResult.historicalNotice !== undefined
  ) {
    throw new Error("unavailable_history_was_exposed");
  }
  if (rendered !== pseResult.answer) {
    throw new Error("unexpected_rendered_history");
  }
  return { mainRefs: pseResult.references.length };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function validateNotCoveredPrimary(
  result: ReturnType<typeof answerResultSchema.parse>,
): void {
  if (result.status !== "not_covered") {
    throw new Error("unexpected_primary_status");
  }
  if (result.references.length === 0) {
    if (result.answer !== NOT_COVERED_TEXT) {
      throw new Error("unexpected_primary_answer");
    }
    return;
  }
  validateFormalRelatedReferences(result);
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
