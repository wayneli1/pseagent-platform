const INTERNAL_PUBLIC_TERMS = [
  { label: "Coremail MCP", pattern: /Coremail\s+MCP/iu },
  { label: "LLM Wiki", pattern: /LLM\s+Wiki/iu },
  { label: "内部 Wiki", pattern: /内部\s*Wiki/iu },
] as const;

/**
 * Knowledge pages may contain operator-facing retrieval instructions. They are
 * evidence data, not wording that may be copied into a formal user answer.
 */
export function sanitizeFormalAnswer(value: string): string {
  return value
    .replace(
      /必要时\s*(?:应当?|可|需要)?\s*(?:回退)?\s*(?:查询|检索|调用|访问)\s*Coremail\s+MCP/giu,
      "必要时进一步核实正式资料",
    )
    .replace(
      /(?:回退)?\s*(?:查询|检索|调用|访问)\s*Coremail\s+MCP/giu,
      "进一步核实正式资料",
    )
    .replace(/Coremail\s+MCP/giu, "补充历史资料")
    .replace(/LLM\s+Wiki/giu, "正式知识库")
    .replace(/内部\s*Wiki/giu, "正式知识库")
    .replace(/[ \t]+([，。；：])/gu, "$1")
    .trim();
}

export function internalPublicAnswerTerms(value: string): readonly string[] {
  return INTERNAL_PUBLIC_TERMS
    .filter(({ pattern }) => pattern.test(value))
    .map(({ label }) => label);
}
