import {
  agentActionSchema,
  finalOnlyActionSchema,
  type AnswerResult,
  type FinalAction,
  type KnowledgePlan,
  type KnowledgeRequirement,
  type ToolAction,
} from "./contracts.js";
import type {
  KnowledgeGraphResult,
  KnowledgePage,
  KnowledgeSearchResult,
  ProjectKey,
} from "./knowledge-session.js";
import {
  notCoveredRequirementAnswer,
  verifyKnowledgeCoverage,
  type CoverageEvidenceDocument,
  type CoverageVerificationSummary,
  type CoverageVerifierInput,
} from "./coverage-verifier.js";
import {
  InvalidModelPayloadError,
  ModelUnavailableError,
  type ModelClient,
} from "./model-client.js";
import { knowledgeAgentMessages } from "./prompts.js";
import { ReferenceRegistry } from "./references.js";
import { formatKnowledgeFinal, unavailableResult } from "./response.js";
import {
  recordDiagnostic,
  type DiagnosticTrace,
} from "./diagnostics.js";

export const MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT = 3;
export const DIRECT_ONLY_READ_LIMIT = 3;
export const SYNTHESIS_ALLOWED_READ_LIMIT = 6;
export const MAX_BATCH_READS_PER_REQUIREMENT = 2;
export const MAX_GRAPH_ACTIONS_PER_REQUIREMENT = 1;
export const MAX_AGENT_TURNS_PER_REQUIREMENT = 7;
const RRF_K = 60;
const SEED_TOP_K = 10;

export function readLimitFor(requirement: KnowledgeRequirement): number {
  return requirement.evidenceMode === "synthesis_allowed"
    ? SYNTHESIS_ALLOWED_READ_LIMIT
    : DIRECT_ONLY_READ_LIMIT;
}

export interface KnowledgeAgentSession {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly purpose: string;
  readonly schema: string;
  search(query: string, topK: number, signal?: AbortSignal): Promise<KnowledgeSearchResult>;
  graph(path: string, topK: number, signal?: AbortSignal): Promise<KnowledgeGraphResult>;
  readPage(path: string, signal?: AbortSignal): Promise<KnowledgePage>;
  compactPage(page: KnowledgePage, matchedTerms: string[]): string;
}

export interface KnowledgeAgentInput {
  readonly scope: "professional" | "general";
  readonly question: string;
  readonly conversationContext?: string;
  readonly plan: KnowledgePlan;
  readonly model: ModelClient;
  readonly session: KnowledgeAgentSession;
  readonly deadlineAt?: number;
  readonly trace?: DiagnosticTrace;
  readonly signal?: AbortSignal;
  readonly verifyCoverage?: (
    input: CoverageVerifierInput,
  ) => Promise<FinalAction>;
}

type Candidate = {
  readonly path: string;
  title: string;
  rrfScore: number;
  readonly sourceQueries: Set<string>;
  readonly rankings: Array<{ query: string; rank: number; score: number }>;
  readonly matchedTerms: Set<string>;
  readonly snippets: Set<string>;
  readonly graphRelations: Set<string>;
  requirementSpecificMatch: boolean;
};

type RequirementState = {
  readonly requirement: KnowledgeRequirement;
  readonly queries: Set<string>;
  readonly candidatePaths: Map<string, Candidate>;
  readonly readPaths: Set<string>;
  readonly directReadPaths: Set<string>;
  readonly citationIndexes: Set<number>;
  supplementalSearches: number;
  graphActions: number;
  noGainRounds: number;
  searchStopped: boolean;
  lastCoverageGateDirectReadCount?: number;
};

type AgentState = {
  readonly actionFingerprints: Set<string>;
  readonly requirements: Map<string, RequirementState>;
  readonly references: ReferenceRegistry;
  readonly evidenceDocuments: Map<
    string,
    Map<number, Omit<CoverageEvidenceDocument, "requirementId" | "citation">>
  >;
  readonly observations: string[];
  citationRepairAttempts: number;
  breadthRepairAttempts: number;
  invalidPayloadTurnRetries: number;
  forceFinal: boolean;
  successfulSeedSearches: number;
};

