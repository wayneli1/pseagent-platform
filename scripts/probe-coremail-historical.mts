import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { answerResultSchema } from "../apps/pseagent/src/contracts.js";
import { coremailKnowledgeArguments } from "../apps/pseagent/src/coremail-mcp-client.js";
import { validateHistoricalProbe } from
  "../apps/pseagent/src/coremail-historical-probe-contract.js";
import { NOT_COVERED_TEXT } from "../apps/pseagent/src/response.js";

const question = "请说明 Jira 工单 CMHA-1097 的修改内容和适用镜像版本。";
const coveredQuestion = "列出 Coremail AI 助手的新功能特性";
const mode = process.env.PSE_COREMAIL_PROBE_MODE ?? "historical";
const inheritedNames = [
  "PSE_MODEL_BASE_URL",
  "PSE_MODEL_API_KEY",
  "PSE_MODEL_NAME",
  "PSE_MODEL_TIMEOUT_MS",
  "KNOWLEDGE_MCP_COMMAND",
  "KNOWLEDGE_MCP_ENTRY_PATH",
  "KNOWLEDGE_ENGINE_URL",
  "KNOWLEDGE_ENGINE_TOKEN",
  "KNOWLEDGE_ENGINE_TIMEOUT_MS",
  "KNOWLEDGE_ENGINE_ALLOW_REMOTE",
  "COREMAIL_MCP_ENABLED",
  "COREMAIL_MCP_COMMAND",
  "COREMAIL_MCP_ENTRY_PATH",
  "COREMAIL_MCP_TIMEOUT_MS",
] as const;
const safeFailureCodes = new Set([
  "missing_coremail_entry",
  "unexpected_outer_tool_list",
  "unexpected_coremail_tool_list",
  "unexpected_primary_status",
  "unexpected_primary_answer",
  "unexpected_primary_references",
  "missing_historical_answer",
  "missing_historical_reference",
  "unexpected_historical_source_type",
  "unexpected_historical_warning",
  "unexpected_historical_confidence",
  "missing_direct_historical_reference",
  "historical_answer_rewritten",
  "unexpected_probe_mode",
  "coremail_probe_not_enabled",
  "broken_path_fallback_changed",
  "covered_query_changed",
  "covered_query_started_coremail",
  "refusing_probe_temp_cleanup",
]);

