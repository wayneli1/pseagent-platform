import type {
  AnswerResult,
  AnswerStatus,
  Coverage,
  FinalAction,
  Reference,
  Scope,
} from "./contracts.js";

export const NOT_COVERED_TEXT = "当前知识库暂未覆盖该问题，暂时无法给出可靠答案。";
export const KNOWLEDGE_UNAVAILABLE_TEXT = "知识问答服务暂时不可用，请稍后重试。";
export const GENERAL_UNAVAILABLE_TEXT = "问答服务暂时不可用，请稍后重试。";
export const PARTIAL_LIMITATION_TEXT = "知识库尚未覆盖问题的其余部分。";

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
): AnswerResult {
  const status = deriveStatus(
    action.requirements.map((requirement) => requirement.coverage),
    references.length,
  );
  const relatedContext = action.requirements
    .flatMap((requirement) => requirement.relatedContext ?? [])
    .map((item) => item.statement.trim())
    .filter(Boolean);
  if (status === "not_covered" && relatedContext.length > 0 && references.length > 0) {
    const conclusion = action.requirements
      .map((requirement) => requirement.answer.trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      scope,
      status,
      answer: [
        "正式知识库相关信息：",
        relatedContext.join("\n\n"),
        "覆盖结论：",
        conclusion,
        "正式知识库资料来源：",
        formatSources(references),
      ].join("\n\n"),
      references: [...references],
    };
  }
  const answer = action.requirements
    .map((requirement) => requirement.answer.trim())
    .filter(Boolean)
    .join("\n\n");
  return formatAnswerResult({
    scope,
    status,
    answer: status === "not_covered" ? "" : answer,
    references: status === "not_covered" ? [] : references,
  });
}

export function unavailableResult(scope: Scope): AnswerResult {
  return formatAnswerResult({ scope, status: "temporarily_unavailable", answer: "", references: [] });
}

export function formatAnswerResult(input: {
  readonly scope: Scope;
  readonly status: AnswerStatus;
  readonly answer: string;
  readonly references: readonly Reference[];
}): AnswerResult {
  if (input.status === "not_covered") {
    if (!input.answer.trim() || input.references.length === 0) {
      return { scope: input.scope, status: input.status, answer: NOT_COVERED_TEXT, references: [] };
    }
    return {
      scope: input.scope,
      status: input.status,
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

  let answer = input.answer.trim();
  if (input.status === "partially_answered" && !hasLimitation(answer)) {
    answer = `${answer}\n\n${PARTIAL_LIMITATION_TEXT}`;
  }
  const sources = input.references
    .map((reference) => `[${reference.index}] ${reference.title} — ${reference.project}/${reference.path}`)
    .join("\n");
  return {
    scope: input.scope,
    status: input.status,
    answer: `${answer}\n\n资料来源：\n${sources}`,
    references: [...input.references],
  };
}

function formatSources(references: readonly Reference[]): string {
  return references
    .map((reference) => `[${reference.index}] ${reference.title} — ${reference.project}/${reference.path}`)
    .join("\n");
}

function hasLimitation(answer: string): boolean {
  return /(未覆盖|无法|不足|有限|其余|尚未|仅能|只能|缺少)/u.test(answer);
}