export async function runKnowledgeAgent(input: KnowledgeAgentInput): Promise<AnswerResult> {
  const state = createAgentState(input);
  await executeSeedSearches(input, state);
  if (state.successfulSeedSearches === 0) {
    recordDiagnostic(input.trace, { event: "stop", reason: "seed_unavailable" });
    return unavailableResult(input.scope);
  }
  await preloadPresalesDutyFacets(input, state);

  const maxTurns = Math.min(
    40,
    2 + input.plan.requirements.length * MAX_AGENT_TURNS_PER_REQUIREMENT,
  );
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (deadlineReached(input)) state.forceFinal = true;
    const finalOnly = state.forceFinal || turn === maxTurns || !hasAvailableToolAction(state);
    let action;
    try {
      action = await requestAgentAction(input, state, turn, maxTurns, finalOnly);
    } catch (error) {
      if (error instanceof InvalidModelPayloadError) {
        const recoveryAction = finalOnly
          ? undefined
          : recoveryReadAction(state);
        if (recoveryAction === undefined) {
          const hasReadEvidence = [...state.requirements.values()].some(
            (requirementState) =>
              requirementState.directReadPaths.size > 0,
          );
          if (
            hasReadEvidence &&
            state.invalidPayloadTurnRetries === 0 &&
            turn < maxTurns &&
            !deadlineReached(input)
          ) {
            state.invalidPayloadTurnRetries += 1;
            state.forceFinal = true;
            observe(state, {
              type: "invalid_model_payload_recovered_with_final_retry",
            });
            continue;
          }
          return fallbackNotCovered(input, "invalid_model_payload");
        }
        action = recoveryAction;
        observe(state, {
          type: "invalid_model_payload_recovered_with_seed_read",
          pages: recoveryAction.input.pages,
        });
      } else {
        recordDiagnostic(input.trace, { event: "stop", reason: "model_unavailable" });
        return unavailableResult(input.scope);
      }
    }

    if (action.action === "final") {
      const normalizedAction = dropUnsupportedRelatedContext(
        normalizeFinalCitationMetadata(action, input.plan),
        state,
      );
      const breadthRepair = presalesDutyBreadthRepair(
        input.question,
        normalizedAction,
        state,
      );
      if (
        breadthRepair !== undefined &&
        state.breadthRepairAttempts < 3 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.breadthRepairAttempts += 1;
        observe(state, {
          type: "presales_duty_facets_missing",
          labels: breadthRepair.labels,
          pages: breadthRepair.action?.input.pages ?? [],
        });
        if (breadthRepair.action !== undefined) {
          await executeBatchReads(breadthRepair.action, input, state);
        }
        state.forceFinal = true;
        continue;
      }
      shareFinalAnswerEvidence(input, state, normalizedAction);
      const pendingReviews = pendingEvidenceReviews(normalizedAction, state);
      if (pendingReviews.length > 0 && !deadlineReached(input)) {
        for (const requirementId of pendingReviews) {
          const requirementState = state.requirements.get(requirementId);
          if (requirementState) {
            requirementState.lastCoverageGateDirectReadCount =
              requirementState.directReadPaths.size;
          }
        }
        observe(state, {
          type: "coverage_gate_requires_read",
          requirements: pendingReviews,
        });
        if (turn < maxTurns) continue;
        return fallbackNotCovered(input, "turn_budget_exhausted");
      }
      const validation = state.references.validateFinal(
        normalizedAction,
        input.plan.requirements,
        evidenceByRequirement(state),
      );
      if (!validation.ok) {
        recordDiagnostic(input.trace, {
          event: "validation",
          result: "rejected",
          reason: validation.reason,
          repairAttempt: state.citationRepairAttempts + 1,
        });
        if (state.citationRepairAttempts === 0 && turn < maxTurns) {
          state.citationRepairAttempts += 1;
          state.forceFinal = true;
          observe(state, { type: "invalid_citations", reason: validation.reason });
          continue;
        }
        return fallbackNotCovered(input, "invalid_final");
      }
      recordCoverage(
        input,
        normalizedAction,
        "draft",
        deadlineReached(input) ? "deadline" : "final",
      );
      let auditedAction: FinalAction;
      let verificationSummaries:
        readonly CoverageVerificationSummary[] | undefined;
      try {
        auditedAction = await (
          input.verifyCoverage ?? verifyKnowledgeCoverage
        )({
          question: input.question,
          plan: input.plan,
          draft: normalizedAction,
          evidence: coverageEvidence(normalizedAction, state),
          model: input.model,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          onVerified(summaries) {
            verificationSummaries = summaries;
          },
        });
      } catch (error) {
        if (!(error instanceof ModelUnavailableError)) {
          return fallbackNotCovered(input, "coverage_verifier_invalid");
        }
        recordDiagnostic(input.trace, {
          event: "stop",
          reason: "coverage_verifier_unavailable",
        });
        return unavailableResult(input.scope);
      }
      const auditedValidation = state.references.validateFinal(
        auditedAction,
        input.plan.requirements,
        evidenceByRequirement(state),
      );
      if (!auditedValidation.ok) {
        recordDiagnostic(input.trace, {
          event: "validation",
          result: "rejected",
          reason: auditedValidation.reason,
          repairAttempt: 1,
        });
        return fallbackNotCovered(input, "coverage_verifier_invalid");
      }
      recordCoverage(
        input,
        auditedAction,
        "verified",
        deadlineReached(input) ? "deadline" : "final",
        verificationSummaries,
      );
      return formatKnowledgeFinal(
        input.scope,
        auditedAction,
        state.references.resolve(auditedAction.citations),
      );
    }
    if (finalOnly) {
      observe(state, { type: "tool_not_allowed" });
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (state.actionFingerprints.has(fingerprint)) {
      const requirementIds = actionRequirementIds(action);
      observe(state, {
        type: "duplicate_action",
        requirementIds,
        action: fingerprint,
      });
      for (const requirementId of requirementIds) {
        stopSearchAfterNoGain(state.requirements.get(requirementId));
      }
      continue;
    }
    state.actionFingerprints.add(fingerprint);

    try {
      await executeToolAction(action, input, state);
    } catch {
      const requirementIds = actionRequirementIds(action);
      observe(state, {
        type: "tool_unavailable",
        requirementIds,
        tool: action.tool,
      });
      for (const requirementId of requirementIds) {
        stopSearchAfterNoGain(state.requirements.get(requirementId));
      }
    }
  }
  return fallbackNotCovered(input, "turn_budget_exhausted");
}

function recoveryReadAction(
  state: AgentState,
): Extract<ToolAction, { tool: "kb.read_pages" }> | undefined {
  const pages = [...state.requirements.values()].flatMap((requirementState) => {
    if (
      requirementState.directReadPaths.size >=
        readLimitFor(requirementState.requirement)
    ) {
      return [];
    }
    const candidate = sortedCandidates(requirementState)
      .find((item) => !requirementState.readPaths.has(item.path));
    return candidate === undefined
      ? []
      : [{
          requirementId: requirementState.requirement.id,
          path: candidate.path,
        }];
  });
  if (pages.length === 0) return undefined;
  return {
    action: "tool",
    tool: "kb.read_pages",
    input: { pages },
  };
}

function fallbackNotCovered(
  input: KnowledgeAgentInput,
  reason:
    | "invalid_model_payload"
    | "invalid_final"
    | "turn_budget_exhausted"
    | "coverage_verifier_invalid",
): AnswerResult {
  recordDiagnostic(input.trace, {
    event: "fallback",
    reason,
    outcome: "not_covered",
  });
  return formatKnowledgeFinal(input.scope, {
    action: "final",
    requirements: input.plan.requirements.map((requirement) => ({
      id: requirement.id,
      coverage: "none",
      answer: notCoveredRequirementAnswer(requirement.question),
      citations: [],
    })),
    citations: [],
  }, []);
}

