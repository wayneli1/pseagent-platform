import type {
  Coverage,
  FinalAction,
  KnowledgeCoverage,
} from "./contracts.js";
import {
  SYNTHESIS_DISCLOSURE,
  type CoverageVerificationReport,
} from "./coverage-verifier.js";
import {
  normalizeTrailingCitationPlacement,
  splitAnswerLineSegments,
} from "./references.js";
import type { KnowledgeDomain } from "./task-spec.js";

export type StructuredAnswerSupportKind = "direct" | "synthesized";

export interface StructuredAnswerBinding {
  readonly globalRequirementId: string;
  readonly deliverableId: string;
  readonly obligationId: string;
  readonly domain: KnowledgeDomain;
  readonly required?: boolean;
  readonly cardId?: string;
}

export interface StructuredAnswerSegment {
  readonly statement: string;
  readonly citations: readonly number[];
  readonly supportKind: StructuredAnswerSupportKind;
  readonly domain?: KnowledgeDomain;
  readonly cardId?: string;
}

export interface StructuredAnswerSection {
  readonly requirementId: string;
  readonly deliverableId: string;
  readonly obligationId: string;
  readonly required: boolean;
  readonly sourceCoverage: Coverage;
  readonly segments: readonly StructuredAnswerSegment[];
}

export interface StructuredAnswer {
  readonly preamble: readonly string[];
  readonly sections: readonly StructuredAnswerSection[];
  readonly coverage: KnowledgeCoverage;
}

export interface StructuredAnswerContext {
  readonly bindings?: readonly StructuredAnswerBinding[];
  readonly verification?: CoverageVerificationReport;
  readonly defaultDomain?: KnowledgeDomain;
}

export function buildStructuredAnswer(
  action: FinalAction,
  context: StructuredAnswerContext = {},
): StructuredAnswer {
  const bindingByRequirement = new Map(
    (context.bindings ?? []).map((binding) => [
      binding.globalRequirementId,
      binding,
    ] as const),
  );
  const verificationByRequirement = new Map(
    (context.verification?.summaries ?? []).map((summary) => [
      summary.id,
      summary,
    ] as const),
  );
  const preamble: string[] = [];
  const sections = action.requirements.map((requirement) => {
    const binding = bindingByRequirement.get(requirement.id);
    const retainedDecisions = verificationByRequirement.get(requirement.id)
      ?.claimDecisions.filter((decision) => decision.status !== "removed") ?? [];
    const splitAnswer = requirement.coverage === "none"
      ? { preamble: [], segments: [] }
      : splitSupportedSegments(requirement.answer);
    for (const item of splitAnswer.preamble) {
      if (!preamble.includes(item)) preamble.push(item);
    }
    const segments = splitAnswer.segments.map((piece, index): StructuredAnswerSegment => {
      const decision = retainedDecisions[index];
      const supportKind = decision?.status === "retained_direct"
          ? "direct"
        : decision?.status === "retained_synthesized"
          ? "synthesized"
          : splitAnswer.preamble.includes(SYNTHESIS_DISCLOSURE)
            ? "synthesized"
            : inferSupportKind(piece.statement);
      const domain = binding?.domain ?? context.defaultDomain;
      return Object.freeze({
        statement: piece.statement,
        citations: Object.freeze(piece.citations),
        supportKind,
        ...(domain === undefined ? {} : { domain }),
        ...(binding?.cardId === undefined ? {} : { cardId: binding.cardId }),
      });
    });
    return Object.freeze({
      requirementId: requirement.id,
      deliverableId: binding?.deliverableId ?? requirement.id,
      obligationId: binding?.obligationId ?? requirement.id,
      required: binding?.required ?? true,
      sourceCoverage: requirement.coverage,
      segments: Object.freeze(segments),
    });
  });
  return Object.freeze({
    preamble: Object.freeze(preamble),
    sections: Object.freeze(sections),
    coverage: aggregateRequiredCoverage(sections),
  });
}

