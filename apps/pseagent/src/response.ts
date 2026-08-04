import type {
  AnswerResult,
  AnswerStatus,
  CaseAssessability,
  Coverage,
  FinalAction,
  KnowledgeCoverage,
  Reference,
  Scope,
} from "./contracts.js";
import type { CoverageGap } from "./coverage-gap.js";
import type { EvidenceLedger } from "./evidence-ledger.js";

export const NOT_COVERED_TEXT = "当前知识库暂未覆盖该问题，暂时无法给出可靠答案。";
export const KNOWLEDGE_UNAVAILABLE_TEXT = "知识问答服务暂时不可用，请稍后重试。";
export const GENERAL_UNAVAILABLE_TEXT = "问答服务暂时不可用，请稍后重试。";

export interface KnowledgeResponseContext {
  readonly evidenceLedgers?: readonly EvidenceLedger[];
  readonly coverageGaps?: readonly CoverageGap[];
}

export function deriveStatus(
  requirementCoverages: readonly Coverage[],
  _referenceCount: number,
): AnswerStatus {
  if (requirementCoverages.every((coverage) => coverage === "none")) {
    return "not_covered";
  }
  return requirementCoverages.every((coverage) => coverage === "complete")
    ? "answered"
    : "partially_answered";
}

export function formatKnowledgeFinal(
  scope: "professional" | "general",
  action: FinalAction,
  references: readonly Reference[],
  context: KnowledgeResponseContext = {},
): AnswerResult {
  const { knowledgeCoverage, caseAssessability } = deriveAnswerAxes(
    action,
    context.evidenceLedgers,
  );
  const status = statusForKnowledgeCoverage(knowledgeCoverage);
  const gapSection = formatGapSection(context.coverageGaps ?? []);
  const relatedContext = action.requirements
    .flatMap((requirement) => requirement.relatedContext ?? [])
    .map((item) => item.statement.trim())
    .filter(Boolean);
  if (
    status === "not_covered" &&
    relatedContext.length > 0 &&
    references.length > 0
  ) {
    const conclusion = action.requirements
      .map((requirement) => requirement.answer.trim())
      .filter(Boolean)
      .join("\n\n");
    const answer = [
        "正式知识库相关信息：",
        relatedContext.join("\n\n"),
        "覆盖结论：",
        conclusion,
        gapSection,
        "正式知识库资料来源：",
        formatSources(references),
      ].filter(Boolean).join("\n\n");
    return {
      scope,
      status,
      knowledgeCoverage,
      caseAssessability,
      answer,
      references: [...references],
    };
  }
  const supportedAnswer = action.requirements
    .filter((requirement) => requirement.coverage !== "none")
    .map((requirement) => requirement.answer.trim())
    .filter(Boolean)
    .join("\n\n");
  const answer = [supportedAnswer, gapSection].filter(Boolean).join("\n\n");
  return formatAnswerResult({
    scope,
    status,
    knowledgeCoverage,
    caseAssessability,
    answer,
    references: status === "not_covered" && answer === "" ? [] : references,
  });
}

export function deriveAnswerAxes(
  action: FinalAction,
  evidenceLedgers: readonly EvidenceLedger[] = [],
): {
  readonly knowledgeCoverage: KnowledgeCoverage;
  readonly caseAssessability: CaseAssessability;
} {
  const units = evidenceLedgers.flatMap((ledger) => ledger.units);
  const knowledgeCoverages = units.length === 0
    ? action.requirements.map((requirement) => requirement.coverage)
    : units
        .filter((unit) => unit.inputState === "not_applicable")
        .map((unit) => unit.verification.coverage);
  const knowledgeCoverage = aggregateCoverage(knowledgeCoverages);

  let caseAssessability: CaseAssessability = "not_applicable";
  if (units.some((unit) =>
    unit.inputState === "missing" ||
    unit.ambiguous ||
    unit.freshness === "stale_or_unconfirmed")) {
    caseAssessability = "insufficient";
  } else if (units.some((unit) => unit.conflictDetected)) {
    caseAssessability = "conflicting";
  } else if (units.some((unit) => unit.inputState === "available")) {
    caseAssessability = "sufficient";
  }
  return { knowledgeCoverage, caseAssessability };
}