function createAgentState(input: KnowledgeAgentInput): AgentState {
  return {
    actionFingerprints: new Set(),
    requirements: new Map(input.plan.requirements.map((requirement) => [
      requirement.id,
      {
        requirement,
        queries: new Set([
          ...requirement.queries.map(normalizeQuery),
          normalizeQuery(input.question),
        ]),
        candidatePaths: new Map(),
        readPaths: new Set(),
        directReadPaths: new Set(),
        citationIndexes: new Set(),
        supplementalSearches: 0,
        graphActions: 0,
        noGainRounds: 0,
        searchStopped: false,
      },
    ])),
    references: new ReferenceRegistry(input.session.project, input.session.revision),
    evidenceDocuments: new Map(input.plan.requirements.map((requirement) => [
      requirement.id,
      new Map(),
    ])),
    observations: [],
    citationRepairAttempts: 0,
    breadthRepairAttempts: 0,
    invalidPayloadTurnRetries: 0,
    forceFinal: false,
    successfulSeedSearches: 0,
  };
}

const PRESALES_DUTY_FACETS = [
  {
    label: "需求诊断与需求访谈",
    answer: /需求诊断|需求访谈/u,
    title: /诊断式对话框架|需求诊断|需求访谈/u,
  },
  {
    label: "方案组织与解决方案",
    answer: /方案组织|解决方案/u,
    title: /^解决方案销售$|方案组织|购买愿景/u,
  },
  {
    label: "产品演示与技术证明",
    answer: /产品演示|技术证明/u,
    title: /愿景演示.*技术证明|技术证明.*愿景演示/u,
  },
  {
    label: "客户关系与可信顾问",
    answer: /客户关系|可信顾问/u,
    title: /可信顾问/u,
  },
  {
    label: "冲突沟通与异议处理",
    answer: /冲突沟通|异议处理/u,
    title: /冲突沟通|异议处理/u,
  },
  {
    label: "机会管理与项目推进",
    answer: /机会管理|项目推进/u,
    title: /机会质量.*客户证据|客户证据.*机会质量|机会管理|项目推进/u,
  },
] as const;

function presalesDutyBreadthRepair(
  question: string,
  action: FinalAction,
  state: AgentState,
): {
  readonly labels: readonly string[];
  readonly action?: Extract<ToolAction, { tool: "kb.read_pages" }>;
} | undefined {
  if (!/(?:售前工程师|售前).{0,8}(?:工作职责|岗位职责|职责|负责)/u.test(question)) {
    return undefined;
  }
  const labels: string[] = [];
  const pages: Array<{ requirementId: string; path: string }> = [];
  const reserved = new Map<string, number>();
  for (const result of action.requirements) {
    if (result.coverage !== "complete") continue;
    const requirementState = state.requirements.get(result.id);
    if (
      requirementState?.requirement.evidenceMode !== "synthesis_allowed"
    ) {
      continue;
    }
    const candidates = sortedCandidates(requirementState);
    for (const facet of PRESALES_DUTY_FACETS) {
      if (facet.answer.test(result.answer)) continue;
      const matching = candidates.filter((candidate) =>
        facet.title.test(candidate.title));
      const alreadyRead = matching.some((candidate) =>
        requirementState.readPaths.has(candidate.path));
      const pending = reserved.get(result.id) ?? 0;
      const unread = matching.find((candidate) =>
        !requirementState.readPaths.has(candidate.path) &&
        !pages.some((page) =>
          page.requirementId === result.id && page.path === candidate.path));
      const canRead =
        unread !== undefined &&
        pending < MAX_BATCH_READS_PER_REQUIREMENT &&
        requirementState.directReadPaths.size + pending <
          readLimitFor(requirementState.requirement);
      if (!alreadyRead && !canRead) continue;
      labels.push(facet.label);
      if (canRead && unread !== undefined) {
        pages.push({
          requirementId: result.id,
          path: unread.path,
        });
        reserved.set(result.id, pending + 1);
      }
    }
  }
  if (labels.length === 0) return undefined;
  return {
    labels,
    ...(pages.length === 0
      ? {}
      : {
          action: {
            action: "tool",
            tool: "kb.read_pages",
            input: { pages },
          },
        }),
  };
}

async function preloadPresalesDutyFacets(
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  if (
    !/(?:售前工程师|售前).{0,8}(?:工作职责|岗位职责|职责|负责)/u.test(
      input.question,
    ) ||
    deadlineReached(input)
  ) {
    return;
  }
  for (const requirementState of state.requirements.values()) {
    if (requirementState.requirement.evidenceMode !== "synthesis_allowed") {
      continue;
    }
    const candidates = sortedCandidates(requirementState);
    const selected: Array<{ requirementId: string; path: string }> = [];
    for (const facet of PRESALES_DUTY_FACETS) {
      const candidate = candidates.find((item) =>
        facet.title.test(item.title) &&
        !selected.some((page) => page.path === item.path));
      if (candidate !== undefined) {
        selected.push({
          requirementId: requirementState.requirement.id,
          path: candidate.path,
        });
      }
    }
    if (selected.length !== PRESALES_DUTY_FACETS.length) continue;
    observe(state, {
      type: "presales_duty_seed_facets_selected",
      pages: selected,
    });
    for (
      let index = 0;
      index < selected.length && !deadlineReached(input);
      index += MAX_BATCH_READS_PER_REQUIREMENT
    ) {
      await executeBatchReads(
        {
          action: "tool",
          tool: "kb.read_pages",
          input: {
            pages: selected.slice(
              index,
              index + MAX_BATCH_READS_PER_REQUIREMENT,
            ),
          },
        },
        input,
        state,
      );
    }
    if (selected.every((page) => requirementState.readPaths.has(page.path))) {
      state.forceFinal = true;
    }
  }
}

