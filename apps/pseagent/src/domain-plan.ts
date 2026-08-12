import type { KnowledgePlan, Scope } from "./contracts.js";
import type { ResolvedQuestion } from "./question-resolver.js";
import {
  adaptTaskSpecToKnowledgePlan,
  type TaskPlanAdapterInactiveReason,
} from "./task-plan-adapter.js";
import type {
  KnowledgeDomain,
  TaskSpec,
  TaskSpecGuardResult,
} from "./task-spec.js";
import type { RequirementEvidenceCondition } from "./evidence-ledger.js";
import {
  applyAnswerCardPoliciesToPlan,
  type AnswerCardObligationPolicy,
} from "./answer-card-task-spec-adapter.js";
import {
  compileAtomicObligationContract,
  materializeGuardedTaskSpec,
  type AtomicObligationContract,
} from "./atomic-obligation.js";

export const KNOWLEDGE_DOMAIN_ORDER = [
  "coremail-professional",
  "presales-general",
] as const satisfies readonly KnowledgeDomain[];

const SCOPE_BY_DOMAIN: Readonly<Record<KnowledgeDomain, Exclude<Scope, "normal">>> = {
  "coremail-professional": "professional",
  "presales-general": "general",
};
const MAX_MERGED_REQUIREMENTS = 6;

export interface DomainRequirementBinding {
  readonly domain: KnowledgeDomain;
  readonly requirementId: KnowledgePlan["requirements"][number]["id"];
  readonly deliverableId: string;
  readonly obligationId: string;
  readonly order: number;
  readonly cardId?: string;
  readonly cardTitle?: string;
  readonly cardObligationId?: string;
  readonly requiredConcepts?: readonly string[];
  readonly forbiddenClaims?: readonly string[];
  readonly preferredEvidencePaths?: readonly string[];
  readonly answerTemplate?: string;
}

export interface DomainKnowledgePlan {
  readonly domain: KnowledgeDomain;
  readonly scope: Exclude<Scope, "normal">;
  readonly plan: KnowledgePlan;
  readonly bindings: readonly DomainRequirementBinding[];
  readonly conditions?: readonly RequirementEvidenceCondition[];
}

export type DomainPlanInactiveReason =
  | TaskPlanAdapterInactiveReason
  | "invalid_domain_binding";

export type DomainPlanResult =
  | {
      readonly activated: true;
      readonly plans: readonly DomainKnowledgePlan[];
    }
  | {
      readonly activated: false;
      readonly reason: DomainPlanInactiveReason;
      readonly applicableObligationCount: number;
    };

export interface DomainPlanInput {
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
  readonly obligationContract: AtomicObligationContract;
  readonly guardResult: TaskSpecGuardResult;
  readonly cardPolicies?: readonly AnswerCardObligationPolicy[];
}

interface RequiredObligation {
  readonly deliverable: TaskSpec["deliverables"][number];
  readonly obligation: TaskSpec["deliverables"][number]["obligations"][number];
  readonly order: number;
}

