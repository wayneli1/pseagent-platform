export interface AcceptanceCase {
  readonly id: string;
  readonly matrixType: string;
  readonly question: string;
  readonly session: string;
  readonly useConversationContext?: boolean;
  readonly resetConversationBefore?: boolean;
  readonly expectedScope: "professional" | "general" | "normal";
  readonly expectedTarget: string;
  readonly expectedCardId?: string;
  readonly expectedEvidence: readonly string[];
  readonly requiredFactGroups: readonly (readonly string[])[];
  readonly forbiddenClaims: readonly string[];
  readonly expectedBehavior: string;
  readonly baselineAssessment?: string;
  readonly expectedIssueCenter: boolean;
}

export interface AcceptanceMatrix {
  readonly batchId: string;
  readonly userDisplayName: string;
  readonly model: "deepseek_v4_flash";
  readonly cases: readonly AcceptanceCase[];
  readonly supplementCases: readonly AcceptanceCase[];
  readonly postPublishCases: readonly AcceptanceCase[];
}

export type AcceptancePhase = "phase1" | "supplement" | "post_publish";

export function validateAcceptanceMatrix(
  value: unknown,
  options: {
    readonly phase1Count: number;
    readonly supplementCount: number;
    readonly postPublishCount: number;
    readonly forbiddenQuestions?: readonly string[];
  },
): AcceptanceMatrix {
  if (!isRecord(value)) throw new Error("enterprise_e2e_matrix_invalid");
  const matrix = value as unknown as AcceptanceMatrix;
  if (
    typeof matrix.batchId !== "string" || matrix.batchId.trim() === "" ||
    typeof matrix.userDisplayName !== "string" || matrix.userDisplayName.trim() === "" ||
    matrix.model !== "deepseek_v4_flash" ||
    !Array.isArray(matrix.cases) ||
    !Array.isArray(matrix.supplementCases) ||
    !Array.isArray(matrix.postPublishCases)
  ) {
    throw new Error("enterprise_e2e_matrix_invalid");
  }
  if (
    matrix.cases.length !== options.phase1Count ||
    matrix.supplementCases.length !== options.supplementCount ||
    matrix.postPublishCases.length !== options.postPublishCount
  ) {
    throw new Error("enterprise_e2e_matrix_case_count_invalid");
  }
  const allCases = [...matrix.cases, ...matrix.supplementCases, ...matrix.postPublishCases];
  for (const testCase of allCases) assertAcceptanceCase(testCase);
  if (new Set(allCases.map((item) => item.id)).size !== allCases.length) {
    throw new Error("enterprise_e2e_matrix_duplicate_id");
  }
  const questionKeys = allCases.map((item) => normalizeQuestion(item.question));
  if (new Set(questionKeys).size !== questionKeys.length) {
    throw new Error("enterprise_e2e_matrix_duplicate_question");
  }
  const forbidden = new Set((options.forbiddenQuestions ?? []).map(normalizeQuestion));
  if (questionKeys.some((question) => forbidden.has(question))) {
    throw new Error("enterprise_e2e_matrix_reuses_forbidden_question");
  }
  return matrix;
}

export function selectAcceptanceCases(
  matrix: AcceptanceMatrix,
  phase: AcceptancePhase,
  caseId: string | undefined,
  options: { readonly requireSingleCase: boolean },
): readonly AcceptanceCase[] {
  const phaseCases = phase === "supplement"
    ? matrix.supplementCases
    : phase === "post_publish"
      ? matrix.postPublishCases
      : matrix.cases;
  const normalizedId = caseId?.trim();
  if (normalizedId === undefined || normalizedId === "") {
    if (options.requireSingleCase) throw new Error("enterprise_e2e_case_id_required");
    return phaseCases;
  }
  const selected = phaseCases.find((testCase) => testCase.id === normalizedId);
  if (selected === undefined) throw new Error(`enterprise_e2e_case_unknown:${normalizedId}`);
  return [selected];
}

