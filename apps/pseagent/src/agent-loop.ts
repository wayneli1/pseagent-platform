import {
  agentActionSchema,
  finalOnlyActionSchema,
  type AnswerResult,
  type FinalAction,
  type Reference,
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

export const MAX_AGENT_TURNS = 8;
export const MAX_RETRIEVAL_ACTIONS = 4;

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
  readonly model: ModelClient;
  readonly session: KnowledgeAgentSession;
  readonly signal?: AbortSignal;
}

type AgentState = {
  readonly actionFingerprints: Set<string>;
  readonly candidatePaths: Set<string>;
  readonly referenceKeys: Set<string>;
  readonly references: Reference[];
  readonly observations: string[];
  retrievalActions: number;
  noGainStreak: number;
  invalidStreak: number;
  forceFinal: boolean;
};

export async function runKnowledgeAgent(input: KnowledgeAgentInput): Promise<AnswerResult> {
  const state = createAgentState();
  for (let turn = 1; turn <= MAX_AGENT_TURNS; turn += 1) {
    const finalOnly = state.forceFinal || turn === MAX_AGENT_TURNS;
    let action;
    try {
      action = await requestAgentAction(input, state, turn, finalOnly);
      state.invalidStreak = 0;
    } catch (error) {
      if (!(error instanceof InvalidModelPayloadError)) return temporarilyUnavailable(input.scope);
      state.invalidStreak += 1;
      observe(state, { type: "invalid_model_payload" });
      if (state.invalidStreak >= 2) return temporarilyUnavailable(input.scope);
      continue;
    }

    if (action.action === "final") return finalizeAgentResult(input.scope, action, state.references);
    if (finalOnly) {
      observe(state, { type: "tool_not_allowed" });
      continue;
    }

    const fingerprint = JSON.stringify([action.tool, action.input]);
    if (state.actionFingerprints.has(fingerprint)) {
      observe(state, { type: "duplicate_action", action: fingerprint });
      state.forceFinal = true;
      continue;
    }
    state.actionFingerprints.add(fingerprint);

    let gained = false;
    try {
      gained = await executeToolAction(action, input.session, state, input.signal);
    } catch {
      observe(state, { type: "tool_unavailable", tool: action.tool });
    }
    state.retrievalActions += 1;
    state.noGainStreak = gained ? 0 : state.noGainStreak + 1;
    if (state.retrievalActions >= MAX_RETRIEVAL_ACTIONS || state.noGainStreak >= 2) {
      state.forceFinal = true;
    }
  }
  return temporarilyUnavailable(input.scope);
}

function createAgentState(): AgentState {
  return {
    actionFingerprints: new Set(),
    candidatePaths: new Set(),
    referenceKeys: new Set(),
    references: [],
    observations: [],
    retrievalActions: 0,
    noGainStreak: 0,
    invalidStreak: 0,
    forceFinal: false,
  };
}

async function requestAgentAction(
  input: KnowledgeAgentInput,
  state: AgentState,
  turn: number,
  finalOnly: boolean,
) {
  return input.model.completeJson({
    messages: knowledgeAgentMessages({
      question: input.question,
      ...(input.conversationContext === undefined ? {} : { conversationContext: input.conversationContext }),
      schema: input.session.schema,
      overview: input.session.overview,
      observations: state.observations,
      references: state.references,
      remainingTurns: MAX_AGENT_TURNS - turn + 1,
      remainingRetrievalActions: MAX_RETRIEVAL_ACTIONS - state.retrievalActions,
    }),
    schema: finalOnly ? finalOnlyActionSchema : agentActionSchema,
    schemaDescription: finalOnly ? "pse_final_action" : "pse_agent_action",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function executeToolAction(
  action: ToolAction,
  session: KnowledgeAgentSession,
  state: AgentState,
  signal?: AbortSignal,
): Promise<boolean> {
  switch (action.tool) {
    case "kb.search":
      return observeSearch(await session.search(action.input.query, action.input.topK, signal), state);
    case "kb.read_page":
      return observeRead(await session.readPage(action.input.path, signal), session, state);
    case "kb.graph":
      return observeGraph(await session.graph(action.input.path, action.input.topK, signal), state);
    default:
      return assertNever(action);
  }
}

function observeSearch(result: KnowledgeSearchResult, state: AgentState): boolean {
  let gained = false;
  for (const hit of result.hits) {
    if (!state.candidatePaths.has(hit.path)) gained = true;
    state.candidatePaths.add(hit.path);
  }
  observe(state, {
    type: "search_result",
    hits: result.hits.slice(0, 10).map((hit) => ({
      path: hit.path,
      title: hit.title,
      matchedTerms: hit.matchedTerms,
      snippet: hit.snippet.slice(0, 500),
    })),
  });
  return gained;
}

function observeGraph(result: KnowledgeGraphResult, state: AgentState): boolean {
  let gained = false;
  for (const hit of result.hits) {
    if (!state.candidatePaths.has(hit.path)) gained = true;
    state.candidatePaths.add(hit.path);
  }
  observe(state, {
    type: "graph_result",
    hits: result.hits.slice(0, 10).map((hit) => ({ path: hit.path, title: hit.title, relation: hit.relation })),
  });
  return gained;
}

function observeRead(page: KnowledgePage, session: KnowledgeAgentSession, state: AgentState): boolean {
  const key = `${session.project}\u0000${session.revision}\u0000${page.path}\u0000${page.contentHash}`;
  const gained = !state.referenceKeys.has(key);
  if (gained) {
    state.referenceKeys.add(key);
    state.references.push({
      index: state.references.length + 1,
      project: session.project,
      title: page.title,
      path: page.path,
      revision: session.revision,
      contentHash: page.contentHash,
    });
  }
  const reference = state.references.find((item) =>
    item.project === session.project && item.revision === session.revision &&
    item.path === page.path && item.contentHash === page.contentHash);
  observe(state, {
    type: "read_page",
    reference: reference?.index,
    content: session.compactPage(page, []),
  });
  return gained;
}

function observe(state: AgentState, value: unknown): void {
  const bounded = JSON.stringify(value).slice(0, 4_000);
  state.observations.push(bounded);
  if (state.observations.length > 12) state.observations.shift();
}

function finalizeAgentResult(
  scope: "professional" | "general",
  action: FinalAction,
  references: Reference[],
): AnswerResult {
  const selected = references.filter((reference) => action.citations.includes(reference.index));
  const status = action.coverage === "complete"
    ? "answered"
    : action.coverage === "partial" ? "partially_answered" : "not_covered";
  return { scope, status, answer: action.answer, references: selected };
}

function temporarilyUnavailable(scope: "professional" | "general"): AnswerResult {
  return {
    scope,
    status: "temporarily_unavailable",
    answer: "知识问答服务暂时不可用，请稍后重试。",
    references: [],
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled_tool_action:${String(value)}`);
}
