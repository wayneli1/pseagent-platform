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
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import { knowledgeAgentMessages } from "./prompts.js";
import { ReferenceRegistry } from "./references.js";
import { formatKnowledgeFinal, unavailableResult } from "./response.js";
import {
  recordDiagnostic,
  type DiagnosticTrace,
} from "./diagnostics.js";

export const MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT = 3;
export const MAX_READS_PER_REQUIREMENT = 3;
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
};

type RequirementState = {
  readonly requirement: KnowledgeRequirement;
  readonly queries: Set<string>;
  readonly candidatePaths: Map<string, Candidate>;
  readonly readPaths: Set<string>;
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
  readonly observations: string[];
  invalidStreak: number;
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
      state.invalidStreak = 0;
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) {
        recordDiagnostic(input.trace, { event: "stop", reason: "invalid_model_payload" });
        return unavailableResult(input.scope);
      }
      state.invalidStreak += 1;
      observe(state, { type: "invalid_model_payload" });
      if (state.invalidStreak >= 2) {
        recordDiagnostic(input.trace, { event: "stop", reason: "invalid_model_payload" });
        return unavailableResult(input.scope);
      }
      continue;
    }

    if (action.action === "final") {
      const pendingReviews = pendingEvidenceReviews(action, state);
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
        action,
        input.plan.requirements,
        evidenceByRequirement(state),
      );
      if (!validation.ok) {
        if (state.citationRepairAttempts === 0 && turn < maxTurns) {
          state.citationRepairAttempts += 1;
          state.forceFinal = true;
          observe(state, { type: "invalid_citations", reason: validation.reason });
          continue;
        }
        recordDiagnostic(input.trace, { event: "stop", reason: "invalid_final" });
        return unavailableResult(input.scope);
      }
      recordDiagnostic(input.trace, {
        event: "coverage",
        requirements: action.requirements,
        citations: action.citations,
        stopReason: deadlineReached(input) ? "deadline" : "final",
      });
      return formatKnowledgeFinal(input.scope, action, state.references.resolve(action.citations));
    }
    if (finalOnly) {
      observe(state, { type: "tool_not_allowed" });
      continue;
    }

    const fingerprint = actionFingerprint(action);
    if (state.actionFingerprints.has(fingerprint)) {
      observe(state, {
        type: "duplicate_action",
        requirementId: action.input.requirementId,
        action: fingerprint,
      });
      stopSearchAfterNoGain(state.requirements.get(action.input.requirementId));
      continue;
    }
    state.actionFingerprints.add(fingerprint);

    try {
      await executeToolAction(action, input, state);
    } catch {
      observe(state, {
        type: "tool_unavailable",
        requirementId: action.input.requirementId,
        tool: action.tool,
      });
      stopSearchAfterNoGain(state.requirements.get(action.input.requirementId));
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
        queries: new Set(requirement.queries.map(normalizeQuery)),
        candidatePaths: new Map(),
        readPaths: new Set(),
        citationIndexes: new Set(),
        supplementalSearches: 0,
        graphActions: 0,
        noGainRounds: 0,
        searchStopped: false,
      },
    ])),
    references: new ReferenceRegistry(input.session.project, input.session.revision),
    observations: [],
    invalidStreak: 0,
    citationRepairAttempts: 0,
    forceFinal: false,
    successfulSeedSearches: 0,
  };
}

