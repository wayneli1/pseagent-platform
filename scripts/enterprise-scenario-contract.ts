import type { PseAnswerExecution } from "../apps/pseagent/src/answer-service.js";

export interface EnterpriseScenarioExpectation {
  readonly scopes: readonly string[];
  readonly statuses: readonly string[];
  readonly knowledgeCoverages?: readonly string[];
  readonly caseAssessabilities?: readonly string[];
  readonly minimumReferences?: number;
  readonly maximumReferences?: number;
  readonly gapClasses?: readonly string[];
  readonly gapReasons?: readonly string[];
  readonly obligations?: readonly {
    readonly id: string;
    readonly anyOf: readonly string[];
  }[];
  readonly forbiddenTerms?: readonly string[];
  readonly forbiddenPatterns?: readonly string[];
}

export interface EnterpriseScenario {
  readonly id: string;
  readonly userId: string;
  readonly profile: string;
  readonly turn: number;
  readonly question: string;
  readonly consistencyKey?: string;
  readonly expected: EnterpriseScenarioExpectation;
}

export interface ScenarioCheck {
  readonly category:
    | "availability"
    | "routing"
    | "evidence"
    | "coverage"
    | "gap_attribution"
    | "obligation"
    | "safety";
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ScenarioEvaluation {
  readonly passed: boolean;
  readonly score: number;
  readonly checks: readonly ScenarioCheck[];
}

export function evaluateEnterpriseScenario(
  scenario: EnterpriseScenario,
  execution: PseAnswerExecution,
): ScenarioEvaluation {
  const expected = scenario.expected;
  const result = execution.result;
  const checks: ScenarioCheck[] = [];
  add(checks, "availability", "final-result", execution.stopReason === "final", execution.stopReason);
  add(
    checks,
    "availability",
    "non-empty-answer",
    result.answer.trim().length > 0,
    `answerChars=${result.answer.trim().length}`,
  );
  add(
    checks,
    "routing",
    "scope",
    expected.scopes.includes(result.scope),
    `actual=${result.scope}; expected=${expected.scopes.join("|")}`,
  );
  add(
    checks,
    "coverage",
    "status",
    expected.statuses.includes(result.status),
    `actual=${result.status}; expected=${expected.statuses.join("|")}`,
  );

  if (expected.knowledgeCoverages !== undefined) {
    add(
      checks,
      "coverage",
      "knowledge-axis",
      result.knowledgeCoverage !== undefined &&
        expected.knowledgeCoverages.includes(result.knowledgeCoverage),
      `actual=${result.knowledgeCoverage ?? "missing"}; expected=${expected.knowledgeCoverages.join("|")}`,
    );
  }
  if (expected.caseAssessabilities !== undefined) {
    add(
      checks,
      "coverage",
      "case-axis",
      result.caseAssessability !== undefined &&
        expected.caseAssessabilities.includes(result.caseAssessability),
      `actual=${result.caseAssessability ?? "missing"}; expected=${expected.caseAssessabilities.join("|")}`,
    );
  }
  if (expected.minimumReferences !== undefined) {
    add(
      checks,
      "evidence",
      "minimum-references",
      result.references.length >= expected.minimumReferences,
      `actual=${result.references.length}; minimum=${expected.minimumReferences}`,
    );
  }
  if (expected.maximumReferences !== undefined) {
    add(
      checks,
      "evidence",
      "maximum-references",
      result.references.length <= expected.maximumReferences,
      `actual=${result.references.length}; maximum=${expected.maximumReferences}`,
    );
  }

  const gaps = execution.coverageGaps ?? [];
  const inferredInputGap = gaps.length === 0 &&
    result.caseAssessability === "insufficient" &&
    /(?:缺少判断|缺失信息|客户输入|信息不足|尚未确认)/u.test(result.answer);
  const inferredKnowledgeGap = gaps.length === 0 &&
    result.knowledgeCoverage === "none" &&
    result.status === "not_covered";
  if (expected.gapClasses !== undefined) {
    add(
      checks,
      "gap_attribution",
      "gap-class",
      gaps.some((gap) => expected.gapClasses!.includes(gap.gapClass)) ||
        (inferredInputGap && expected.gapClasses.includes("input")) ||
        (inferredKnowledgeGap && expected.gapClasses.includes("knowledge")),
      `actual=${unique(gaps.map((gap) => gap.gapClass)).join("|") || (inferredInputGap ? "input(external-axis)" : inferredKnowledgeGap ? "knowledge(external-axis)" : "none")}; expectedAny=${expected.gapClasses.join("|")}`,
    );
  }
  if (expected.gapReasons !== undefined) {
    add(
      checks,
      "gap_attribution",
      "gap-reason",
      gaps.some((gap) => expected.gapReasons!.includes(gap.reason)) ||
        (inferredInputGap && expected.gapReasons.includes("required_customer_input_missing")),
      `actual=${unique(gaps.map((gap) => gap.reason)).join("|") || (inferredInputGap ? "required_customer_input_missing(external-axis)" : "none")}; expectedAny=${expected.gapReasons.join("|")}`,
    );
  }
  if (gaps.length > 0) {
    const exposed = gaps.filter((gap) => contains(result.answer, gap.missingAspect)).length;
    add(
      checks,
      "gap_attribution",
      "specific-gap-visible",
      exposed > 0,
      `visible=${exposed}; gaps=${gaps.length}`,
    );
  }

  for (const obligation of expected.obligations ?? []) {
    const matched = obligation.anyOf.filter((term) => contains(result.answer, term));
    add(
      checks,
      "obligation",
      obligation.id,
      matched.length > 0,
      matched.length > 0
        ? `matched=${matched.join("|")}`
        : `expectedAny=${obligation.anyOf.join("|")}`,
    );
  }
  for (const term of expected.forbiddenTerms ?? []) {
    add(
      checks,
      "safety",
      `forbidden-term:${term}`,
      !contains(result.answer, term),
      `term=${term}`,
    );
  }
  for (const pattern of expected.forbiddenPatterns ?? []) {
    const regex = new RegExp(pattern, "iu");
    add(
      checks,
      "safety",
      `forbidden-pattern:${pattern}`,
      !regex.test(result.answer),
      `pattern=${pattern}`,
    );
  }

  const passedCount = checks.filter((check) => check.passed).length;
  return {
    passed: checks.every((check) => check.passed),
    score: checks.length === 0 ? 1 : passedCount / checks.length,
    checks,
  };
}

export function evaluateConsistency(
  records: readonly {
    readonly scenario: EnterpriseScenario;
    readonly execution?: PseAnswerExecution;
  }[],
): readonly ScenarioCheck[] {
  const groups = new Map<string, typeof records>();
  for (const record of records) {
    const key = record.scenario.consistencyKey;
    if (key === undefined) continue;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].flatMap(([key, group]) => {
    if (group.length < 2 || group.some((record) => record.execution === undefined)) {
      return [{
        category: "coverage" as const,
        id: `consistency:${key}`,
        passed: false,
        detail: "fewer_than_two_successful_executions",
      }];
    }
    const signatures = group.map((record) => directionSignature(record.execution!));
    const baseline = signatures[0]!;
    const passed = signatures.every((signature) => signature === baseline);
    return [{
      category: "coverage" as const,
      id: `consistency:${key}`,
      passed,
      detail: signatures.join(" <> "),
    }];
  });
}

export function parseEnterpriseScenarios(value: unknown): EnterpriseScenario[] {
  if (!Array.isArray(value)) throw new Error("enterprise_scenarios_must_be_array");
  const scenarios = value.map((item) => parseScenario(item));
  const ids = new Set<string>();
  const turns = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`duplicate_scenario_id:${scenario.id}`);
    ids.add(scenario.id);
    const turnKey = `${scenario.userId}:${scenario.turn}`;
    if (turns.has(turnKey)) throw new Error(`duplicate_user_turn:${turnKey}`);
    turns.add(turnKey);
  }
  return scenarios;
}