export function deriveDomainKnowledgePlans(input: DomainPlanInput): DomainPlanResult {
  if (!input.guardResult.ok) {
    return {
      activated: false,
      reason: "guard_rejected",
      applicableObligationCount: 0,
    };
  }

  const obligationContract = input.obligationContract ??
    compileAtomicObligationContract({
      resolvedQuestion: input.resolvedQuestion,
      taskSpec: input.taskSpec,
    });
  const taskSpec = materializeGuardedTaskSpec({
    original: input.taskSpec,
    contract: obligationContract,
  });
  const required = requiredObligations(taskSpec);
  const mergedClaimCount = required.reduce(
    (count, { obligation }) => count + obligation.domains.length,
    0,
  );
  if (mergedClaimCount > MAX_MERGED_REQUIREMENTS) {
    return {
      activated: false,
      reason: "requirement_limit_exceeded",
      applicableObligationCount: mergedClaimCount,
    };
  }
  if (required.length === 0) {
    return {
      activated: false,
      reason: "no_applicable_obligations",
      applicableObligationCount: 0,
    };
  }

  const policyByObligation = new Map(
    (input.cardPolicies ?? []).map((policy) => [policy.obligationId, policy] as const),
  );
  const plans: DomainKnowledgePlan[] = [];
  for (const domain of requiredKnowledgeDomains(obligationContract)) {
    const applicable = required.filter(({ obligation }) =>
      obligation.domains.includes(domain));
    if (applicable.length === 0) continue;

    const scope = SCOPE_BY_DOMAIN[domain];
    const adapted = adaptTaskSpecToKnowledgePlan({
      scope,
      resolvedQuestion: input.resolvedQuestion,
      taskSpec: taskSpecForDomain(taskSpec, domain),
      guardResult: input.guardResult,
    });
    if (!adapted.activated) {
      return {
        activated: false,
        reason: adapted.reason,
        applicableObligationCount: adapted.applicableObligationCount,
      };
    }

    const expectedIds = applicable.map(({ obligation }) => obligation.id);
    if (
      adapted.plan.requirements.length !== applicable.length ||
      adapted.obligationIds.length !== applicable.length ||
      adapted.obligationIds.some((id, index) => id !== expectedIds[index])
    ) {
      return {
        activated: false,
        reason: "invalid_domain_binding",
        applicableObligationCount: applicable.length,
      };
    }

    plans.push({
      domain,
      scope,
      plan: applyAnswerCardPoliciesToPlan({
        plan: adapted.plan,
        obligationIds: adapted.obligationIds,
        policies: input.cardPolicies ?? [],
      }),
      conditions: adapted.conditions,
      bindings: applicable.map((item, index) => ({
        domain,
        requirementId: adapted.plan.requirements[index]!.id,
        deliverableId: item.deliverable.id,
        obligationId: item.obligation.id,
        order: item.order,
        ...bindingPolicy(policyByObligation.get(item.obligation.id)),
      })),
    });
  }

  if (plans.length === 0) {
    return {
      activated: false,
      reason: "no_applicable_obligations",
      applicableObligationCount: 0,
    };
  }
  return { activated: true, plans };
}

export function requiredKnowledgeDomains(
  contract: AtomicObligationContract,
): readonly KnowledgeDomain[] {
  const required = new Set(contract.obligations
    .filter((obligation) => obligation.required)
    .flatMap((obligation) => obligation.domains));
  return KNOWLEDGE_DOMAIN_ORDER.filter((domain) => required.has(domain));
}

function bindingPolicy(
  policy: AnswerCardObligationPolicy | undefined,
): Pick<
  DomainRequirementBinding,
  | "cardId"
  | "cardTitle"
  | "cardObligationId"
  | "requiredConcepts"
  | "forbiddenClaims"
  | "preferredEvidencePaths"
  | "answerTemplate"
> {
  if (policy === undefined) return {};
  return {
    cardId: policy.cardId,
    ...(policy.cardTitle === undefined ? {} : { cardTitle: policy.cardTitle }),
    cardObligationId: policy.cardObligationId,
    requiredConcepts: policy.requiredConcepts,
    forbiddenClaims: policy.forbiddenClaims,
    preferredEvidencePaths: policy.preferredEvidencePaths,
    ...(policy.answerTemplate === undefined
      ? {}
      : { answerTemplate: policy.answerTemplate }),
  };
}

function requiredObligations(taskSpec: TaskSpec): readonly RequiredObligation[] {
  const required: RequiredObligation[] = [];
  for (const deliverable of taskSpec.deliverables) {
    if (!deliverable.required) continue;
    for (const obligation of deliverable.obligations) {
      if (!obligation.required) continue;
      required.push({ deliverable, obligation, order: required.length });
    }
  }
  return required;
}

function taskSpecForDomain(taskSpec: TaskSpec, domain: KnowledgeDomain): TaskSpec {
  return {
    ...taskSpec,
    deliverables: taskSpec.deliverables.flatMap((deliverable) => {
      if (!deliverable.required) return [];
      const obligations = deliverable.obligations.flatMap((obligation) =>
        obligation.required && obligation.domains.includes(domain)
          ? [{ ...obligation, domains: [domain] }]
          : []);
      return obligations.length === 0 ? [] : [{ ...deliverable, obligations }];
    }),
  };
}