export function normalizeQuestion(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function acceptanceFactGroupCovered(
  answer: string,
  question: string,
  alternatives: readonly string[],
): boolean {
  const compactAnswer = normalizeQuestion(answer);
  return alternatives.some((term) => {
    const compactTerm = normalizeQuestion(term);
    if (compactAnswer.includes(compactTerm)) return true;
    if (semanticAcceptanceEquivalent(compactAnswer, compactTerm)) return true;
    const termWords = wordTokens(term);
    if (
      termWords.length >= 2 &&
      termWords.every((word) => /^\p{Script=Han}+$/u.test(word)) &&
      orderedChineseConceptsCovered(compactAnswer, termWords)
    ) {
      return true;
    }
    if (termWords.length !== 2 || termWords[0] === termWords[1]) return false;
    const questionWords = wordTokens(question);
    for (let index = 0; index + 1 < questionWords.length; index += 1) {
      if (
        questionWords[index] === termWords[1] &&
        questionWords[index + 1] === termWords[0] &&
        compactAnswer.includes(normalizeQuestion(`${questionWords[index]}${questionWords[index + 1]}`))
      ) {
        return true;
      }
    }
    return false;
  });
}

function orderedChineseConceptsCovered(answer: string, words: readonly string[]): boolean {
  const semanticConnector = "[\\p{Script=Han}]{0,4}";
  return new RegExp(words.map(escapeRegExp).join(semanticConnector), "u").test(answer);
}

function semanticAcceptanceEquivalent(answer: string, term: string): boolean {
  if (term === "现状") {
    return /(?:当前|目前|现阶段)(?:情况|状态|问题|面临|正在)/u.test(answer);
  }
  if (term === "具体场景") {
    return /具体(?:事实|事件|例子|案例|场景|情境|问题|现象)/u.test(answer);
  }
  if (term === "最近一次") {
    return /最近(?:一次|发生|出现|遇到|案例|事件|例子)/u.test(answer);
  }
  if (term === "影响") {
    return /(?:受影响|实际后果|业务后果|损失|代价)/u.test(answer);
  }
  if (term === "结果") {
    return /(?:预期|期望|改善后|解决后)(?:收益|成效|效果|结果)|(?:预期收益|期望收益|收益或差距)/u
      .test(answer);
  }
  if (term === "非负权" || term === "边权非负") {
    return /(?:没有|不存在|不含|无)负权边|(?:所有|全部)?边权(?:均|都)?非负/u
      .test(answer);
  }
  if (term === "当前最短" || term === "最小暂定距离") {
    return /当前(?:暂定)?距离最小|当前最小(?:暂定)?距离|最小(?:的)?暂定距离/u
      .test(answer);
  }
  const universal = /^所有(.+)$/u.exec(term);
  if (universal?.[1]) {
    const subject = escapeRegExp(universal[1]);
    return new RegExp(
      `(?:所有的?|每(?:一)?(?:个|条|项|种|类|次)?).{0,4}${subject}`,
      "u",
    ).test(answer);
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function wordTokens(value: string): string[] {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return [...segmenter.segment(value.normalize("NFKC"))]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.toLocaleLowerCase("zh-CN"));
}

function assertAcceptanceCase(value: unknown): asserts value is AcceptanceCase {
  if (!isRecord(value)) throw new Error("enterprise_e2e_case_invalid");
  const scope = value.expectedScope;
  if (
    typeof value.id !== "string" || value.id.trim() === "" ||
    typeof value.matrixType !== "string" || value.matrixType.trim() === "" ||
    typeof value.question !== "string" || value.question.trim() === "" ||
    typeof value.session !== "string" || value.session.trim() === "" ||
    !["professional", "general", "normal"].includes(String(scope)) ||
    typeof value.expectedTarget !== "string" || value.expectedTarget.trim() === "" ||
    typeof value.expectedBehavior !== "string" || value.expectedBehavior.trim() === "" ||
    typeof value.expectedIssueCenter !== "boolean" ||
    !isStringArray(value.expectedEvidence) ||
    !isStringArray(value.forbiddenClaims) ||
    !Array.isArray(value.requiredFactGroups) ||
    value.requiredFactGroups.length === 0 ||
    !value.requiredFactGroups.every((group) => isStringArray(group) && group.length > 0)
  ) {
    throw new Error(`enterprise_e2e_case_invalid:${String(value.id ?? "unknown")}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