async function executeSeedSearches(input: KnowledgeAgentInput, state: AgentState): Promise<void> {
  await Promise.all([...state.requirements.values()].map(async (requirementState) => {
    const results = await Promise.all(requirementState.requirement.queries.map(async (query) => {
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
    const successful = results.filter(
      (item): item is { query: string; result: KnowledgeSearchResult } => item !== undefined,
    );
    const gained = mergeSearchResults(requirementState, successful);
    if (!gained) requirementState.noGainRounds = 1;
    observeCandidates(state, requirementState, "seed_search_result", input.trace);
  }));
}

async function requestAgentAction(
  input: KnowledgeAgentInput,
  state: AgentState,
  turn: number,
  maxTurns: number,
  finalOnly: boolean,
) {
  return input.model.completeJson({
    messages: knowledgeAgentMessages({
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
    }),
    schema: finalOnly ? finalOnlyActionSchema : agentActionSchema,
    schemaDescription: finalOnly ? "pse_final_action" : "pse_agent_action",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function executeToolAction(
  action: ToolAction,
  input: KnowledgeAgentInput,
  state: AgentState,
): Promise<void> {
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
    requirementState.readPaths.size >= MAX_READS_PER_REQUIREMENT
  ) {
    observe(state, {
      type: "requirement_read_budget_exhausted",
      requirementId: requirementState.requirement.id,
      path: action.input.path,
    });
    return;
  }
  const page = await input.session.readPage(action.input.path, toolSignal(input));
  const reference = state.references.register({
    project: input.session.project,
    revision: input.session.revision,
    page,
  });
  requirementState.readPaths.add(page.path);
  requirementState.citationIndexes.add(reference.index);
  const candidate = requirementState.candidatePaths.get(page.path);
  const terms = [
    requirementState.requirement.question,
    ...requirementState.requirement.queries,
    ...(candidate === undefined ? [] : candidate.matchedTerms),
  ];
  const content = input.session.compactPage(page, terms);
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
      };
      candidate.title = hit.title;
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
    };
    candidate.title = hit.title;
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
    candidates: sortedCandidates(requirementState).slice(0, 10).map((candidate) => ({
      path: candidate.path,
      title: candidate.title,
      rrfScore: roundedScore(candidate.rrfScore),
      sourceQueries: [...candidate.sourceQueries],
      rankings: candidate.rankings,
      matchedTerms: [...candidate.matchedTerms],
      snippets: [...candidate.snippets],
      graphRelations: [...candidate.graphRelations],
    })),
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
    candidates: sortedCandidates(requirementState).slice(0, 10).map((candidate) => ({
      path: candidate.path,
      title: candidate.title,
      rrfScore: roundedScore(candidate.rrfScore),
      sourceQueries: [...candidate.sourceQueries],
      rankings: candidate.rankings,
      matchedTerms: [...candidate.matchedTerms],
      snippets: [...candidate.snippets],
      graphRelations: [...candidate.graphRelations],
      read: requirementState.readPaths.has(candidate.path),
    })),
    citationIndexes: [...requirementState.citationIndexes],
    remainingSearches: requirementState.searchStopped
      ? 0
      : MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT - requirementState.supplementalSearches,
    remainingReads: MAX_READS_PER_REQUIREMENT - requirementState.readPaths.size,
  }));
}

function evidenceByRequirement(state: AgentState): ReadonlyMap<string, ReadonlySet<number>> {
  return new Map([...state.requirements].map(([id, requirementState]) => [
    id,
    requirementState.citationIndexes,
  ]));
}

function pendingEvidenceReviews(
  action: FinalAction,
  state: AgentState,
): string[] {
  const pending: string[] = [];
  for (const result of action.requirements) {
    if (result.coverage !== "none") continue;
    const requirementState = state.requirements.get(result.id);
    if (!requirementState || requirementState.readPaths.size >= MAX_READS_PER_REQUIREMENT) continue;
    const hasUnreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) => !requirementState.readPaths.has(path));
    if (hasUnreadCandidate) pending.push(result.id);
  }
  return pending;
}

function sortedCandidates(requirementState: RequirementState): Candidate[] {
  return [...requirementState.candidatePaths.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore || left.path.localeCompare(right.path));
}

function hasAvailableToolAction(state: AgentState): boolean {
  return [...state.requirements.values()].some((requirementState) => {
    const unreadCandidate = [...requirementState.candidatePaths.keys()]
      .some((path) => !requirementState.readPaths.has(path));
    return (
      (!requirementState.searchStopped &&
        requirementState.supplementalSearches < MAX_SUPPLEMENTAL_SEARCHES_PER_REQUIREMENT) ||
      (unreadCandidate && requirementState.readPaths.size < MAX_READS_PER_REQUIREMENT) ||
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
      MAX_READS_PER_REQUIREMENT - requirementState.readPaths.size,
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

function normalizeQuery(query: string): string {
  return query.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
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
