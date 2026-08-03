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
import {
  normalizeTrailingCitationPlacement,
  ReferenceRegistry,
} from "./references.js";
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
const SYNTHESIS_SEED_TOP_K_LIMIT = 20;

export function readLimitFor(requirement: KnowledgeRequirement): number {
  return requirement.evidenceMode === "synthesis_allowed"
    ? Math.max(
        SYNTHESIS_ALLOWED_READ_LIMIT,
        requirement.evidenceAspects.length,
      )
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
  readonly aspectIds: Set<string>;
  requirementSpecificMatch: boolean;
};

type RequirementState = {
  readonly requirement: KnowledgeRequirement;
  readonly queries: Set<string>;
  readonly candidatePaths: Map<string, Candidate>;
  readonly readPaths: Set<string>;
  readonly directReadPaths: Set<string>;
  readonly citationIndexes: Set<number>;
  readonly readAspectIds: Set<string>;
  supplementalSearches: number;
  graphActions: number;
  noGainRounds: number;
  searchStopped: boolean;
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
  answerAspectRepairAttempts: number;
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
  await preloadBroadSynthesisEvidence(input, state);

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
          return fallbackUnavailable(input, "invalid_model_payload");
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
      shareFinalAnswerEvidence(input, state, normalizedAction);
      const answerAspectRepairs = pendingAnswerAspectRepairs(
        normalizedAction,
        state,
      );
      const directAnswerRepairs = pendingDirectAnswerRepairs(
        normalizedAction,
        state,
      );
      if (
        (answerAspectRepairs.length > 0 || directAnswerRepairs.length > 0) &&
        state.answerAspectRepairAttempts === 0 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.answerAspectRepairAttempts += 1;
        state.forceFinal = true;
        if (answerAspectRepairs.length > 0) {
          observe(state, {
            type: "answer_aspect_repair_required",
            requirements: answerAspectRepairs,
          });
        }
        if (directAnswerRepairs.length > 0) {
          observe(state, {
            type: "direct_answer_repair_required",
            requirements: directAnswerRepairs,
          });
        }
        continue;
      }
      if (answerAspectRepairs.length > 0 || directAnswerRepairs.length > 0) {
        return fallbackUnavailable(input, "invalid_final");
      }
      const pendingReviews = pendingEvidenceReviews(normalizedAction, state);
      if (pendingReviews.length > 0 && !deadlineReached(input)) {
        observe(state, {
          type: "coverage_gate_requires_read",
          requirements: pendingReviews,
        });
        const forcedRead = recoveryReadAction(state, pendingReviews);
        if (forcedRead === undefined) {
          recordDiagnostic(input.trace, {
            event: "stop",
            reason: "evidence_review_unavailable",
          });
          return unavailableResult(input.scope);
        }
        const readsBefore = directReadCount(state, pendingReviews);
        try {
          await executeToolAction(forcedRead, input, state);
        } catch {
          recordDiagnostic(input.trace, {
            event: "stop",
            reason: "evidence_review_unavailable",
          });
          return unavailableResult(input.scope);
        }
        const readsAfter = directReadCount(state, pendingReviews);
        if (readsAfter <= readsBefore) {
          recordDiagnostic(input.trace, {
            event: "stop",
            reason: "evidence_review_unavailable",
          });
          return unavailableResult(input.scope);
        }
        state.forceFinal = true;
        observe(state, {
          type: "coverage_gate_forced_read",
          pages: forcedRead.input.pages,
        });
        if (turn < maxTurns) continue;
        recordDiagnostic(input.trace, {
          event: "stop",
          reason: "turn_budget_exhausted",
        });
        return unavailableResult(input.scope);
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
        return fallbackUnavailable(input, "invalid_final");
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
          return fallbackUnavailable(input, "coverage_verifier_invalid");
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
        return fallbackUnavailable(input, "coverage_verifier_invalid");
      }
      const verifiedAnswerAspectRepairs = pendingAnswerAspectRepairs(
        auditedAction,
        state,
      );
      const verifiedDirectAnswerRepairs = pendingDirectAnswerRepairs(
        auditedAction,
        state,
      );
      if (
        (verifiedAnswerAspectRepairs.length > 0 ||
          verifiedDirectAnswerRepairs.length > 0) &&
        state.answerAspectRepairAttempts === 0 &&
        turn < maxTurns &&
        !deadlineReached(input)
      ) {
        state.answerAspectRepairAttempts += 1;
        state.forceFinal = true;
        if (verifiedAnswerAspectRepairs.length > 0) {
          observe(state, {
            type: "answer_aspect_repair_required",
            source: "coverage_verifier",
            requirements: verifiedAnswerAspectRepairs,
          });
        }
        if (verifiedDirectAnswerRepairs.length > 0) {
          observe(state, {
            type: "direct_answer_repair_required",
            source: "coverage_verifier",
            requirements: verifiedDirectAnswerRepairs,
          });
        }
        continue;
      }
      if (
        verifiedAnswerAspectRepairs.length > 0 ||
        verifiedDirectAnswerRepairs.length > 0
      ) {
        return fallbackUnavailable(input, "invalid_final");
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
  return fallbackUnavailable(input, "turn_budget_exhausted");
}

async function preloadBroadSynthesisEvidence(
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
  for (const requirementState of state.requirements.values()) {
    if (
      requirementState.requirement.evidenceMode !== "synthesis_allowed" ||
      requirementState.requirement.evidenceAspects.length < 4
    ) {
      continue;
    }
    while (
      requirementState.directReadPaths.size <
        readLimitFor(requirementState.requirement)
    ) {
      const selected: Candidate[] = [];
      const provisionallyCovered = new Set(requirementState.readAspectIds);
      for (const candidate of sortedCandidates(requirementState)) {
        if (
          requirementState.readPaths.has(candidate.path) ||
          selected.length >= MAX_BATCH_READS_PER_REQUIREMENT
        ) {
          continue;
        }
        const gain = [...candidate.aspectIds].filter(
          (aspectId) => !provisionallyCovered.has(aspectId),
        );
        if (gain.length === 0) continue;
        selected.push(candidate);
        for (const aspectId of gain) provisionallyCovered.add(aspectId);
      }
      if (selected.length === 0) break;
      const before = requirementState.readAspectIds.size;
      await Promise.all(selected.map((candidate) =>
        executeRead(
          {
            action: "tool",
            tool: "kb.read_page",
            input: {
              requirementId: requirementState.requirement.id,
              path: candidate.path,
            },
          },
          input,
          state,
          requirementState,
        )
      ));
      if (requirementState.readAspectIds.size === before) break;
      if (
        requirementState.requirement.evidenceAspects.every(
          (aspect) => requirementState.readAspectIds.has(aspect.id),
        )
      ) {
        break;
      }
    }
  }
}

function recoveryReadAction(
  state: AgentState,
  requirementIds?: readonly string[],
): Extract<ToolAction, { tool: "kb.read_pages" }> | undefined {
  const selectedRequirementIds = requirementIds === undefined
    ? undefined
    : new Set(requirementIds);
  const pages = [...state.requirements.values()].flatMap((requirementState) => {
    if (
      selectedRequirementIds !== undefined &&
      !selectedRequirementIds.has(requirementState.requirement.id)
    ) {
      return [];
    }
    if (
      !hasRemainingReadCapacity(requirementState)
    ) {
      return [];
    }
    const preferredPath = preferredUnreadDirectComparisonPath(
      requirementState,
    );
    const path = preferredPath ?? sortedCandidates(requirementState)
      .find((item) => !requirementState.readPaths.has(item.path))?.path;
    return path === undefined
      ? []
      : [{
          requirementId: requirementState.requirement.id,
          path,
        }];
  });
  if (pages.length === 0) return undefined;
  return {
    action: "tool",
    tool: "kb.read_pages",
    input: { pages },
  };
}

function fallbackUnavailable(
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
    outcome: "temporarily_unavailable",
  });
  recordDiagnostic(input.trace, { event: "stop", reason });
  return unavailableResult(input.scope);
}