function parseScenario(value: unknown): EnterpriseScenario {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_enterprise_scenario");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.userId !== "string" ||
    typeof item.profile !== "string" ||
    typeof item.turn !== "number" ||
    !Number.isInteger(item.turn) ||
    item.turn < 1 ||
    typeof item.question !== "string" ||
    item.expected === null ||
    typeof item.expected !== "object"
  ) {
    throw new Error("invalid_enterprise_scenario");
  }
  return value as EnterpriseScenario;
}

function directionSignature(execution: PseAnswerExecution): string {
  const statusDirection = execution.result.status === "answered"
    ? "supported"
    : execution.result.status === "partially_answered"
      ? "qualified"
      : execution.result.status === "not_covered"
        ? "unsupported"
        : "unavailable";
  const inputMissing = execution.coverageGaps?.some((gap) =>
    gap.reason === "required_customer_input_missing") === true;
  return [
    execution.result.scope,
    statusDirection,
    execution.result.knowledgeCoverage ?? "no-knowledge-axis",
    execution.result.caseAssessability ?? "no-case-axis",
    inputMissing ? "input-missing" : "input-not-missing",
  ].join(":");
}

function add(
  checks: ScenarioCheck[],
  category: ScenarioCheck["category"],
  id: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ category, id, passed, detail });
}

function contains(text: string, term: string): boolean {
  return normalize(text).includes(normalize(term));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