async function executeSeedSearches(input: KnowledgeAgentInput, state: AgentState): Promise<void> {
  const globalQuery = input.question.trim();
  recordDiagnostic(input.trace, {
    event: "search",
    requirementId: "GLOBAL",
    phase: "seed",
    query: globalQuery,
  });
  const globalSearch = input.session.search(globalQuery, SEED_TOP_K, toolSignal(input))
    .then((result) => {
      state.successfulSeedSearches += 1;
      return { query: globalQuery, result };
    })
    .catch(() => {
      observe(state, {
        type: "global_question_search_unavailable",
        query: globalQuery,
      });
      return undefined;
    });

  const requirementSearches = [...state.requirements.values()].map(async (requirementState) => {
    const seedQueries = expandSeedQueries(requirementState.requirement.queries);
    for (const query of seedQueries) requirementState.queries.add(normalizeQuery(query));
    const results = await Promise.all(seedQueries.map(async (query) => {
      recordDiagnostic(input.trace, {
        event: "search",
        requirementId: requirementState.requirement.id,
        phase: "seed",
        query,
      });
      try {
        const result = await input.session.search(query, SEED_TOP_K, toolSignal(input));
        state.successfulSeedSearches += 1;
        return { query, result };
      } catch {
        observe(state, {
          type: "seed_search_unavailable",
          requirementId: requirementState.requirement.id,
          query,
        });
        return undefined;
      }
    }));
    return {
      requirementState,
      successful: results.filter(
      (item): item is { query: string; result: KnowledgeSearchResult } => item !== undefined,
      ),
    };
  });

  const [globalResult, requirementResults] = await Promise.all([
    globalSearch,
    Promise.all(requirementSearches),
  ]);
  for (const { requirementState, successful } of requirementResults) {
    let gained = mergeSearchResults(requirementState, successful);
    if (globalResult) {
      gained = mergeSearchResults(requirementState, [globalResult], false) || gained;
    }
    if (!gained) requirementState.noGainRounds = 1;
    observeCandidates(state, requirementState, "seed_search_result", input.trace);
  }
}

async function requestAgentAction(
  input: KnowledgeAgentInput,
  state: AgentState,
  turn: number,
  maxTurns: number,
  finalOnly: boolean,
) {
  const messages = knowledgeAgentMessages({
      question: input.question,
      ...(input.conversationContext === undefined ? {} : { conversationContext: input.conversationContext }),
      purpose: input.session.purpose,
      schema: input.session.schema,
      plan: input.plan,
      requirementEvidence: requirementEvidence(state),
      observations: state.observations,
      references: state.references.list(),
      remainingTurns: maxTurns - turn + 1,
      remainingRetrievalActions: countRemainingToolActions(state),
      finalOnly,
    });
  const request = (repairReason?: string) => input.model.completeJson({
      messages: repairReason !== undefined
        ? [...messages, {
            role: "user" as const,
            content: finalOnly
              ? `上一次输出不符合 Schema：${repairReason}。只输出合法 final JSON；必须完整列出规划中的每个 requirement 及其 coverage/citations，不要解释。`
              : `上一次输出不符合 Schema：${repairReason}。只输出一个合法 JSON 动作；单页/搜索/图谱工具输入必须包含 requirementId，批量读页必须使用 pages 数组且每项包含 requirementId/path，final 必须完整列出逐项 requirements，不要解释。`,
          }]
        : messages,
      schema: finalOnly ? finalOnlyActionSchema : agentActionSchema,
      schemaDescription: finalOnly ? "pse_final_action" : "pse_agent_action",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  let repairReason: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request(repairReason);
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) throw error;
      recordRejectedModelPayload(input, error, attempt);
      if (attempt === 3) throw error;
      repairReason = modelPayloadRepairReason(error);
    }
  }
  throw new InvalidModelPayloadError();
}

function recordRejectedModelPayload(
  input: KnowledgeAgentInput,
  error: InvalidModelPayloadError,
  attempt: number,
): void {
  recordDiagnostic(input.trace, {
    event: "model_payload",
    result: "rejected",
    reason: error.code,
    repairAttempt: attempt,
    ...(error.schemaDescription === undefined
      ? {}
      : { schemaDescription: error.schemaDescription }),
    ...(error.rawPayload === undefined
      ? {}
      : { rawPayload: error.rawPayload }),
    ...(error.rawPayloadLength === undefined
      ? {}
      : { rawPayloadLength: error.rawPayloadLength }),
    ...(error.finishReason === undefined
      ? {}
      : { finishReason: error.finishReason }),
  });
}

function modelPayloadRepairReason(error: InvalidModelPayloadError): string {
  const details = [
    error.code,
    ...(error.finishReason === undefined
      ? []
      : [`finish_reason=${error.finishReason}`]),
    ...(error.rawPayloadLength === undefined
      ? []
      : [`raw_length=${error.rawPayloadLength}`]),
  ];
  if (error.finishReason === "abort" || error.finishReason === "length") {
    details.push(
      "上一次 JSON 在闭合前被服务中止；删除重复说明，每个 requirement.answer 控制在 600 个汉字以内，优先完整输出全部字段并闭合 JSON",
    );
  }
  return details.join(";");
}

async function executeToolAction(
  action: ToolAction,
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  if (action.tool === "kb.read_pages") {
    await executeBatchReads(action, input, state);
    return;
  }
  const requirementState = state.requirements.get(action.input.requirementId);
  if (!requirementState) {
    observe(state, {
      type: "unknown_requirement",
      requirementId: action.input.requirementId,
    });
    return;
  }
  switch (action.tool) {
    case "kb.search":
      await executeSupplementalSearch(action, input, state, requirementState);
      return;
    case "kb.read_page":
      await executeRead(action, input, state, requirementState);
      return;
    case "kb.graph":
      await executeGraph(action, input, state, requirementState);
      return;
    default:
      assertNever(action);
  }
}

