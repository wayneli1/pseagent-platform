import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

type GoldenCase = {
  readonly id: string;
  readonly questions: readonly [string, string];
  readonly expectedScope: "professional" | "general" | "normal";
  readonly expectedStatus: "answered" | "partially_answered" | "not_covered" | "temporarily_unavailable";
  readonly requirements: readonly {
    readonly expectedEvidencePages: readonly string[];
  }[];
  readonly requiredFacts: readonly string[];
  readonly forbiddenFacts: readonly string[];
  readonly maxElapsedMs: number;
};
const corpusPath = fileURLToPath(
  new URL("../tests/regression/evidence-coverage.json", import.meta.url),
);
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as {
  readonly cases: readonly GoldenCase[];
};
const probes = corpus.cases.flatMap((item) => {
  const questions = process.env.PSE_PROBE_INCLUDE_PARAPHRASES === "1"
    ? item.questions
    : item.questions.slice(0, 1);
  return questions.map((question, variant) => ({
    id: `${item.id}.${variant + 1}`,
    question,
    expectedScope: item.expectedScope,
    expectedStatus: item.expectedStatus,
    expectedEvidencePages: item.requirements.flatMap(
      (requirement) => requirement.expectedEvidencePages,
    ),
    requiredFacts: item.requiredFacts,
    forbiddenFacts: item.forbiddenFacts,
    maxElapsedMs: item.maxElapsedMs,
  }));
});

const unavailableProbe = [
  {
    id: "unavailable.1",
    question: "列出 Coremail AI 助手的新功能特性",
    expectedScope: "professional",
    expectedStatus: "temporarily_unavailable",
    expectedEvidencePages: [],
    requiredFacts: [],
    forbiddenFacts: [],
    maxElapsedMs: 300_000,
  },
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
  "COREMAIL_MCP_ENABLED",
  "COREMAIL_MCP_COMMAND",
  "COREMAIL_MCP_ENTRY_PATH",
  "COREMAIL_MCP_TIMEOUT_MS",
  "PSE_DIAGNOSTICS_ENABLED",
  "PSE_DIAGNOSTICS_DIR",
] as const;

const safeFailureCodes = new Set([
  "unexpected_outer_tool_list",
  "unexpected_probe_result",
  "unexpected_not_covered_text",
  "unexpected_unavailable_text",
  "knowledge_answer_without_reference",
  "unexpected_reference",
  "reference_project_mismatch",
  "invalid_reference_revision",
  "invalid_reference_hash",
  "missing_required_fact",
  "forbidden_fact_present",
  "missing_expected_evidence_page",
  "probe_deadline_exceeded",
]);
let activeProbe = "none";
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
      activeProbe = item.id;
      lastResultSummary = "";
      const started = performance.now();
      const raw = await client.callTool(
        { name: "pse_answer", arguments: { question: item.question } },
        undefined,
        { timeout: 310_000 },
      );
      const result = answerResultSchema.parse(raw.structuredContent);
      lastResultSummary = `scope=${result.scope} status=${result.status} refs=${result.references.length}`;
      if (result.scope !== item.expectedScope || result.status !== item.expectedStatus) {
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
        (result.scope === "professional" || result.scope === "general") &&
        (result.status === "answered" || result.status === "partially_answered") &&
        result.references.length === 0
      ) {
        throw new Error("knowledge_answer_without_reference");
      }
      if (
        (result.scope === "normal" || result.status === "not_covered" || result.status === "temporarily_unavailable") &&
        result.references.length !== 0
      ) {
        throw new Error("unexpected_reference");
      }
      const elapsedMs = Math.round(performance.now() - started);
      for (const fact of item.requiredFacts) {
        if (!includesNormalized(result.answer, fact)) throw new Error("missing_required_fact");
      }
      for (const fact of item.forbiddenFacts) {
        if (includesNormalized(result.answer, fact)) throw new Error("forbidden_fact_present");
      }
      const referencePaths = new Set(result.references.map((reference) => reference.path));
      for (const path of item.expectedEvidencePages) {
        if (!referencePaths.has(path)) throw new Error("missing_expected_evidence_page");
      }
      if (elapsedMs > item.maxElapsedMs) throw new Error("probe_deadline_exceeded");
      process.stdout.write(
        `probe=${item.id} scope=${result.scope} status=${result.status} refs=${result.references.length} elapsed_ms=${elapsedMs}\n`,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function includesNormalized(content: string, expected: string): boolean {
  const normalize = (value: string) =>
    value.toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
  return normalize(content).includes(normalize(expected));
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
