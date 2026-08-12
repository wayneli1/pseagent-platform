import type { AnswerResult, Scope } from "./contracts.js";
import {
  isUnambiguouslyGeneralPresalesQuestion,
  isUnambiguouslyProfessionalQuestion,
} from "./router.js";

const EXPLICIT_MISSING_INPUT_PATTERN =
  /(?:没有|没(?:有|拿到|确认|提供)|未(?:提供|确认|拿到)|未知|不知道|只有|只(?:有|知道|见过|凭)|仅(?:有|凭))/u;
const UNCONDITIONAL_COMMITMENT_PATTERN = /(?:保证|承诺|断定|认定|宣布)/u;
const ASSESSMENT_REQUEST_PATTERN = /(?:确认|判断|预测|给出|改成)/u;
const ABSOLUTE_CONCLUSION_PATTERN =
  /(?:所有|全部|任何|永久|一次.{0,8}成功|固定|一定|必然|绝不|绝不会|没有任何|不存在任何|立即|最终|完整|已经|就是|绝对|本(?:月|季度|年)|\d+\s*个|[一二三四五六七八九十百千万]+个|绿灯)/u;
const REQUEST_START_PATTERN = /请|直接/u;
const GENERAL_FALLBACK_PATTERN =
  /(?:客户|销售|售前|决策人|联系人|价格|价值|演示|预算|黄灯|绿灯|谈判|商机|机会|报名|互动|BATNA|MTL)/iu;

export type UnsupportedCommitmentDecision = {
  readonly result: AnswerResult;
};

/**
 * Refuses only an absolute conclusion whose required inputs are explicitly
 * absent in the user's own question. Ordinary evidence-gap questions continue
 * to the knowledge pipeline so useful methods and formal boundaries can still
 * be returned.
 */
export function evaluateUnsupportedCommitment(
  question: string,
): UnsupportedCommitmentDecision | undefined {
  const normalized = question.normalize("NFKC").trim();
  if (!EXPLICIT_MISSING_INPUT_PATTERN.test(normalized)) return undefined;
  const requestStart = normalized.search(REQUEST_START_PATTERN);
  if (requestStart < 0) return undefined;
  const request = normalized.slice(requestStart);
  const unconditional = UNCONDITIONAL_COMMITMENT_PATTERN.test(request);
  const absoluteAssessment = ASSESSMENT_REQUEST_PATTERN.test(request) &&
    ABSOLUTE_CONCLUSION_PATTERN.test(request);
  if (!unconditional && !absoluteAssessment) return undefined;

  const missingInputs = normalizeDisplayClause(normalized.slice(0, requestStart));
  const verificationSubject = neutralizeRequestedConclusion(request);
  if (missingInputs === "" || verificationSubject === "") return undefined;
  const scope = deterministicBoundaryScope(normalized);
  return {
    result: {
      scope,
      status: "answered",
      policyDisposition: "refused",
      answer: [
        "边界：现有信息不足，不能确认或保证所请求的绝对结论。",
        `已知缺口：${missingInputs}。`,
        `核验对象（非结论）：${verificationSubject}。`,
        "下一步：应补齐上述输入，核对适用版本、范围、责任人与时间点，并通过可审计的测试、联调、演练或事实记录验证后再形成结论。",
      ].join("\n"),
      references: [],
    },
  };
}

function neutralizeRequestedConclusion(value: string): string {
  return normalizeDisplayClause(value
    .replace(/^请\s*(?:直接\s*)?/u, "")
    .replace(/^直接\s*/u, "")
    .replace(/^(?:保证|承诺|确认|断定|认定|宣布|判断|预测|给出|给|把)\s*/u, "")
    .replace(/(?:绝对不会失败|不存在任何|没有任何|绝不会|绝不|都能|只需)/gu, " ")
    .replace(/(?:保证|承诺|确认|断定|认定|宣布|判断|预测|给出|改成)/gu, " ")
    .replace(/(?:所有|全部|任何|永久|一次|固定|一定|必然|立即|当前|已经|就是|可以|完整|最终)/gu, " "));
}

function normalizeDisplayClause(value: string): string {
  return value
    .replace(/^[\s，,；;。！？!?：:]+|[\s，,；;。！？!?：:]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function deterministicBoundaryScope(question: string): Exclude<Scope, "normal"> {
  if (isUnambiguouslyGeneralPresalesQuestion(question)) return "general";
  if (isUnambiguouslyProfessionalQuestion(question)) return "professional";
  return GENERAL_FALLBACK_PATTERN.test(question) ? "general" : "professional";
}