export function renderStructuredAnswer(answer: StructuredAnswer): string {
  const seen = new Set<string>();
  const retained = retainCoherentOrderedSegments(
    answer.sections.flatMap((section) => section.segments),
  ).flatMap((segment) => {
      const statement = normalizeRenderedStatement(segment.statement);
      const fingerprint = statementFingerprint(statement);
      if (fingerprint === "" || seen.has(fingerprint)) return [];
      seen.add(fingerprint);
      return [statement];
    });
  if (retained.length === 0) return "";
  const body = retained.length === 1
    ? retained[0]!
    : retained.map((statement) =>
        `- ${statement.replace(/\n/gu, "\n  ")}`).join("\n");
  return [...answer.preamble, body].join("\n");
}

function retainCoherentOrderedSegments(
  segments: readonly StructuredAnswerSegment[],
): readonly StructuredAnswerSegment[] {
  let expectedStep = 1;
  let sequenceStarted = false;
  return segments.filter((segment) => {
    const step = leadingOrderedStep(segment.statement);
    if (step === undefined) return true;
    if (step === 1) {
      sequenceStarted = true;
      expectedStep = 2;
      return true;
    }
    if (sequenceStarted && step === expectedStep) {
      expectedStep += 1;
      return true;
    }
    return false;
  });
}

function leadingOrderedStep(value: string): number | undefined {
  const match = value.match(
    /(?:^|\n)\s*(?:(?:[^：:\n]{0,40})(?:步骤|流程|阶段|顺序|清单|要点|做法|方法|如下)[^：:\n]{0,12}[：:]\s*)?[（(]?([1-9]\d{0,2})[.、．)）]\s*/u,
  );
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

function aggregateRequiredCoverage(
  sections: readonly StructuredAnswerSection[],
): KnowledgeCoverage {
  const required = sections.filter((section) => section.required);
  if (
    required.length === 0 ||
    required.every((section) => section.segments.length === 0)
  ) {
    return "none";
  }
  return required.every((section) =>
    section.sourceCoverage === "complete" && section.segments.length > 0)
    ? "complete"
    : "partial";
}

function splitSupportedSegments(answer: string): {
  readonly preamble: string[];
  readonly segments: Array<{
    readonly statement: string;
    readonly citations: number[];
  }>;
} {
  const pieces = normalizeTrailingCitationPlacement(answer)
    .split(/\r?\n+/u)
    .flatMap(splitAnswerLineSegments)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const segments: Array<{ statement: string; citations: number[] }> = [];
  const preamble: string[] = [];
  const headings: string[] = [];
  for (const piece of pieces) {
    if (piece === SYNTHESIS_DISCLOSURE) {
      if (!preamble.includes(piece)) preamble.push(piece);
      continue;
    }
    if (isPureStructuralHeading(piece)) {
      headings.push(piece);
      continue;
    }
    const statement = headings.length === 0
      ? piece
      : `${headings.join("\n")}\n${piece}`;
    headings.length = 0;
    segments.push({
      statement,
      citations: stableUnique(
        [...statement.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
      ),
    });
  }
  return { preamble, segments };
}

function isPureStructuralHeading(text: string): boolean {
  return /^(?:#{1,6}\s+\S[^\n]*|\*\*[^*\n]+\*\*[:：]?)$/u.test(text) &&
    !/\[\d+\]/u.test(text);
}

function inferSupportKind(statement: string): StructuredAnswerSupportKind {
  return /根据正式知识库中多篇资料综合归纳/u.test(statement)
    ? "synthesized"
    : "direct";
}

function normalizeRenderedStatement(value: string): string {
  return value
    .split("\n")
    .map((line) => line
      .replace(
        /^\s*(?:[-*+]\s+|(?:\d{1,3}|[一二三四五六七八九十百]+)[.、．)）]\s*|[（(](?:\d{1,3}|[一二三四五六七八九十百]+)[）)]\s*)/u,
        "",
      )
      .trim())
    .filter(Boolean)
    .join("\n")
    .replace(/^\s*(?:并且|并|同时|此外|另外|而且|其次|最后|也|还)[，,、:：]\s*/u, "")
    .trim();
}

function statementFingerprint(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\[\d+\]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
