import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runKnowledgeAgent } from "./agent-loop.js";
import { AnswerService, type AgentRunner, type KnowledgeSessionFactory } from "./answer-service.js";
import { loadConfig, type AppConfig, type CoremailMcpConfig } from "./config.js";
import {
  StdioCoremailHistoricalAnswerProvider,
  type HistoricalAnswerProvider,
} from "./coremail-mcp-client.js";
import {
  JsonlDiagnosticTraceFactory,
  type DiagnosticTraceFactory,
} from "./diagnostics.js";
import { KnowledgeSession } from "./knowledge-session.js";
import { StdioKnowledgeToolCaller, type KnowledgeToolCaller } from "./knowledge-tool-caller.js";
import { ModelKnowledgePlanner, type KnowledgePlanner } from "./knowledge-planner.js";
import { createPseMcpServer } from "./mcp-server.js";
import { OpenAiCompatibleModelClient, type ModelClient } from "./model-client.js";
import { ScopeRouter } from "./router.js";

export interface PseRuntimeDependencies {
  readonly createModel?: (config: AppConfig) => ModelClient;
  readonly createKnowledgeCaller?: (config: AppConfig, env: NodeJS.ProcessEnv) => KnowledgeToolCaller;
  readonly createRouter?: (model: ModelClient) => Pick<ScopeRouter, "route">;
  readonly createKnowledgePlanner?: (model: ModelClient) => KnowledgePlanner;
  readonly createDiagnosticTraceFactory?: (config: AppConfig) => DiagnosticTraceFactory | undefined;
  readonly createKnowledgeSessionFactory?: (caller: KnowledgeToolCaller) => KnowledgeSessionFactory;
  readonly runAgent?: AgentRunner;
  readonly createServer?: (answer: AnswerService["answer"]) => McpServer;
  readonly createHistoricalProvider?: (
    config: Extract<CoremailMcpConfig, { enabled: true }>,
  ) => HistoricalAnswerProvider;
}

export interface PseAgentRuntime {
  readonly server: McpServer;
  readonly answer: AnswerService["answer"];
  readonly answerDetailed: AnswerService["answerDetailed"];
  close(): Promise<void>;
}

export async function createPseAgentRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: PseRuntimeDependencies = {},
): Promise<PseAgentRuntime> {
  const config = loadConfig(env);
  const model = (dependencies.createModel ?? defaultCreateModel)(config);
  const caller = (dependencies.createKnowledgeCaller ?? defaultCreateKnowledgeCaller)(config, env);
  const diagnostics = (
    dependencies.createDiagnosticTraceFactory ??
    defaultCreateDiagnosticTraceFactory
  )(config);
  let historicalProvider: HistoricalAnswerProvider | undefined;
  let server: McpServer;
  let answer: AnswerService["answer"];
  let answerDetailed: AnswerService["answerDetailed"];
  try {
    if (config.coremailMcp.enabled) {
      historicalProvider = (
        dependencies.createHistoricalProvider ??
        defaultCreateHistoricalProvider
      )(config.coremailMcp);
    }
    await caller.connect();
    const router = (dependencies.createRouter ?? ((value) => new ScopeRouter(value)))(model);
    const planner = (
      dependencies.createKnowledgePlanner ??
      ((value) => new ModelKnowledgePlanner(value))
    )(model);
    const knowledge = (dependencies.createKnowledgeSessionFactory ?? defaultKnowledgeSessionFactory)(caller);
    const service = new AnswerService({
      model,
      router,
      planner,
      ...(diagnostics === undefined ? {} : { diagnostics }),
      knowledge,
      runAgent: dependencies.runAgent ?? runKnowledgeAgent,
      ...(historicalProvider === undefined ? {} : { historicalProvider }),
    });
    answer = service.answer.bind(service);
    answerDetailed = service.answerDetailed.bind(service);
    server = (dependencies.createServer ?? ((handler) => createPseMcpServer({ answer: handler })))(answer);
  } catch (error) {
    const providerToClose = historicalProvider;
    await Promise.allSettled([
      Promise.resolve().then(() => caller.close()),
      ...(providerToClose === undefined
        ? []
        : [Promise.resolve().then(() => providerToClose.close())]),
    ]);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    server,
    answer,
    answerDetailed,
    close() {
      const providerToClose = historicalProvider;
      closePromise ??= (async () => {
        await Promise.allSettled([
          Promise.resolve().then(() => server.close()),
          Promise.resolve().then(() => caller.close()),
          ...(providerToClose === undefined
            ? []
            : [Promise.resolve().then(() => providerToClose.close())]),
        ]);
      })();
      return closePromise;
    },
  };
}

export async function runPseAgent(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PseRuntimeDependencies = {},
): Promise<PseAgentRuntime> {
  const runtime = await createPseAgentRuntime(env, dependencies);
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  const cleanup = () => { void runtime.close(); };
  process.stdin.once("end", cleanup);
  process.stdin.once("close", cleanup);
  process.once("SIGINT", cleanup);
  const protocolClose = transport.onclose;
  transport.onclose = () => {
    protocolClose?.();
    cleanup();
  };
  process.stderr.write("pseagent_ready\n");
  return runtime;
}

function defaultCreateModel(config: AppConfig): ModelClient {
  return new OpenAiCompatibleModelClient({
    baseUrl: config.PSE_MODEL_BASE_URL,
    apiKey: config.PSE_MODEL_API_KEY,
    model: config.PSE_MODEL_NAME,
    timeoutMs: config.PSE_MODEL_TIMEOUT_MS,
    maxTokens: config.PSE_MODEL_MAX_TOKENS,
  });
}

function defaultCreateKnowledgeCaller(config: AppConfig, env: NodeJS.ProcessEnv): KnowledgeToolCaller {
  const childEnv: Record<string, string> = {};
  for (const name of [
    "KNOWLEDGE_ENGINE_URL",
    "KNOWLEDGE_ENGINE_TOKEN",
    "KNOWLEDGE_ENGINE_TIMEOUT_MS",
    "KNOWLEDGE_ENGINE_ALLOW_REMOTE",
  ] as const) {
    const value = env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  return new StdioKnowledgeToolCaller(config.KNOWLEDGE_MCP_ENTRY_PATH, {
    command: config.KNOWLEDGE_MCP_COMMAND,
    env: childEnv,
  });
}

function defaultCreateDiagnosticTraceFactory(
  config: AppConfig,
): DiagnosticTraceFactory | undefined {
  return config.diagnostics.enabled
    ? new JsonlDiagnosticTraceFactory(config.diagnostics.directory)
    : undefined;
}

function defaultCreateHistoricalProvider(
  config: Extract<CoremailMcpConfig, { enabled: true }>,
): HistoricalAnswerProvider {
  return new StdioCoremailHistoricalAnswerProvider(config.entryPath, {
    command: config.command,
    timeoutMs: config.timeoutMs,
  });
}

function defaultKnowledgeSessionFactory(caller: KnowledgeToolCaller): KnowledgeSessionFactory {
  return {
    open(scope, signal) {
      return KnowledgeSession.open(scope, caller, signal);
    },
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runPseAgent().catch(() => {
    process.stderr.write("pseagent_startup_failed\n");
    process.exitCode = 1;
  });
}
