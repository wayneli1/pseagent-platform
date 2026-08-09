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
import type { CoverageVerificationReport } from "./coverage-verifier.js";
import type { EvidenceLedger } from "./evidence-ledger.js";
import {
  buildStructuredAnswer,
  renderStructuredAnswer,
  type StructuredAnswerBinding,
} from "./structured-answer.js";
import type { KnowledgeDomain } from "./task-spec.js";

export const NOT_COVERED_TEXT = "当前知识库暂未覆盖该问题，暂时无法给出可靠答案。";
export const KNOWLEDGE_UNAVAILABLE_TEXT = "知识问答服务暂时不可用，请稍后重试。";
export const GENERAL_UNAVAILABLE_TEXT = "问答服务暂时不可用，请稍后重试。";

export interface KnowledgeResponseContext {
  readonly evidenceLedgers?: readonly EvidenceLedger[];
  readonly coverageGaps?: readonly CoverageGap[];
  readonly question?: string;
  readonly requirementBindings?: readonly StructuredAnswerBinding[];
  readonly verification?: CoverageVerificationReport;
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
    context.requirementBindings,
  );
  const status = knowledgeCoverage === "none" && caseAssessability === "insufficient"
    ? "partially_answered"
    : statusForKnowledgeCoverage(knowledgeCoverage);
  const gapSection = formatGapSection(context.coverageGaps ?? [], context.question);
  const evidenceConditionSection = formatEvidenceConditionSection(
    context.evidenceLedgers ?? [],
  );
  const structuredAnswer = buildStructuredAnswer(action, {
    ...(context.requirementBindings === undefined
      ? {}
      : { bindings: context.requirementBindings }),
    ...(context.verification === undefined
      ? {}
      : { verification: context.verification }),
    defaultDomain: domainForScope(scope),
  });
  const renderedSupportedAnswer = renderStructuredAnswer(structuredAnswer);
  const userContextSection = formatUserProvidedContext(
    context.question,
    renderedSupportedAnswer,
  );
  const relatedContext = action.requirements
    .flatMap((requirement) => requirement.relatedContext ?? [])
    .map((item) => item.statement.trim())
    .filter(Boolean);
  if (
    knowledgeCoverage === "none" &&
    relatedContext.length > 0 &&
    references.length > 0
  ) {
    const conclusion = uniqueText(action.requirements
      .map((requirement) => requirement.answer.trim())
      .filter(Boolean))
      .join("\n\n");
    const answer = [
        userContextSection,
        "正式知识库相关信息：",
        relatedContext.join("\n\n"),
        "覆盖结论：",
        conclusion,
        evidenceConditionSection,
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
  const answer = [
    userContextSection,
    renderedSupportedAnswer,
    evidenceConditionSection,
    gapSection,
  ]
    .filter(Boolean)
    .join("\n\n");
  return formatAnswerResult({
    scope,
    status,
    knowledgeCoverage,
    caseAssessability,
    answer,
    references: status === "not_covered" && answer === "" ? [] : references,
  });
}

function domainForScope(
  scope: "professional" | "general",
): KnowledgeDomain {
  return scope === "professional"
    ? "coremail-professional"
    : "presales-general";
}

function formatUserProvidedContext(
  question: string | undefined,
  answer: string,
): string {
  if (question === undefined || question.trim() === "") return "";
  const premise = question.match(
    /^(?<premise>(?:已知|目前|当前|现有)[\s\S]{2,400}?)[，,；;。]\s*(?:请|帮|需要|如何|怎样|怎么|给出|重新评估|评估|分析|说明|列出|设计|制定)/u,
  )?.groups?.premise?.trim();
  const constraints = question
    .split(/[，,；;。！？!?]+/u)
    .map((segment) => segment.trim())
    .filter((segment) =>
      /(?:约|大约|不超过|不低于|至少|至多|以上|以下|小于|大于|≤|≥|<=|>=)\s*\d/iu.test(segment) ||
      /\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:用户|并发|QPS|TPS|GB|TB|PB|毫秒|秒|分钟|小时|天|%)/iu.test(segment) ||
      /[一二三四五六七八九十]+地[一二三四五六七八九十]+中心/u.test(segment));
  const items = uniqueText([
    ...(premise === undefined ? [] : [premise]),
    ...constraints.filter((constraint) =>
      premise === undefined || !normalizeDisplayText(premise).includes(
        normalizeDisplayText(constraint),
      )),
  ]).filter((item) => !normalizeDisplayText(answer).includes(normalizeDisplayText(item)));
  if (items.length === 0 || (premise === undefined && items.length < 2)) return "";
  return [
    "用户提供的背景与约束（非知识库结论）：",
    ...items.map((item) => `- ${item}`),
  ].join("\n");
}

