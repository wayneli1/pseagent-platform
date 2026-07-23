import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { answerResultSchema } from "../apps/pseagent/src/contracts.js";
import {
  KNOWLEDGE_UNAVAILABLE_TEXT,
  NOT_COVERED_TEXT,
} from "../apps/pseagent/src/response.js";

const probes = [
  { question: "列出 Coremail AI 助手的新功能特性", expectedScope: "professional", allowed: ["answered", "partially_answered"] },
  { question: "如何开展厂商无关的售前需求访谈", expectedScope: "general", allowed: ["not_covered"] },
  { question: "解释什么是二分查找", expectedScope: "normal", allowed: ["answered"] },
  { question: "Coremail 下一季度一定会发布哪些未公告功能", expectedScope: "professional", allowed: ["not_covered"] },
] as const;

const unavailableProbe = [
  { question: "列出 Coremail AI 助手的新功能特性", expectedScope: "professional", allowed: ["temporarily_unavailable"] },
] as const;

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
] as const;

const safeFailureCodes = new Set([
  "unexpected_outer_tool_list",
  "unexpected_probe_result",
  "unexpected_not_covered_text",
  "unexpected_unavailable_text",
  "professional_answer_without_reference",
  "unexpected_reference",
  "reference_project_mismatch",
  "invalid_reference_revision",
  "invalid_reference_hash",
]);
let activeProbe = 0;
let lastResultSummary = "";

async function probe(): Promise<void> {
  const env = getDefaultEnvironment();
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["apps/pseagent/dist/main.js"],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {
    // Drain stable child status codes without printing configuration or content.
  });
  const client = new Client({ name: "pseagent-live-probe", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 1 || tools.tools[0]?.name !== "pse_answer") {
      throw new Error("unexpected_outer_tool_list");
    }
    const activeProbes = process.env.PSE_PROBE_EXPECT_UNAVAILABLE === "1" ? unavailableProbe : probes;
    for (const [index, item] of activeProbes.entries()) {
      activeProbe = index + 1;
      lastResultSummary = "";
      const started = performance.now();
      const raw = await client.callTool(
        { name: "pse_answer", arguments: { question: item.question } },
        undefined,
        { timeout: 1_800_000 },
      );
      const result = answerResultSchema.parse(raw.structuredContent);
      lastResultSummary = `scope=${result.scope} status=${result.status} refs=${result.references.length}`;
      if (result.scope !== item.expectedScope || !item.allowed.includes(result.status as never)) {
        throw new Error("unexpected_probe_result");
      }
      validateReferences(result);
      if (result.status === "not_covered" && result.answer !== NOT_COVERED_TEXT) {
        throw new Error("unexpected_not_covered_text");
      }
      if (result.status === "temporarily_unavailable" && result.answer !== KNOWLEDGE_UNAVAILABLE_TEXT) {
        throw new Error("unexpected_unavailable_text");
      }
      if (
        result.scope === "professional" &&
        (result.status === "answered" || result.status === "partially_answered") &&
        result.references.length === 0
      ) {
        throw new Error("professional_answer_without_reference");
      }
      if (
        (result.scope === "normal" || result.status === "not_covered" || result.status === "temporarily_unavailable") &&
        result.references.length !== 0
      ) {
        throw new Error("unexpected_reference");
      }
      const elapsedMs = Math.round(performance.now() - started);
      process.stdout.write(
        `probe=${index + 1} scope=${result.scope} status=${result.status} refs=${result.references.length} elapsed_ms=${elapsedMs}\n`,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function validateReferences(result: ReturnType<typeof answerResultSchema.parse>): void {
  for (const reference of result.references) {
    const expectedProject = result.scope === "professional" ? "coremail-professional" : "presales-general";
    if (reference.project !== expectedProject) throw new Error("reference_project_mismatch");
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(reference.revision)) throw new Error("invalid_reference_revision");
    if (!/^[a-f0-9]{64}$/u.test(reference.contentHash)) throw new Error("invalid_reference_hash");
  }
}

probe().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code = safeFailureCodes.has(message) ? message : "unclassified";
  const summary = lastResultSummary ? ` ${lastResultSummary}` : "";
  process.stderr.write(`probe_live_failed probe=${activeProbe} code=${code}${summary}\n`);
  process.exitCode = 1;
});