export function unavailableResult(scope: Scope): AnswerResult {
  return formatAnswerResult({ scope, status: "temporarily_unavailable", answer: "", references: [] });
}

export function formatAnswerResult(input: {
  readonly scope: Scope;
  readonly status: AnswerStatus;
  readonly answer: string;
  readonly references: readonly Reference[];
  readonly knowledgeCoverage?: KnowledgeCoverage;
  readonly caseAssessability?: CaseAssessability;
}): AnswerResult {
  if (input.status === "not_covered") {
    if (
      !input.answer.trim() ||
      (input.references.length === 0 && input.knowledgeCoverage === undefined)
    ) {
      return {
        scope: input.scope,
        status: input.status,
        answer: NOT_COVERED_TEXT,
        references: [],
      };
    }
    return {
      scope: input.scope,
      status: input.status,
      ...(input.knowledgeCoverage === undefined
        ? {}
        : { knowledgeCoverage: input.knowledgeCoverage }),
      ...(input.caseAssessability === undefined
        ? {}
        : { caseAssessability: input.caseAssessability }),
      answer: input.answer.trim(),
      references: [...input.references],
    };
  }
  if (input.status === "temporarily_unavailable") {
    return {
      scope: input.scope,
      status: input.status,
      answer: input.scope === "normal" ? GENERAL_UNAVAILABLE_TEXT : KNOWLEDGE_UNAVAILABLE_TEXT,
      references: [],
    };
  }

  const answer = input.answer.trim();
  const sources = input.references
    .map((reference) => `[${reference.index}] ${reference.title} — ${reference.project}/${reference.path}`)
    .join("\n");
  return {
    scope: input.scope,
    status: input.status,
    ...(input.knowledgeCoverage === undefined
      ? {}
      : { knowledgeCoverage: input.knowledgeCoverage }),
    ...(input.caseAssessability === undefined
      ? {}
      : { caseAssessability: input.caseAssessability }),
    answer: `${answer}\n\n资料来源：\n${sources}`,
    references: [...input.references],
  };
}

function formatSources(references: readonly Reference[]): string {
  return references
    .map((reference) => `[${reference.index}] ${reference.title} — ${reference.project}/${reference.path}`)
    .join("\n");
}

function aggregateCoverage(coverages: readonly Coverage[]): KnowledgeCoverage {
  if (coverages.length === 0 || coverages.every((coverage) => coverage === "none")) {
    return "none";
  }
  return coverages.every((coverage) => coverage === "complete")
    ? "complete"
    : "partial";
}

function statusForKnowledgeCoverage(coverage: KnowledgeCoverage): AnswerStatus {
  if (coverage === "complete") return "answered";
  return coverage === "partial" ? "partially_answered" : "not_covered";
}

function formatGapSection(gaps: readonly CoverageGap[]): string {
  if (gaps.length === 0) return "";
  const groups: readonly (readonly CoverageGap[])[] = gaps.length <= 3
    ? gaps.map((gap) => [gap])
    : [[gaps[0]!], [gaps[1]!], gaps.slice(2)];
  const lines = groups.map((group, index) => {
    const subjects = uniqueText(group.map((gap) => gap.subject));
    const missing = uniqueText(group.map((gap) => gap.missingAspect));
    const boundaries = uniqueText(group.flatMap((gap) =>
      gap.confirmedBoundary === undefined ? [] : [gap.confirmedBoundary]));
    const nextActions = uniqueText(group.flatMap((gap) =>
      gap.nextAction === undefined ? [] : [gap.nextAction]));
    return [
      `${index + 1}. 对象：${subjects.join("、")}`,
      `缺失信息：${missing.join("、")}`,
      boundaries.length === 0 ? "" : `已确认边界：${boundaries.join("；")}`,
      nextActions.length === 0 ? "" : `下一步：${nextActions.join("；")}`,
    ].filter(Boolean).join("；");
  });
  return ["尚未确认的部分：", ...lines].join("\n");
}

function uniqueText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