function normalizeDisplayText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function formatEvidenceConditionSection(
  ledgers: readonly EvidenceLedger[],
): string {
  const units = ledgers.flatMap((ledger) => ledger.units);
  const notices: string[] = [];
  if (units.some((unit) => unit.conflictDetected)) {
    notices.push(
      "当前问题已明确存在正式资料冲突，不能合并为单一确定结论；需核对版本、资料日期、权威级别与适用范围后再确认。",
    );
  }
  if (units.some((unit) => unit.ambiguous)) {
    notices.push("当前输入存在歧义，相关结论需在澄清对象、口径或范围后确认。");
  }
  if (units.some((unit) => unit.freshness === "stale_or_unconfirmed")) {
    notices.push("相关资料的时效或版本状态尚未确认，不能直接作为当前版本承诺。");
  }
  return notices.length === 0 ? "" : ["证据边界：", ...notices].join("\n");
}

export function deriveAnswerAxes(
  action: FinalAction,
  evidenceLedgers: readonly EvidenceLedger[] = [],
  requirementBindings: readonly StructuredAnswerBinding[] = [],
): {
  readonly knowledgeCoverage: KnowledgeCoverage;
  readonly caseAssessability: CaseAssessability;
} {
  const units = evidenceLedgers.flatMap((ledger) => ledger.units);
  const requiredRequirementIds = new Set(
    requirementBindings
      .filter((binding) => binding.required !== false)
      .map((binding) => binding.globalRequirementId),
  );
  const requiredObligations = new Set(
    requirementBindings
      .filter((binding) => binding.required !== false)
      .map((binding) => `${binding.domain}\u0000${binding.obligationId}`),
  );
  const knowledgeCoverages = units.length === 0
    ? action.requirements
        .filter((requirement) =>
          requiredRequirementIds.size === 0 ||
          requiredRequirementIds.has(requirement.id))
        .map((requirement) => requirement.coverage)
    : units
        .filter((unit) =>
          unit.inputState === "not_applicable" &&
          (
            requiredObligations.size === 0 ||
            requiredObligations.has(
              `${unit.binding.domain}\u0000${unit.binding.obligationId}`,
            )
          ))
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
    answer: sources === "" ? answer : `${answer}\n\n资料来源：\n${sources}`,
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

function formatGapSection(
  gaps: readonly CoverageGap[],
  originalQuestion?: string,
): string {
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
      nextActions.length === 0 ? "" : `下一步验证：${nextActions.join("；")}`,
    ].filter(Boolean).join("；");
  });
  const materialGuidance = formatProductEvidenceMaterialGuidance(gaps, originalQuestion);
  return ["尚未确认的部分：", ...lines, materialGuidance].filter(Boolean).join("\n");
}

function formatProductEvidenceMaterialGuidance(
  gaps: readonly CoverageGap[],
  originalQuestion?: string,
): string {
  const productGaps = gaps.filter((gap) =>
    gap.domain === "coremail-professional" &&
    ["knowledge", "retrieval", "source", "freshness"].includes(gap.gapClass));
  if (productGaps.length === 0) return "";

  const topic = [
    originalQuestion ?? "",
    ...productGaps.flatMap((gap) => [gap.subject, gap.missingAspect]),
  ].join(" ");
  const materials: string[] = [];
  if (/(?:是否|能否|支持|兼容|能力|功能)/u.test(topic)) {
    materials.push("正式产品功能说明或发布说明，用于直接确认支持性与功能边界");
  }
  if (/(?:版本|release|edition|\bv\d|xt\d)/iu.test(topic)) {
    materials.push("产品版本—功能支持矩阵，用于确认首次支持版本、适用小版本和升级边界");
  }
  if (/(?:license|licence|授权|许可|sku)/iu.test(topic)) {
    materials.push("License、SKU 或版本授权说明，用于确认授权项、前置购买条件和部署限制");
  }
  if (/(?:配置|启用|部署|安装|操作|步骤|验证|回退)/u.test(topic)) {
    materials.push("正式管理员配置手册，用于确认前置条件、启用步骤、验证方法、安全限制和回退方式");
  }
  if (materials.length < 2) return "";
  return `资料补充口径：若完整复核后正式知识库仍无直接覆盖，请补充${materials.join("；")}。`;
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
