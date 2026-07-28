import {
  agentActionSchema,
  finalOnlyActionSchema,
  type AnswerResult,
  type CoverageVerificationReason,
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
  verifyKnowledgeCoverage,
  type CoverageEvidenceDocument,
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
export const MAX_READS_PER_REQUIREMENT = 3;
export const MAX_BATCH_READS_PER_REQUIREMENT = 2;
export const MAX_GRAPH_ACTIONS_PER_REQUIREMENT = 1;
export const MAX_AGENT_TURNS_PER_REQUIREMENT = 7;
const RRF_K = 60;
const SEED_TOP_K = 10;

export interface KnowledgeAgentSession {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly schema: string;
  readonly overview: string;
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
      const reason = error instanceof ModelUnavailableError
        ? "model_unavailable"
        : "invalid_model_payload";
      recordDiagnostic(input.trace, { event: "stop", reason });
      return unavailableResult(input.scope);
    }

    if (action.action === "final") {
      const normalizedAction = normalizeFinalCitationMetadata(action);
      const pendingReviews = pendingEvidenceReviews(normalizedAction, state);
      if (pendingReviews.length > 0 && !deadlineReached(input)) {
        observe(state, {
          type: "coverage_gate_requires_read",
          requirements: pendingReviews,
        });
        if (turn < maxTurns) continue;
        recordDiagnostic(input.trace, { event: "stop", reason: "turn_budget_exhausted" });
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
        recordDiagnostic(input.trace, { event: "stop", reason: "invalid_final" });
        return unavailableResult(input.scope);
      }
      recordCoverage(
        input,
        normalizedAction,
        "draft",
        deadlineReached(input) ? "deadline" : "final",
      );
      let auditedAction: FinalAction;
      let verifiedReasons: readonly {
        readonly id: string;
        readonly reason: CoverageVerificationReason;
      }[] | undefined;
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
          onVerified(reasons) {
            verifiedReasons = reasons;
          },
        });
      } catch (error) {
        const reason = error instanceof ModelUnavailableError
          ? "coverage_verifier_unavailable"
          : "coverage_verifier_invalid";
        recordDiagnostic(input.trace, { event: "stop", reason });
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
        recordDiagnostic(input.trace, {
          event: "stop",
          reason: "coverage_verifier_invalid",
        });
        return unavailableResult(input.scope);
      }
      recordCoverage(
        input,
        auditedAction,
        "verified",
        deadlineReached(input) ? "deadline" : "final",
        verifiedReasons,
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
  recordDiagnostic(input.trace, { event: "stop", reason: "turn_budget_exhausted" });
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
      schema: input.session.schema,
      overview: input.session.overview,
      plan: input.plan,
      requirementEvidence: requirementEvidence(state),
      observations: state.observations,
      references: state.references.list(),
      remainingTurns: maxTurns - turn + 1,
      remainingRetrievalActions: countRemainingToolActions(state),
      finalOnly,
    });
  const request = (repair: boolean) => input.model.completeJson({
      messages: repair
        ? [...messages, {
            role: "user" as const,
            content: finalOnly
              ? "上一次输出不符合 Schema。只输出合法 final JSON；必须完整列出规划中的每个 requirement 及其 coverage/citations，不要解释。"
              : "上一次输出不符合 Schema。只输出一个合法 JSON 动作；单页/搜索/图谱工具输入必须包含 requirementId，批量读页必须使用 pages 数组且每项包含 requirementId/path，final 必须完整列出逐项 requirements，不要解释。",
          }]
        : messages,
      schema: finalOnly ? finalOnlyActionSchema : agentActionSchema,
      schemaDescription: finalOnly ? "pse_final_action" : "pse_agent_action",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  try {
    return await request(false);
  } catch (error) {
    if (!(error instanceof InvalidModelPayloadError)) throw error;
    recordDiagnostic(input.trace, {
      event: "model_payload",
      result: "rejected",
      reason: error.code,
      repairAttempt: 1,
    });
    try {
      return await request(true);
    } catch (repairError) {
      if (repairError instanceof InvalidModelPayloadError) {
        recordDiagnostic(input.trace, {
          event: "model_payload",
          result: "rejected",
          reason: repairError.code,
          repairAttempt: 2,
        });
      }
      throw repairError;
    }
  }
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
      requirementState.directReadPaths.size + pending >= MAX_READS_PER_REQUIREMENT
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
    requirementState.directReadPaths.size >= MAX_READS_PER_REQUIREMENT
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
    requirementState.directReadPaths.size >= MAX_READS_PER_REQUIREMENT
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
    remainingReads: MAX_READS_PER_REQUIREMENT - requirementState.directReadPaths.size,
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
  reasons?: readonly {
    readonly id: string;
    readonly reason: CoverageVerificationReason;
  }[],
): void {
  recordDiagnostic(input.trace, {
    event: "coverage",
    stage,
    requirements: action.requirements.map((requirement) => ({
      id: requirement.id,
      coverage: requirement.coverage,
      citations: requirementEvidenceCitations(requirement),
    })),
    ...(reasons === undefined ? {} : { reasons }),
    citations: action.citations,
    stopReason,
  });
}

function normalizeFinalCitationMetadata(action: FinalAction): FinalAction {
  const requirements = action.requirements.map((requirement) => ({
    ...requirement,
    citations: stableUniqueNumbers(
      [...requirement.answer.matchAll(/\[(\d+)\]/gu)]
        .map((match) => Number(match[1])),
    ),
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
      requirementState.directReadPaths.size >= MAX_READS_PER_REQUIREMENT
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
        requirementState.directReadPaths.size < MAX_READS_PER_REQUIREMENT) ||
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
      MAX_READS_PER_REQUIREMENT - requirementState.directReadPaths.size,
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