async function executeBatchReads(
  action: Extract<ToolAction, { tool: "kb.read_pages" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  const reserved = new Map<string, number>();
  const accepted: Array<{
    page: { requirementId: string; path: string };
    requirementState: RequirementState;
  }> = [];
  for (const page of action.input.pages) {
    const requirementState = state.requirements.get(page.requirementId);
    if (!requirementState) {
      observe(state, {
        type: "unknown_requirement",
        requirementId: page.requirementId,
      });
      continue;
    }
    if (!requirementState.candidatePaths.has(page.path)) {
      observe(state, {
        type: "path_not_candidate_for_requirement",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    const pending = reserved.get(page.requirementId) ?? 0;
    if (pending >= MAX_BATCH_READS_PER_REQUIREMENT) {
      observe(state, {
        type: "batch_read_deferred_for_requirement",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    if (
      requirementState.readPaths.has(page.path) ||
      requirementState.directReadPaths.size + pending >=
        readLimitFor(requirementState.requirement)
    ) {
      observe(state, {
        type: "requirement_read_budget_exhausted",
        requirementId: page.requirementId,
        path: page.path,
      });
      continue;
    }
    reserved.set(page.requirementId, pending + 1);
    accepted.push({ page, requirementState });
  }
  await Promise.all(accepted.map(async ({ page, requirementState }) => {
    try {
      await executeRead(
        {
          action: "tool",
          tool: "kb.read_page",
          input: page,
        },
        input,
        state,
        requirementState,
      );
    } catch {
      observe(state, {
        type: "tool_unavailable",
        requirementId: page.requirementId,
        tool: "kb.read_page",
      });
      stopSearchAfterNoGain(requirementState);
    }
  }));
}

async function executeSupplementalSearch(
  action: Extract<ToolAction, { tool: "kb.search" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
  requirementState: RequirementState,
): Promise<void> {
  const query = normalizeQuery(action.input.query);
  if (
    requirementState.searchStopped ||
    requirementState.supplementalSearches >= MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT
  ) {
    observe(state, {
      type: "requirement_search_budget_exhausted",
      requirementId: requirementState.requirement.id,
    });
    return;
  }
  if (requirementState.queries.has(query)) {
    observe(state, {
      type: "duplicate_query",
      requirementId: requirementState.requirement.id,
      query: action.input.query,
    });
    stopSearchAfterNoGain(requirementState);
    return;
  }
  requirementState.queries.add(query);
  requirementState.supplementalSearches += 1;
  recordDiagnostic(input.trace, {
    event: "search",
    requirementId: requirementState.requirement.id,
    phase: "supplemental",
    query: action.input.query,
  });
  const result = await input.session.search(action.input.query, action.input.topK, toolSignal(input));
  const gained = mergeSearchResults(requirementState, [{ query: action.input.query, result }]);
  requirementState.noGainRounds = gained ? 0 : requirementState.noGainRounds + 1;
  if (requirementState.noGainRounds >= 2) requirementState.searchStopped = true;
  observeCandidates(state, requirementState, "supplemental_search_result", input.trace);
}

async function executeRead(
  action: Extract<ToolAction, { tool: "kb.read_page" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
  requirementState: RequirementState,
): Promise<void> {
  if (!requirementState.candidatePaths.has(action.input.path)) {
    observe(state, {
      type: "path_not_candidate_for_requirement",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  if (
    requirementState.readPaths.has(action.input.path) ||
    requirementState.directReadPaths.size >=
      readLimitFor(requirementState.requirement)
  ) {
    observe(state, {
      type: "requirement_read_budget_exhausted",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  const page = await input.session.readPage(action.input.path, toolSignal(input));
  if (
    requirementState.readPaths.has(page.path) ||
    requirementState.directReadPaths.size >=
      readLimitFor(requirementState.requirement)
  ) {
    return;
  }
  const reference = state.references.register({
    project: input.session.project,
    revision: input.session.revision,
    page,
  });
  requirementState.readPaths.add(page.path);
  requirementState.directReadPaths.add(page.path);
  requirementState.citationIndexes.add(reference.index);
  const candidate = requirementState.candidatePaths.get(page.path);
  const terms = [
    requirementState.requirement.question,
    ...requirementState.requirement.queries,
    ...(candidate === undefined ? [] : candidate.matchedTerms),
  ];
  const content = input.session.compactPage(page, terms);
  state.evidenceDocuments.get(requirementState.requirement.id)?.set(
    reference.index,
    {
      title: page.title,
      path: page.path,
      content,
    },
  );
  observe(state, {
    type: "read_page",
    requirementId: requirementState.requirement.id,
    reference: reference.index,
    path: page.path,
    content,
  });
  recordDiagnostic(input.trace, {
    event: "read",
    requirementId: requirementState.requirement.id,
    path: page.path,
    citation: reference.index,
    sectionHeadings: markdownHeadings(content),
  });
  shareReadEvidence(
    input,
    state,
    requirementState.requirement.id,
    page.path,
    reference.index,
    content,
  );
}

function shareReadEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
  fromRequirementId: string,
  path: string,
  citation: number,
  content: string,
): void {
  for (const [toRequirementId, requirementState] of state.requirements) {
    const targetCandidate = requirementState.candidatePaths.get(path);
    if (
      toRequirementId === fromRequirementId ||
      !targetCandidate?.requirementSpecificMatch ||
      requirementState.readPaths.has(path)
    ) {
      continue;
    }
    requirementState.readPaths.add(path);
    requirementState.citationIndexes.add(citation);
    const reference = state.references.resolve([citation])[0];
    if (reference !== undefined) {
      state.evidenceDocuments.get(toRequirementId)?.set(citation, {
        title: reference.title,
        path: reference.path,
        content,
      });
    }
    observe(state, {
      type: "evidence_shared",
      fromRequirementId,
      toRequirementId,
      path,
      citation,
    });
    recordDiagnostic(input.trace, {
      event: "evidence_shared",
      fromRequirementId,
      toRequirementId,
      path,
      citation,
    });
  }
}

function shareFinalAnswerEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
  action: FinalAction,
): void {
  for (const requirement of action.requirements) {
    const targetState = state.requirements.get(requirement.id);
    const targetDocuments = state.evidenceDocuments.get(requirement.id);
    if (targetState === undefined || targetDocuments === undefined) continue;
    for (const citation of requirement.citations) {
      if (targetState.citationIndexes.has(citation)) continue;
      const source = [...state.evidenceDocuments.entries()].find(
        ([sourceRequirementId, documents]) =>
          sourceRequirementId !== requirement.id && documents.has(citation),
      );
      const document = source?.[1].get(citation);
      if (source === undefined || document === undefined) continue;
      targetState.citationIndexes.add(citation);
      targetState.readPaths.add(document.path);
      targetDocuments.set(citation, document);
      observe(state, {
        type: "evidence_shared",
        fromRequirementId: source[0],
        toRequirementId: requirement.id,
        path: document.path,
        citation,
      });
      recordDiagnostic(input.trace, {
        event: "evidence_shared",
        fromRequirementId: source[0],
        toRequirementId: requirement.id,
        path: document.path,
        citation,
      });
    }
  }
}

async function executeGraph(
  action: Extract<ToolAction, { tool: "kb.graph" }>,
  input: KnowledgeAgentInput,
  state: AgentState,
  requirementState: RequirementState,
): Promise<void> {
  if (
    requirementState.graphActions >= MAX_GRAPH_ACTIONS_PER_REQUIREMENT ||
    !requirementState.candidatePaths.has(action.input.path)
  ) {
    observe(state, {
      type: "requirement_graph_action_rejected",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  requirementState.graphActions += 1;
  const result = await input.session.graph(action.input.path, action.input.topK, toolSignal(input));
  const gained = mergeGraphResult(requirementState, action.input.path, result);
  requirementState.noGainRounds = gained ? 0 : requirementState.noGainRounds + 1;
  if (requirementState.noGainRounds >= 2) requirementState.searchStopped = true;
  observeCandidates(state, requirementState, "graph_result", input.trace);
}

function mergeSearchResults(
  requirementState: RequirementState,
  searches: readonly { query: string; result: KnowledgeSearchResult }[],
  requirementSpecific = true,
): boolean {
  let gained = false;
  for (const { query, result } of searches) {
    result.hits.forEach((hit, index) => {
      const existing = requirementState.candidatePaths.get(hit.path);
      if (!existing) gained = true;
      const candidate = existing ?? {
        path: hit.path,
        title: hit.title,
        rrfScore: 0,
        sourceQueries: new Set<string>(),
        rankings: [],
        matchedTerms: new Set<string>(),
        snippets: new Set<string>(),
        graphRelations: new Set<string>(),
        requirementSpecificMatch: false,
      };
      candidate.title = hit.title;
      candidate.requirementSpecificMatch ||= requirementSpecific;
      candidate.rrfScore += 1 / (RRF_K + index + 1);
      candidate.sourceQueries.add(query);
      candidate.rankings.push({ query, rank: index + 1, score: hit.score });
      for (const term of hit.matchedTerms) candidate.matchedTerms.add(term);
      if (hit.snippet) candidate.snippets.add(hit.snippet.slice(0, 500));
      requirementState.candidatePaths.set(hit.path, candidate);
    });
  }
  return gained;
}

function mergeGraphResult(
  requirementState: RequirementState,
  sourcePath: string,
  result: KnowledgeGraphResult,
): boolean {
  let gained = false;
  result.hits.forEach((hit, index) => {
    const existing = requirementState.candidatePaths.get(hit.path);
    if (!existing) gained = true;
    const candidate = existing ?? {
      path: hit.path,
      title: hit.title,
      rrfScore: 0,
      sourceQueries: new Set<string>(),
      rankings: [],
      matchedTerms: new Set<string>(),
      snippets: new Set<string>(),
      graphRelations: new Set<string>(),
      requirementSpecificMatch: true,
    };
    candidate.title = hit.title;
    candidate.requirementSpecificMatch = true;
    candidate.rrfScore += 1 / (RRF_K + index + 1);
    candidate.sourceQueries.add(`graph:${sourcePath}`);
    candidate.graphRelations.add(hit.relation);
    requirementState.candidatePaths.set(hit.path, candidate);
  });
  return gained;
}

function observeCandidates(
  state: AgentState,
  requirementState: RequirementState,
  type: "seed_search_result" | "supplemental_search_result" | "graph_result",
  trace?: DiagnosticTrace,
): void {
  observe(state, {
    type,
    requirementId: requirementState.requirement.id,
    candidateCount: requirementState.candidatePaths.size,
  });
  recordDiagnostic(trace, {
    event: "candidates",
    requirementId: requirementState.requirement.id,
    source: type,
    candidates: sortedCandidates(requirementState).slice(0, 10).map((candidate) => ({
      path: candidate.path,
      rrfScore: roundedScore(candidate.rrfScore),
      sourceQueries: [...candidate.sourceQueries],
      graphRelations: [...candidate.graphRelations],
    })),
  });
}

function requirementEvidence(state: AgentState) {
  return [...state.requirements.values()].map((requirementState) => ({
    id: requirementState.requirement.id,
    question: requirementState.requirement.question,
    candidates: sortedCandidates(requirementState).slice(0, 10).map((candidate) => {
      const read = requirementState.readPaths.has(candidate.path);
      return {
      path: candidate.path,
      title: candidate.title,
      rrfScore: roundedScore(candidate.rrfScore),
      sourceQueries: [...candidate.sourceQueries].slice(0, 3),
      rankings: candidate.rankings.slice(0, 3),
      matchedTerms: [...candidate.matchedTerms].slice(0, 8),
      snippets: read
        ? []
        : [...candidate.snippets].slice(0, 1).map((snippet) => snippet.slice(0, 240)),
      graphRelations: [...candidate.graphRelations].slice(0, 3),
      read,
    };
    }),
    citationIndexes: [...requirementState.citationIndexes],
    remainingSearches: requirementState.searchStopped
      ? 0
      : MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT - requirementState.supplementalSearches,
    remainingReads:
      readLimitFor(requirementState.requirement) -
      requirementState.directReadPaths.size,
  }));
}

function evidenceByRequirement(state: AgentState): ReadonlyMap<string, ReadonlySet<number>> {
  return new Map([...state.requirements].map(([id, requirementState]) => [
    id,
    requirementState.citationIndexes,
  ]));
}

function coverageEvidence(
  draft: FinalAction,
  state: AgentState,
): CoverageEvidenceDocument[] {
  return draft.requirements.flatMap((requirement) =>
    requirementEvidenceCitations(requirement).flatMap((citation) => {
      const document = state.evidenceDocuments.get(requirement.id)?.get(citation);
      return document === undefined
        ? []
        : [{
            requirementId: requirement.id,
            citation,
            ...document,
          }];
    }));
}

function recordCoverage(
  input: KnowledgeAgentInput,
  action: FinalAction,
  stage: "draft" | "verified",
  stopReason: "final" | "deadline",
  summaries?: readonly CoverageVerificationSummary[],
): void {
  const summaryById = new Map(
    summaries?.map((summary) => [summary.id, summary]),
  );
  recordDiagnostic(input.trace, {
    event: "coverage",
    stage,
    requirements: action.requirements.map((requirement) => {
      const planned = input.plan.requirements.find(
        (candidate) => candidate.id === requirement.id,
      );
      const summary = summaryById.get(requirement.id);
      return {
        id: requirement.id,
        evidenceMode: planned?.evidenceMode ?? "direct_only",
        coverage: requirement.coverage,
        citations: requirementEvidenceCitations(requirement),
        ...(summary === undefined
          ? {}
          : {
              retainedDirectSegmentCount:
                summary.retainedDirectSegmentCount,
              retainedSynthesizedSegmentCount:
                summary.retainedSynthesizedSegmentCount,
              removedSegmentCount: summary.removedSegmentCount,
            }),
      };
    }),
    ...(summaries === undefined
      ? {}
      : {
          reasons: summaries.map(({ id, reason }) => ({ id, reason })),
        }),
    citations: action.citations,
    stopReason,
  });
}

function normalizeFinalCitationMetadata(
  action: FinalAction,
  plan: KnowledgePlan,
): FinalAction {
  const requirements = action.requirements.map((requirement, index) => ({
    ...requirement,
    ...(requirement.coverage === "none"
      ? {
          answer: notCoveredRequirementAnswer(
            plan.requirements[index]?.question ?? "",
          ),
          citations: [],
        }
      : {
          citations: stableUniqueNumbers(
            [...requirement.answer.matchAll(/\[(\d+)\]/gu)]
              .map((match) => Number(match[1])),
          ),
        }),
    ...(requirement.relatedContext === undefined
      ? {}
      : {
          relatedContext: requirement.relatedContext.map((related) => ({
            ...related,
            citations: stableUniqueNumbers(
              [...related.statement.matchAll(/\[(\d+)\]/gu)]
                .map((match) => Number(match[1])),
            ),
          })),
        }),
  }));
  return {
    ...action,
    requirements,
    citations: stableUniqueNumbers(
      requirements.flatMap((requirement) => requirementEvidenceCitations(requirement)),
    ),
  };
}

function dropUnsupportedRelatedContext(
  action: FinalAction,
  state: AgentState,
): FinalAction {
  const requirements = action.requirements.map((requirement) => {
    if (requirement.relatedContext === undefined) return requirement;
    const evidence = state.requirements.get(requirement.id)?.citationIndexes ??
      new Set<number>();
    const relatedContext = requirement.relatedContext.filter((related) =>
      related.citations.every((citation) => evidence.has(citation)));
    const { relatedContext: _relatedContext, ...rest } = requirement;
    return relatedContext.length === 0
      ? rest
      : { ...rest, relatedContext };
  });
  return {
    ...action,
    requirements,
    citations: stableUniqueNumbers(
      requirements.flatMap((requirement) =>
        requirementEvidenceCitations(requirement)),
    ),
  };
}

function requirementEvidenceCitations(
  requirement: FinalAction["requirements"][number],
): number[] {
  return stableUniqueNumbers([
    ...requirement.citations,
    ...(requirement.relatedContext ?? []).flatMap((item) => item.citations),
  ]);
}

function stableUniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function pendingEvidenceReviews(
  action: FinalAction,
  state: AgentState,
): string[] {
  const pending: string[] = [];
  for (const result of action.requirements) {
    if (result.coverage === "complete") continue;
    const requirementState = state.requirements.get(result.id);
    if (
      !requirementState ||
      requirementState.directReadPaths.size >=
        readLimitFor(requirementState.requirement) ||
      requirementState.lastCoverageGateDirectReadCount ===
        requirementState.directReadPaths.size
    ) {
      continue;
    }
    const hasUnreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) => !requirementState.readPaths.has(path));
    if (hasUnreadCandidate) pending.push(result.id);
  }
  return pending;
}

function sortedCandidates(requirementState: RequirementState): Candidate[] {
  return [...requirementState.candidatePaths.values()]
    .sort((left, right) =>
      candidatePathPriority(left.path, requirementState.requirement) -
        candidatePathPriority(right.path, requirementState.requirement) ||
      titleCoverageScore(
        right.title,
        requirementState.requirement,
        requirementState.queries,
      ) -
        titleCoverageScore(
          left.title,
          requirementState.requirement,
          requirementState.queries,
        ) ||
      right.rrfScore - left.rrfScore ||
      left.path.localeCompare(right.path));
}

function candidatePathPriority(path: string, requirement: KnowledgeRequirement): number {
  if (
    path.startsWith("wiki/entities/") &&
    /核心(?:能力|功能)|有哪些(?:能力|功能)|功能清单|详细介绍.*功能|是什么/u
      .test(requirement.question)
  ) {
    return -1;
  }
  const curatedPrefixes = [
    "wiki/concepts/",
    "wiki/synthesis/",
    "wiki/comparisons/",
    "wiki/comparison/",
    "wiki/findings/",
    "wiki/entities/",
  ];
  if (curatedPrefixes.some((prefix) => path.startsWith(prefix))) return 0;
  if (path.startsWith("wiki/sources/")) return 2;
  return 1;
}

const TITLE_TERM_STOPWORDS = new Set([
  "coremail",
  "邮件",
  "系统",
  "规划",
  "设计",
  "方案",
  "场景",
  "实现",
  "如何",
  "用户",
  "规模",
]);

function titleCoverageScore(
  title: string,
  requirement: KnowledgeRequirement,
  executedQueries: ReadonlySet<string>,
): number {
  const normalizedTitle = normalizeTitleText(title);
  const terms = new Set(
    [requirement.question, ...requirement.queries, ...executedQueries]
      .flatMap(titleTerms),
  );
  const matches = [...terms].filter((term) => normalizedTitle.includes(term));
  if (matches.length < 2) return 0;
  return matches.reduce((score, term) => score + Math.min(term.length, 4), 0);
}

function titleTerms(value: string): string[] {
  return value.toLocaleLowerCase("zh-CN")
    .split(/[^\p{L}\p{N}]+/gu)
    .flatMap((part) => {
      if (!/^\p{Script=Han}+$/u.test(part) || part.length <= 4) return [part];
      return Array.from({ length: part.length - 1 }, (_, index) =>
        part.slice(index, index + 2));
    })
    .map(normalizeTitleText)
    .filter((term) => term.length >= 2 && !TITLE_TERM_STOPWORDS.has(term));
}

function normalizeTitleText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
}

function hasAvailableToolAction(state: AgentState): boolean {
  return [...state.requirements.values()].some((requirementState) => {
    const unreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) => !requirementState.readPaths.has(path));
    return (
      (!requirementState.searchStopped &&
        requirementState.supplementalSearches < MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT) ||
      (unreadCandidate &&
        requirementState.directReadPaths.size <
          readLimitFor(requirementState.requirement)) ||
      (requirementState.candidatePaths.size > 0 &&
        requirementState.graphActions < MAX_GRAPH_ACTIONS_PER_REQUIREMENT)
    );
  });
}

function countRemainingToolActions(state: AgentState): number {
  let remaining = 0;
  for (const requirementState of state.requirements.values()) {
    if (!requirementState.searchStopped) {
      remaining += MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT - requirementState.supplementalSearches;
    }
    const unreadCandidates = [...requirementState.candidatePaths.keys()]
      .filter((path) => !requirementState.readPaths.has(path)).length;
    remaining += Math.min(
      unreadCandidates,
      readLimitFor(requirementState.requirement) -
        requirementState.directReadPaths.size,
    );
    if (
      requirementState.candidatePaths.size > 0 &&
      requirementState.graphActions < MAX_GRAPH_ACTIONS_PER_REQUIREMENT
    ) {
      remaining += 1;
    }
  }
  return remaining;
}

function stopSearchAfterNoGain(requirementState: RequirementState | undefined): void {
  if (!requirementState) return;
  requirementState.noGainRounds += 1;
  if (requirementState.noGainRounds >= 2) requirementState.searchStopped = true;
}

function actionFingerprint(action: ToolAction): string {
  if (action.tool === "kb.search") {
    return JSON.stringify([
      action.tool,
      action.input.requirementId,
      normalizeQuery(action.input.query),
      action.input.topK,
    ]);
  }
  return JSON.stringify([action.tool, action.input]);
}

function actionRequirementIds(action: ToolAction): string[] {
  return action.tool === "kb.read_pages"
    ? action.input.pages.map((page) => page.requirementId)
    : [action.input.requirementId];
}

function normalizeQuery(query: string): string {
  return query.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
}

function expandSeedQueries(queries: readonly string[]): string[] {
  const expanded = new Map<string, string>();
  for (const query of queries) {
    expanded.set(normalizeQuery(query), query);
    const variants = [
      query.replaceAll("注意事项", "要点"),
      query.replaceAll("关键注意", "重点"),
      query.replaceAll("操作步骤", "操作流程"),
    ];
    for (const variant of variants) {
      const normalized = normalizeQuery(variant);
      if (normalized !== normalizeQuery(query)) expanded.set(normalized, variant);
    }
    if (
      /poc/iu.test(query) &&
      (query.includes("注意事项") || query.includes("关键注意") || query.includes("要点"))
    ) {
      expanded.set(normalizeQuery("POC测试要点"), "POC测试要点");
    }
    if (
      query.includes("迁移") &&
      /(?:执行步骤|操作步骤|操作流程|流程|方法)/u.test(query)
    ) {
      const toolFocus = `${query
        .replace(/(?:执行步骤|操作步骤|操作流程|流程|方法)/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()} 工具`;
      expanded.set(normalizeQuery(toolFocus), toolFocus);
    }
  }
  return [...expanded.values()];
}

function deadlineReached(input: KnowledgeAgentInput): boolean {
  return input.deadlineAt !== undefined && Date.now() >= input.deadlineAt;
}

function toolSignal(input: KnowledgeAgentInput): AbortSignal | undefined {
  if (input.deadlineAt === undefined) return input.signal;
  const remaining = Math.max(1, input.deadlineAt - Date.now());
  const deadlineSignal = AbortSignal.timeout(remaining);
  return input.signal === undefined
    ? deadlineSignal
    : AbortSignal.any([input.signal, deadlineSignal]);
}

function observe(state: AgentState, value: unknown): void {
  const serialized = JSON.stringify(value);
  state.observations.push(serialized.length <= 10_000 ? serialized : serialized.slice(0, 10_000));
  if (state.observations.length > 30) state.observations.shift();
}

function roundedScore(score: number): number {
  return Number(score.toFixed(6));
}

function markdownHeadings(content: string): string[] {
  return [...content.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .slice(0, 4);
}

function assertNever(value: never): never {
  throw new Error(`unhandled_tool_action:${String(value)}`);
}