function createAgentState(input: KnowledgeAgentInput): AgentState {
  return {
    actionFingerprints: new Set(),
    requirements: new Map(input.plan.requirements.map((requirement) => [
      requirement.id,
      {
        requirement,
        queries: new Set([
          ...requirement.queries.map((query) => normalizeQuery(query.text)),
          normalizeQuery(input.question),
        ]),
        candidatePaths: new Map(),
        readPaths: new Set(),
        directReadPaths: new Set(),
        citationIndexes: new Set(),
        readAspectIds: new Set(),
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
    answerAspectRepairAttempts: 0,
    invalidPayloadTurnRetries: 0,
    forceFinal: false,
    successfulSeedSearches: 0,
  };
}

async function executeSeedSearches(input: KnowledgeAgentInput, state: AgentState): Promise<void> {
  const globalQuery = input.question.trim();
  recordDiagnostic(input.trace, {
    event: "search",
    requirementId: "GLOBAL",
    phase: "seed",
    queryChars: globalQuery.length,
    aspectIds: [],
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
    const seedQueries = expandSeedQueries(requirementState.requirement);
    const topK = seedTopKFor(requirementState.requirement);
    for (const query of seedQueries) {
      requirementState.queries.add(normalizeQuery(query.text));
    }
    const results = await Promise.all(seedQueries.map(async (query) => {
      recordDiagnostic(input.trace, {
        event: "search",
        requirementId: requirementState.requirement.id,
        phase: "seed",
        queryChars: query.text.length,
        aspectIds: query.aspectIds,
      });
      try {
        const result = await input.session.search(
          query.text,
          topK,
          toolSignal(input),
        );
        state.successfulSeedSearches += 1;
        return { query: query.text, aspectIds: query.aspectIds, result };
      } catch {
        observe(state, {
          type: "seed_search_unavailable",
          requirementId: requirementState.requirement.id,
          query: query.text,
        });
        return undefined;
      }
    }));
    return {
      requirementState,
      successful: results.filter((item) => item !== undefined),
    };
  });

  const [globalResult, requirementResults] = await Promise.all([
    globalSearch,
    Promise.all(requirementSearches),
  ]);
  for (const { requirementState, successful } of requirementResults) {
    let gained = mergeSearchResults(requirementState, successful);
    if (globalResult) {
      gained = mergeSearchResults(requirementState, [{
        ...globalResult,
        aspectIds: matchingAspectIds(
          requirementState.requirement,
          globalResult.query,
        ),
      }], false) || gained;
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
      readEvidence: readEvidence(state),
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
      if (!hasOnlyKnownAspectIds(
        requirementState.requirement,
        action.input.aspectIds,
      )) {
        observe(state, {
          type: "unknown_search_aspect",
          requirementId: requirementState.requirement.id,
          aspectIds: action.input.aspectIds,
        });
        return;
      }
      await executeSupplementalSearch(action, input, state, requirementState);
      return;
    case "kb.read_page":
      {
        const preferredPath =
          preferredUnreadDirectComparisonPath(requirementState);
        if (
          preferredPath !== undefined &&
          !isExactDirectComparisonCandidate(
            requirementState,
            action.input.path,
          )
        ) {
          observe(state, {
            type: "direct_comparison_read_redirected",
            requirementId: action.input.requirementId,
            requestedPath: action.input.path,
            selectedPath: preferredPath,
          });
          await executeRead(
            {
              action: "tool",
              tool: "kb.read_page",
              input: {
                requirementId: action.input.requirementId,
                path: preferredPath,
              },
            },
            input,
            state,
            requirementState,
          );
          return;
        }
      }
      if (
        shouldDeferAdjacentComparisonRead(
          requirementState,
          action.input.path,
          false,
        )
      ) {
        observe(state, {
          type: "adjacent_comparison_page_deferred",
          requirementId: action.input.requirementId,
          path: action.input.path,
        });
        return;
      }
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
  const exactRequestedByRequirement = new Set(
    action.input.pages.flatMap((page) => {
      const requirementState = state.requirements.get(page.requirementId);
      return requirementState !== undefined &&
          isExactDirectComparisonCandidate(requirementState, page.path)
        ? [page.requirementId]
        : [];
    }),
  );
  const redirectedRequirements = new Set<string>();
  const requestedPages = action.input.pages.map((page) => {
    const requirementState = state.requirements.get(page.requirementId);
    if (
      requirementState === undefined ||
      exactRequestedByRequirement.has(page.requirementId) ||
      redirectedRequirements.has(page.requirementId) ||
      isExactDirectComparisonCandidate(requirementState, page.path)
    ) {
      return page;
    }
    const preferredPath =
      preferredUnreadDirectComparisonPath(requirementState);
    if (preferredPath === undefined) return page;
    redirectedRequirements.add(page.requirementId);
    observe(state, {
      type: "direct_comparison_read_redirected",
      requirementId: page.requirementId,
      requestedPath: page.path,
      selectedPath: preferredPath,
    });
    return { ...page, path: preferredPath };
  });
  const requestedExactComparisons = new Set(
    requestedPages.flatMap((page) => {
      const requirementState = state.requirements.get(page.requirementId);
      return requirementState !== undefined &&
          isExactDirectComparisonCandidate(requirementState, page.path)
        ? [page.requirementId]
        : [];
    }),
  );
  const accepted: Array<{
    page: { requirementId: string; path: string };
    requirementState: RequirementState;
  }> = [];
  for (const page of requestedPages) {
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
    if (
      shouldDeferAdjacentComparisonRead(
        requirementState,
        page.path,
        requestedExactComparisons.has(page.requirementId),
      )
    ) {
      observe(state, {
        type: "adjacent_comparison_page_deferred",
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
      !canReadEvidencePath(requirementState, page.path, pending)
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
    queryChars: action.input.query.length,
    aspectIds: action.input.aspectIds,
  });
  const result = await input.session.search(action.input.query, action.input.topK, toolSignal(input));
  const gained = mergeSearchResults(requirementState, [{
    query: action.input.query,
    aspectIds: action.input.aspectIds,
    result,
  }]);
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
    !canReadEvidencePath(requirementState, action.input.path)
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
    !canReadEvidencePath(requirementState, page.path)
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
    ...requirementState.requirement.queries.map((query) => query.text),
    ...requirementState.requirement.evidenceAspects.flatMap(
      (aspect) => [aspect.label, ...aspect.terms],
    ),
    ...(candidate === undefined ? [] : candidate.matchedTerms),
  ];
  const content = input.session.compactPage(page, terms);
  const resolvedAspectIds = [
    ...new Set([
      ...(candidate?.aspectIds ?? []),
      ...matchingAspectIds(
        requirementState.requirement,
        `${page.title}\n${content}`,
      ),
    ]),
  ];
  for (const aspectId of resolvedAspectIds) {
    candidate?.aspectIds.add(aspectId);
    requirementState.readAspectIds.add(aspectId);
  }
  state.evidenceDocuments.get(requirementState.requirement.id)?.set(
    reference.index,
    {
      title: page.title,
      path: page.path,
      content,
      aspectIds: resolvedAspectIds,
    },
  );
  observe(state, {
    type: "read_page",
    requirementId: requirementState.requirement.id,
    reference: reference.index,
    path: page.path,
    aspectIds: resolvedAspectIds,
  });
  recordDiagnostic(input.trace, {
    event: "read",
    requirementId: requirementState.requirement.id,
    path: page.path,
    citation: reference.index,
    sectionHeadings: markdownHeadings(content),
    aspectIds: resolvedAspectIds,
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
    const resolvedAspectIds = [
      ...new Set([
        ...targetCandidate.aspectIds,
        ...matchingAspectIds(requirementState.requirement, content),
      ]),
    ];
    for (const aspectId of resolvedAspectIds) {
      targetCandidate.aspectIds.add(aspectId);
      requirementState.readAspectIds.add(aspectId);
    }
    const reference = state.references.resolve([citation])[0];
    if (reference !== undefined) {
      state.evidenceDocuments.get(toRequirementId)?.set(citation, {
        title: reference.title,
        path: reference.path,
        content,
        aspectIds: resolvedAspectIds,
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
      for (
        const aspectId of
          targetState.candidatePaths.get(document.path)?.aspectIds ?? []
      ) {
        targetState.readAspectIds.add(aspectId);
      }
      targetDocuments.set(citation, {
        ...document,
        aspectIds: [
          ...(targetState.candidatePaths.get(document.path)?.aspectIds ?? []),
        ],
      });
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
  searches: readonly {
    query: string;
    aspectIds: readonly string[];
    result: KnowledgeSearchResult;
  }[],
  requirementSpecific = true,
): boolean {
  let gained = false;
  for (const { query, aspectIds, result } of searches) {
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
        aspectIds: new Set<string>(),
        requirementSpecificMatch: false,
      };
      candidate.title = hit.title;
      candidate.requirementSpecificMatch ||= requirementSpecific;
      candidate.rrfScore += 1 / (RRF_K + index + 1);
      candidate.sourceQueries.add(query);
      for (const aspectId of attributedSearchAspectIds(
        requirementState.requirement,
        aspectIds,
        [
          hit.title,
          ...hit.matchedTerms,
          hit.snippet ?? "",
        ].join(" "),
      )) {
        candidate.aspectIds.add(aspectId);
      }
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
      aspectIds: new Set<string>(),
      requirementSpecificMatch: true,
    };
    candidate.title = hit.title;
    candidate.requirementSpecificMatch = true;
    candidate.rrfScore += 1 / (RRF_K + index + 1);
    candidate.sourceQueries.add(`graph:${sourcePath}`);
    candidate.graphRelations.add(hit.relation);
    const sourceAspectIds = [
      ...(requirementState.candidatePaths.get(sourcePath)?.aspectIds ?? []),
    ];
    const matchedAspectIds = matchingAspectIds(
      requirementState.requirement,
      hit.title,
    );
    for (const aspectId of (
      sourceAspectIds.length <= 1
        ? [...new Set([...sourceAspectIds, ...matchedAspectIds])]
        : matchedAspectIds
    )) {
      candidate.aspectIds.add(aspectId);
    }
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
      sourceQueryCount: candidate.sourceQueries.size,
      graphRelations: [...candidate.graphRelations],
      aspectIds: [...candidate.aspectIds],
    })),
    aspects: aspectStatuses(requirementState).map((aspect) => ({
      id: aspect.id,
      candidateCount: aspect.candidateCount,
      readCandidateCount: aspect.readCandidateCount,
    })),
  });
}

function requirementEvidence(state: AgentState) {
  return [...state.requirements.values()].map((requirementState) => ({
    id: requirementState.requirement.id,
    question: requirementState.requirement.question,
    aspects: aspectStatuses(requirementState),
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
      aspectIds: [...candidate.aspectIds],
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

function readEvidence(state: AgentState) {
  return [...state.evidenceDocuments.entries()].flatMap(
    ([requirementId, documents]) =>
      [...documents.entries()].map(([citation, document]) => ({
        requirementId,
        citation,
        ...document,
      })),
  );
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
              ...(summary.coveredAspectCount === undefined
                ? {}
                : {
                    coveredAspectCount: summary.coveredAspectCount,
                  }),
              ...(summary.missingAspectCount === undefined
                ? {}
                : {
                    missingAspectCount: summary.missingAspectCount,
                  }),
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
    const requirementState = state.requirements.get(result.id);
    if (
      !requirementState ||
      !hasRemainingReadCapacity(requirementState)
    ) {
      continue;
    }
    const hasUnreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) => !requirementState.readPaths.has(path));
    const hasUnreadAspectCandidate = [...requirementState.candidatePaths.values()]
      .some((candidate) =>
        !requirementState.readPaths.has(candidate.path) &&
        [...candidate.aspectIds].some(
          (aspectId) => !requirementState.readAspectIds.has(aspectId),
        ));
    if (
      hasUnreadCandidate &&
      (result.coverage !== "complete" || hasUnreadAspectCandidate)
    ) {
      pending.push(result.id);
    }
  }
  return pending;
}

function directReadCount(
  state: AgentState,
  requirementIds: readonly string[],
): number {
  return requirementIds.reduce(
    (count, requirementId) =>
      count +
      (state.requirements.get(requirementId)?.directReadPaths.size ?? 0),
    0,
  );
}

function pendingAnswerAspectRepairs(
  action: FinalAction,
  state: AgentState,
): Array<{ requirementId: string; missingAspectIds: string[] }> {
  return action.requirements.flatMap((result) => {
    const requirementState = state.requirements.get(result.id);
    if (
      requirementState === undefined ||
      result.coverage === "none" ||
      (
        requirementState.requirement.evidenceMode !== "synthesis_allowed" &&
        !isDirectComparisonRequirement(requirementState.requirement)
      ) ||
      requirementState.requirement.evidenceAspects.length <= 1
    ) {
      return [];
    }
    const documents =
      state.evidenceDocuments.get(result.id) ?? new Map();
    const availableAspectIds = new Set(
      [...documents.values()].flatMap(
        (document) => document.aspectIds ?? [],
      ),
    );
    const coveredAspectIds = answerCoveredAspectIds(
      result.answer,
      requirementState.requirement,
      documents,
    );
    const missingAspectIds = requirementState.requirement.evidenceAspects
      .map((aspect) => aspect.id)
      .filter((aspectId) =>
        availableAspectIds.has(aspectId) &&
        !coveredAspectIds.has(aspectId)
      );
    return missingAspectIds.length === 0
      ? []
      : [{ requirementId: result.id, missingAspectIds }];
  });
}

const DIRECT_COMPARISON_QUESTION_PATTERN =
  /(?:对比|比较|相比|较之|区别|差异|不同|\bvs\.?\b|\bversus\b)/iu;

function isDirectComparisonRequirement(
  requirement: KnowledgeRequirement,
): boolean {
  return requirement.evidenceMode === "direct_only" &&
    DIRECT_COMPARISON_QUESTION_PATTERN.test(requirement.question);
}

function isExactDirectComparisonCandidate(
  requirementState: RequirementState,
  path: string,
): boolean {
  const candidate = requirementState.candidatePaths.get(path);
  return candidate !== undefined &&
    directQuestionTitleCoverageScore(
      candidate.title,
      requirementState.requirement,
    ) > 0;
}

function preferredUnreadDirectComparisonPath(
  requirementState: RequirementState,
): string | undefined {
  if (!isDirectComparisonRequirement(requirementState.requirement)) {
    return undefined;
  }
  return [...requirementState.candidatePaths.values()]
    .filter((candidate) =>
      !requirementState.readPaths.has(candidate.path) &&
      isExactDirectComparisonCandidate(requirementState, candidate.path)
    )
    .sort((left, right) =>
      directQuestionTitleCoverageScore(
        right.title,
        requirementState.requirement,
      ) -
        directQuestionTitleCoverageScore(
          left.title,
          requirementState.requirement,
        ) ||
      normalizeTitleText(left.title).length -
        normalizeTitleText(right.title).length ||
      right.rrfScore - left.rrfScore ||
      left.path.localeCompare(right.path)
    )[0]?.path;
}

function hasRemainingReadCapacity(
  requirementState: RequirementState,
): boolean {
  return requirementState.directReadPaths.size <
      readLimitFor(requirementState.requirement) ||
    preferredUnreadDirectComparisonPath(requirementState) !== undefined;
}

function canReadEvidencePath(
  requirementState: RequirementState,
  path: string,
  pendingReads = 0,
): boolean {
  if (
    requirementState.directReadPaths.size + pendingReads <
      readLimitFor(requirementState.requirement)
  ) {
    return true;
  }
  return isExactDirectComparisonCandidate(requirementState, path) &&
    ![...requirementState.directReadPaths].some((readPath) =>
      isExactDirectComparisonCandidate(requirementState, readPath)
    );
}

function shouldDeferAdjacentComparisonRead(
  requirementState: RequirementState,
  path: string,
  exactCandidateRequested: boolean,
): boolean {
  if (
    !isDirectComparisonRequirement(requirementState.requirement) ||
    isExactDirectComparisonCandidate(requirementState, path)
  ) {
    return false;
  }
  return exactCandidateRequested ||
    [...requirementState.directReadPaths].some((readPath) =>
      isExactDirectComparisonCandidate(requirementState, readPath)
    );
}

function pendingDirectAnswerRepairs(
  action: FinalAction,
  state: AgentState,
): Array<{ requirementId: string; citationIndexes: number[] }> {
  return action.requirements.flatMap((result) => {
    const requirementState = state.requirements.get(result.id);
    if (
      requirementState === undefined ||
      result.coverage === "complete" ||
      !isDirectComparisonRequirement(requirementState.requirement)
    ) {
      return [];
    }
    const documents = state.evidenceDocuments.get(result.id) ?? new Map();
    const exactCitations = [...documents.entries()]
      .filter(([, document]) =>
        directQuestionTitleCoverageScore(
          document.title,
          requirementState.requirement,
        ) > 0
      )
      .map(([citation]) => citation);
    return exactCitations.length === 0
      ? []
      : [{
          requirementId: result.id,
          citationIndexes: exactCitations,
        }];
  });
}

function answerCoveredAspectIds(
  answer: string,
  requirement: KnowledgeRequirement,
  documents: ReadonlyMap<
    number,
    Omit<CoverageEvidenceDocument, "requirementId" | "citation">
  >,
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (
    const segment of normalizeTrailingCitationPlacement(answer)
      .split(/\n+|(?<=[。！？；])/u)
  ) {
    const citations = [...segment.matchAll(/\[(\d+)\]/gu)]
      .map((match) => Number(match[1]))
      .filter(Number.isSafeInteger);
    if (citations.length === 0) continue;
    const supportedAspectIds = new Set(
      citations.flatMap(
        (citation) => documents.get(citation)?.aspectIds ?? [],
      ),
    );
    for (const aspectId of matchingAspectIds(requirement, segment)) {
      if (supportedAspectIds.has(aspectId)) covered.add(aspectId);
    }
  }
  const answerCitations = new Set(
    [...answer.matchAll(/\[(\d+)\]/gu)]
      .map((match) => Number(match[1]))
      .filter(Number.isSafeInteger),
  );
  for (const aspectId of matchingAspectIds(requirement, answer)) {
    if (
      [...answerCitations].some((citation) =>
        documents.get(citation)?.aspectIds?.includes(aspectId) === true)
    ) {
      covered.add(aspectId);
    }
  }
  return covered;
}

function sortedCandidates(requirementState: RequirementState): Candidate[] {
  return [...requirementState.candidatePaths.values()]
    .sort((left, right) => {
      const pathPriority =
        candidatePathPriority(left.path, requirementState.requirement) -
        candidatePathPriority(right.path, requirementState.requirement);
      const questionTitlePriority =
        directQuestionTitleCoverageScore(
          right.title,
          requirementState.requirement,
        ) -
        directQuestionTitleCoverageScore(
          left.title,
          requirementState.requirement,
        );
      const titlePriority =
        titleCoverageScore(
          right.title,
          requirementState.requirement,
          requirementState.queries,
        ) -
        titleCoverageScore(
          left.title,
          requirementState.requirement,
          requirementState.queries,
        );
      const relevancePriority = right.rrfScore - left.rrfScore;
      const aspectPriority =
        candidateAspectGain(right, requirementState) -
        candidateAspectGain(left, requirementState);
      return requirementState.requirement.evidenceMode === "direct_only"
        ? pathPriority ||
          questionTitlePriority ||
          titlePriority ||
          relevancePriority ||
          aspectPriority ||
          left.path.localeCompare(right.path)
        : aspectPriority ||
          pathPriority ||
          titlePriority ||
          relevancePriority ||
          left.path.localeCompare(right.path);
    });
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
  return titleCoverageScoreForValues(title, [
    requirement.question,
    ...requirement.queries.map((query) => query.text),
    ...executedQueries,
  ]);
}

function directQuestionTitleCoverageScore(
  title: string,
  requirement: KnowledgeRequirement,
): number {
  return titleCoverageScoreForValues(
    title,
    [requirement.question],
    true,
  );
}

function titleCoverageScoreForValues(
  title: string,
  values: readonly string[],
  preserveProductTerms = false,
): number {
  const normalizedTitle = normalizeTitleText(title);
  const terms = new Set(
    values.flatMap((value) => titleTerms(value, preserveProductTerms)),
  );
  const matches = [...terms].filter((term) => normalizedTitle.includes(term));
  if (matches.length < 2) return 0;
  return matches.reduce((score, term) => score + Math.min(term.length, 4), 0);
}

function titleTerms(value: string, preserveProductTerms = false): string[] {
  return (value.toLocaleLowerCase("zh-CN")
    .match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu) ?? [])
    .flatMap((part) => {
      if (!/^\p{Script=Han}+$/u.test(part) || part.length <= 4) return [part];
      return Array.from({ length: part.length - 1 }, (_, index) =>
        part.slice(index, index + 2));
    })
    .map(normalizeTitleText)
    .filter((term) =>
      term.length >= 2 &&
      (
        !TITLE_TERM_STOPWORDS.has(term) ||
        (preserveProductTerms && /[a-z0-9]/iu.test(term))
      )
    );
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
        hasRemainingReadCapacity(requirementState)) ||
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
    const standardReadCapacity = Math.max(
      0,
      readLimitFor(requirementState.requirement) -
        requirementState.directReadPaths.size,
    );
    const exactComparisonReserve =
        preferredUnreadDirectComparisonPath(requirementState) === undefined
      ? 0
      : 1;
    remaining += Math.min(
      unreadCandidates,
      standardReadCapacity + exactComparisonReserve,
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
      [...action.input.aspectIds].sort(),
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

function expandSeedQueries(
  requirement: KnowledgeRequirement,
): Array<{ text: string; aspectIds: string[] }> {
  const expanded = new Map<string, { text: string; aspectIds: Set<string> }>();
  for (const query of requirement.queries) {
    const queryText = enrichSynthesisQuery(
      requirement,
      query.text,
      query.aspectIds,
    );
    addExpandedQuery(expanded, queryText, query.aspectIds);
    const variants = [
      queryText.replaceAll("注意事项", "要点"),
      queryText.replaceAll("关键注意", "重点"),
      queryText.replaceAll("操作步骤", "操作流程"),
    ];
    for (const variant of variants) {
      const normalized = normalizeQuery(variant);
      if (normalized !== normalizeQuery(queryText)) {
        addExpandedQuery(expanded, variant, query.aspectIds);
      }
    }
    if (
      /poc/iu.test(queryText) &&
      (
        queryText.includes("注意事项") ||
        queryText.includes("关键注意") ||
        queryText.includes("要点")
      )
    ) {
      addExpandedQuery(expanded, "POC测试要点", query.aspectIds);
    }
    if (
      queryText.includes("迁移") &&
      /(?:执行步骤|操作步骤|操作流程|流程|方法)/u.test(queryText)
    ) {
      const toolFocus = `${queryText
        .replace(/(?:执行步骤|操作步骤|操作流程|流程|方法)/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()} 工具`;
      addExpandedQuery(expanded, toolFocus, query.aspectIds);
    }
  }
  const compatibilityIntent = [
    requirement.question,
    ...requirement.queries.map((query) => query.text),
  ].join(" ");
  if (
    compatibilityIntent.includes("信创") &&
    /(?:兼容|适配)/u.test(compatibilityIntent)
  ) {
    addExpandedQuery(
      expanded,
      "信创技术栈适配矩阵",
      requirement.evidenceAspects.map((aspect) => aspect.id),
    );
  }
  if (
    compatibilityIntent.includes("迁移") &&
    /(?:产品能力|考虑哪些|迁移范围|迁移方式)/u.test(compatibilityIntent)
  ) {
    addExpandedQuery(
      expanded,
      "第三方邮件系统迁移方式对比 组织架构 邮件数据 认证",
      requirement.evidenceAspects.map((aspect) => aspect.id),
    );
  }
  if (
    /(?:如何|怎样|怎么).*(?:设计|规划).*(?:容灾|高可用)|(?:容灾|高可用).*(?:如何|怎样|怎么).*(?:设计|规划)/u
      .test(requirement.question) &&
    /(?:Coremail|邮件系统)/iu.test(compatibilityIntent)
  ) {
    addExpandedQuery(
      expanded,
      "邮件系统多活与容灾设计 同机房 跨机房 容灾",
      requirement.evidenceAspects.map((aspect) => aspect.id),
    );
  }
  if (
    compatibilityIntent.includes("售前") &&
    /(?:需求访谈|需求调研|厂商无关)/u.test(compatibilityIntent)
  ) {
    addExpandedQuery(
      expanded,
      "售前诊断式对话框架 事实 假设 未知",
      requirement.evidenceAspects.map((aspect) => aspect.id),
    );
  }
  return [...expanded.values()].map((query) => ({
    text: query.text,
    aspectIds: [...query.aspectIds],
  }));
}

function enrichSynthesisQuery(
  requirement: KnowledgeRequirement,
  queryText: string,
  aspectIds: readonly string[],
): string {
  if (
    requirement.evidenceMode !== "synthesis_allowed" ||
    aspectIds.length <= 1
  ) {
    return queryText;
  }
  const normalizedQuery = normalizeTitleText(queryText);
  const additions = aspectIds.flatMap((aspectId) => {
    const aspect = requirement.evidenceAspects.find(
      (candidate) => candidate.id === aspectId,
    );
    if (aspect === undefined) return [];
    const term = aspect.terms.find((candidate) => {
      const normalizedTerm = normalizeTitleText(candidate);
      return normalizedTerm.length >= 2 &&
        !normalizedQuery.includes(normalizedTerm);
    });
    return term === undefined ? [] : [term];
  });
  return additions.length === 0
    ? queryText
    : `${queryText} ${[...new Set(additions)].join(" ")}`;
}

function addExpandedQuery(
  expanded: Map<string, { text: string; aspectIds: Set<string> }>,
  text: string,
  aspectIds: readonly string[],
): void {
  const normalized = normalizeQuery(text);
  const entry = expanded.get(normalized) ?? {
    text,
    aspectIds: new Set<string>(),
  };
  for (const aspectId of aspectIds) entry.aspectIds.add(aspectId);
  expanded.set(normalized, entry);
}

function matchingAspectIds(
  requirement: KnowledgeRequirement,
  value: string,
): string[] {
  const normalized = normalizeTitleText(value);
  return requirement.evidenceAspects
    .filter((aspect) =>
      [aspect.label, ...aspect.terms].some((term) => {
        const normalizedTerm = normalizeTitleText(term);
        return normalizedTerm.length >= 2 && normalized.includes(normalizedTerm);
      }))
    .map((aspect) => aspect.id);
}

function seedTopKFor(requirement: KnowledgeRequirement): number {
  return requirement.evidenceMode === "synthesis_allowed"
    ? Math.min(
        SYNTHESIS_SEED_TOP_K_LIMIT,
        Math.max(SEED_TOP_K, requirement.evidenceAspects.length * 3),
      )
    : SEED_TOP_K;
}

function attributedSearchAspectIds(
  requirement: KnowledgeRequirement,
  queryAspectIds: readonly string[],
  hitMetadata: string,
): string[] {
  const matched = matchingAspectIds(requirement, hitMetadata);
  return queryAspectIds.length <= 1
    ? [...new Set([...queryAspectIds, ...matched])]
    : matched;
}

function hasOnlyKnownAspectIds(
  requirement: KnowledgeRequirement,
  aspectIds: readonly string[],
): boolean {
  const known = new Set(
    requirement.evidenceAspects.map((aspect) => aspect.id),
  );
  return aspectIds.every((aspectId) => known.has(aspectId));
}

function candidateAspectGain(
  candidate: Candidate,
  requirementState: RequirementState,
): number {
  return [...candidate.aspectIds].filter(
    (aspectId) => !requirementState.readAspectIds.has(aspectId),
  ).length;
}

function aspectStatuses(
  requirementState: RequirementState,
): Array<{
  id: string;
  label: string;
  candidateCount: number;
  readCandidateCount: number;
}> {
  return requirementState.requirement.evidenceAspects.map((aspect) => ({
    id: aspect.id,
    label: aspect.label,
    candidateCount: [...requirementState.candidatePaths.values()]
      .filter((candidate) => candidate.aspectIds.has(aspect.id)).length,
    readCandidateCount: [...requirementState.candidatePaths.values()]
      .filter((candidate) =>
        candidate.aspectIds.has(aspect.id) &&
        requirementState.readPaths.has(candidate.path))
      .length,
  }));
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