async function probe(): Promise<void> {
  const pseEnvironment = getDefaultEnvironment();
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) pseEnvironment[name] = value;
  }
  if (!["historical", "broken_path", "covered"].includes(mode)) {
    throw new Error("unexpected_probe_mode");
  }
  if (pseEnvironment.COREMAIL_MCP_ENABLED !== "true") {
    throw new Error("coremail_probe_not_enabled");
  }

  let temporaryRoot: string | undefined;
  let markerPath: string | undefined;
  let activeQuestion = question;
  if (mode === "broken_path") {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "pse-coremail-broken-"));
    pseEnvironment.COREMAIL_MCP_ENTRY_PATH = path.join(
      temporaryRoot,
      "missing",
      "dist",
      "server.js",
    );
  } else if (mode === "covered") {
    temporaryRoot = mkdtempSync(path.join(tmpdir(), "pse-coremail-covered-"));
    writeFileSync(
      path.join(temporaryRoot, "package.json"),
      '{"type":"commonjs"}\n',
      "utf8",
    );
    const sentinelDist = path.join(temporaryRoot, "dist");
    mkdirSync(sentinelDist);
    markerPath = path.join(temporaryRoot, "started.marker");
    const sentinelEntry = path.join(sentinelDist, "server.js");
    writeFileSync(
      sentinelEntry,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");\n`,
      "utf8",
    );
    pseEnvironment.COREMAIL_MCP_ENTRY_PATH = sentinelEntry;
    activeQuestion = coveredQuestion;
  }
  const pseTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["apps/pseagent/dist/main.js"],
    env: pseEnvironment,
    stderr: "pipe",
  });
  pseTransport.stderr?.on("data", () => undefined);

  const pseClient = new Client({
    name: "pseagent-coremail-live-probe",
    version: "0.1.0",
  });
  let directClient: Client | undefined;

  try {
    await pseClient.connect(pseTransport);
    const pseTools = await pseClient.listTools();
    if (pseTools.tools.length !== 1 || pseTools.tools[0]?.name !== "pse_answer") {
      throw new Error("unexpected_outer_tool_list");
    }

    if (mode !== "historical") {
      const raw = await pseClient.callTool(
        { name: "pse_answer", arguments: { question: activeQuestion } },
        undefined,
        { timeout: 1_800_000 },
      );
      const result = answerResultSchema.parse(raw.structuredContent);
      if (mode === "broken_path") {
        if (
          result.status !== "not_covered" ||
          result.answer !== NOT_COVERED_TEXT ||
          result.references.length !== 0 ||
          result.historicalAnswer !== undefined
        ) {
          throw new Error("broken_path_fallback_changed");
        }
        process.stdout.write(
          "broken_path startup=true fallback_unchanged=true\n",
        );
        return;
      }
      if (
        (result.status !== "answered" &&
          result.status !== "partially_answered") ||
        result.references.length === 0 ||
        result.historicalAnswer !== undefined
      ) {
        throw new Error("covered_query_changed");
      }
      if (markerPath && existsSync(markerPath)) {
        throw new Error("covered_query_started_coremail");
      }
      process.stdout.write("covered_query coremail_started=false\n");
      return;
    }

    const coremailEntry = process.env.COREMAIL_MCP_ENTRY_PATH;
    if (!coremailEntry) throw new Error("missing_coremail_entry");
    const directEnvironment = {
      ...getDefaultEnvironment(),
      AI_ADOPTION_ENABLED: "false",
      KNOWLEDGE_ENABLE_CACHE: "false",
      KNOWLEDGE_AUTH_INTERACTIVE: "false",
    };
    const directTransport = new StdioClientTransport({
      command: process.env.COREMAIL_MCP_COMMAND ?? process.execPath,
      args: [coremailEntry],
      env: directEnvironment,
      stderr: "pipe",
    });
    directTransport.stderr?.on("data", () => undefined);
    directClient = new Client({
      name: "coremail-direct-live-probe",
      version: "0.1.0",
    });
    await directClient.connect(directTransport, { timeout: 60_000 });
    const directTools = await directClient.listTools(
      undefined,
      { timeout: 60_000 },
    );
    if (!directTools.tools.some((tool) => tool.name === "answer_coremail_knowledge")) {
      throw new Error("unexpected_coremail_tool_list");
    }

    const started = performance.now();
    const pseRaw = await pseClient.callTool(
      { name: "pse_answer", arguments: { question } },
      undefined,
      { timeout: 1_800_000 },
    );
    const directRaw = await directClient.callTool(
      {
        name: "answer_coremail_knowledge",
        arguments: coremailKnowledgeArguments(question),
      },
      undefined,
      { timeout: 60_000 },
    );
    const summary = validateHistoricalProbe(
      pseRaw.structuredContent,
      directRaw.structuredContent,
    );
    const elapsedMs = Math.round(performance.now() - started);
    process.stdout.write(
      `historical status=not_covered main_refs=${summary.mainRefs}` +
      ` history_refs=${summary.historyRefs} confidence=${summary.confidence}` +
      ` raw_equal=${summary.rawEqual} warning=${summary.warning}` +
      ` elapsed_ms=${elapsedMs}\n`,
    );
  } finally {
    await Promise.allSettled([
      pseClient.close(),
      ...(directClient ? [directClient.close()] : []),
    ]);
    if (temporaryRoot) {
      const resolvedRoot = path.resolve(temporaryRoot);
      const resolvedTemp = `${path.resolve(tmpdir())}${path.sep}`;
      if (!resolvedRoot.startsWith(resolvedTemp)) {
        throw new Error("refusing_probe_temp_cleanup");
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

probe().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = safeFailureCodes.has(message) ? message : "unclassified";
  process.stderr.write(`probe_coremail_historical_failed code=${code}\n`);
  process.exitCode = 1;
});
