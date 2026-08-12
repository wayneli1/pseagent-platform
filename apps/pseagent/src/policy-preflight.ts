import { z } from "zod";
import type { AnswerResult, Scope } from "./contracts.js";
import type { ModelClient } from "./model-client.js";
import {
  containsRiskActionOrProtectedObject,
  createPolicyEscalationDecision,
  evaluateProhibitedRequest,
} from "./request-policy.js";

export type PolicyDecisionKind = "allowed" | "prohibited" | "uncertain";

export interface PolicyRefusalContract {
  readonly ruleId: string;
  readonly scope: Exclude<Scope, "normal">;
  readonly boundary: string;
  readonly protectedInterest: string;
  readonly safeAlternative: string;
  readonly escalation: string;
}

export interface PolicySemanticClassifier {
  classify(input: {
    readonly question: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly decision: PolicyDecisionKind;
    readonly ruleId?: string;
  }>;
}

export const POLICY_CONTRACT_VERSION = "policy-contract-v1";

const policySemanticDecisionSchema = z.object({
  decision: z.enum(["allowed", "prohibited", "uncertain"]),
  ruleId: z.string().trim().min(1).max(128).optional(),
}).strict();

const POLICY_CLASSIFIER_PROMPT = `你是企业售前系统的安全策略分类器。只判断用户请求本身，不回答请求。
prohibited：要求绕过审批或权限、访问未授权敏感数据、暴露真实凭据、逃避审计、篡改或隐瞒记录、伪造客户/授权/结果、行贿或使用非法来源信息。
allowed：明确是防御、检测、合规处置、已授权且可审计的受控测试。
uncertain：动作、授权、数据范围或目的不足以安全判断。
输出严格 JSON：{"decision":"allowed|prohibited|uncertain","ruleId":"简短规则标识"}。`;

export class ModelPolicySemanticClassifier implements PolicySemanticClassifier {
  constructor(private readonly model: ModelClient) {}

  async classify(input: {
    readonly question: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly decision: PolicyDecisionKind; readonly ruleId?: string }> {
    const result = await this.model.completeJson({
      messages: [
        { role: "system", content: POLICY_CLASSIFIER_PROMPT },
        { role: "user", content: input.question },
      ],
      schema: policySemanticDecisionSchema,
      schemaDescription: "pse_policy_semantic_decision",
      signal: input.signal,
    });
    return result.ruleId === undefined
      ? { decision: result.decision }
      : { decision: result.decision, ruleId: result.ruleId };
  }
}

export async function evaluatePolicyPreflight(input: {
  readonly question: string;
  readonly classifier?: PolicySemanticClassifier;
  readonly signal: AbortSignal;
}): Promise<{
  readonly kind: PolicyDecisionKind;
  readonly result?: AnswerResult;
}> {
  const deterministic = evaluateProhibitedRequest(input.question);
  if (deterministic !== undefined) {
    return { kind: "prohibited", result: deterministic.result };
  }
  if (!containsRiskActionOrProtectedObject(input.question)) {
    return { kind: "allowed" };
  }
  if (input.classifier === undefined) {
    return uncertainResult(input.question, "policy_classifier_unavailable");
  }
  try {
    const semantic = await raceWithSignal(
      () => input.classifier!.classify({
        question: input.question,
        signal: input.signal,
      }),
      input.signal,
    );
    if (semantic.decision === "allowed") return { kind: "allowed" };
    const ruleId = semantic.ruleId ?? (semantic.decision === "prohibited"
      ? "semantic_policy_prohibited"
      : "semantic_policy_uncertain");
    const decision = createPolicyEscalationDecision({
      ruleId,
      scope: inferPolicyScope(input.question),
    });
    return { kind: semantic.decision, result: decision.result };
  } catch {
    return uncertainResult(input.question, "policy_classifier_unavailable");
  }
}

function uncertainResult(question: string, ruleId: string): {
  readonly kind: "uncertain";
  readonly result: AnswerResult;
} {
  return {
    kind: "uncertain",
    result: createPolicyEscalationDecision({
      ruleId,
      scope: inferPolicyScope(question),
    }).result,
  };
}

function inferPolicyScope(question: string): Exclude<Scope, "normal"> {
  return /(?:回扣|报价|竞品|建议书|合同|验收|客户确认|销售)/u.test(question)
    ? "general"
    : "professional";
}

async function raceWithSignal<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const promise = call();
  let removeAbortListener: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("policy_preflight_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    removeAbortListener();
  }
}
