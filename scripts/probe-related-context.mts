import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  answerResultSchema,
  type AnswerResult,
} from "../apps/pseagent/src/contracts.js";

const PROBE_RUNS = 3;
const CALL_BUDGET_MS = 300_000;
const DIAGNOSTICS_PREFIX = "pse-related-context-probe-";
const DIAGNOSTICS_OWNER_FILE = ".pse-related-context-owner";
const formalRelatedHeading = "正式知识库相关信息：";
const formalConclusionHeading = "覆盖结论：";
const formalSourcesHeading = "正式知识库资料来源：";

const regressionCaseSchema = z.object({
  id: z.string(),
  question: z.string().trim().min(1),
  relatedFacts: z.array(z.string().trim().min(1)).optional(),
}).passthrough();
const regressionCases = z.array(regressionCaseSchema).parse(JSON.parse(
  readFileSync(
    new URL("../tests/regression/questions.json", import.meta.url),
    "utf8",
  ),
));
const selectedProbeCase = regressionCases.find((item) => item.id === "P11");
if (!selectedProbeCase || !selectedProbeCase.relatedFacts?.length) {
  throw new Error("missing_related_context_probe_case");
}
const probeCase = {
  question: selectedProbeCase.question,
  relatedFacts: selectedProbeCase.relatedFacts,
} as const;

const finishEventSchema = z.object({
  event: z.literal("finish"),
  scope: z.literal("professional"),
  status: z.literal("not_covered"),
  citationCount: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  historicalAttempted: z.boolean(),
  historicalUsed: z.boolean(),
  requestId: z.string().min(1).optional(),
  timestamp: z.string().datetime().optional(),
}).strict();
type FinishEvent = z.infer<typeof finishEventSchema>;

const diagnosticFinishEventSchema = finishEventSchema.extend({
  requestId: z.string().min(1),
});
type DiagnosticFinishEvent = z.infer<typeof diagnosticFinishEventSchema>;

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
  "missing_related_context_probe_case",
  "coremail_probe_not_enabled",
  "unexpected_outer_tool_list",
  "unexpected_scope_or_status",
  "missing_formal_uncertainty",
  "unsupported_target_claim",
  "missing_formal_related_section",
  "unsupported_related_protocol",
  "missing_formal_reference",
  "formal_reference_partition_mismatch",
  "formal_reference_not_visible",
  "historical_attempt_not_confirmed",
  "historical_use_mismatch",
  "diagnostic_citation_count_mismatch",
  "unexpected_finish_event_count",
  "invalid_diagnostic_record",
  "probe_deadline_exceeded",
  "refusing_probe_temp_cleanup",
]);

export function validateRelatedContextAcceptance(
  resultInput: unknown,
  finishInput: unknown,
  supportedRelatedFacts: readonly string[],
) {
  const result = answerResultSchema.parse(resultInput);
  const finish = finishEventSchema.parse(finishInput);
  if (result.scope !== "professional" || result.status !== "not_covered") {
    throw new Error("unexpected_scope_or_status");
  }
  if (
    !result.answer.includes("正式知识库") ||
    !/(?:无法|不能)[\s\S]{0,32}(?:确认|判断)/u.test(result.answer)
  ) {
    throw new Error("missing_formal_uncertainty");
  }
  if (
    hasUnsupportedTargetClaim(result.answer)
  ) {
    throw new Error("unsupported_target_claim");
  }
  if (result.references.length === 0) {
    throw new Error("missing_formal_reference");
  }

  const relatedSection = extractFormalRelatedSection(result.answer);
  validateRelatedProtocols(relatedSection, supportedRelatedFacts);
  validateVisibleFormalReferences(result, relatedSection);

  if (!finish.historicalAttempted) {
    throw new Error("historical_attempt_not_confirmed");
  }
  const historicalUsed = result.historicalAnswer !== undefined;
  if (finish.historicalUsed !== historicalUsed) {
    throw new Error("historical_use_mismatch");
  }
  if (finish.citationCount !== result.references.length) {
    throw new Error("diagnostic_citation_count_mismatch");
  }

  return {
    formalRefs: result.references.length,
    historyRefs: result.historicalAnswer?.references.length ?? 0,
    historicalAttempted: finish.historicalAttempted,
    historicalUsed,
  };
}

export function readProbeFinishEvents(
  directory: string,
): DiagnosticFinishEvent[] {
  const events: DiagnosticFinishEvent[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^pseagent-\d{4}-\d{2}-\d{2}-.+\.jsonl$/u.test(entry.name)
    ) {
      continue;
    }
    const content = readFileSync(path.join(directory, entry.name), "utf8");
    for (const line of content.split(/\r?\n/gu).filter(Boolean)) {
      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch {
        throw new Error("invalid_diagnostic_record");
      }
      if (
        typeof record === "object" &&
        record !== null &&
        "event" in record &&
        record.event === "finish"
      ) {
        const parsed = diagnosticFinishEventSchema.safeParse(record);
        if (!parsed.success) throw new Error("invalid_diagnostic_record");
        events.push(parsed.data);
      }
    }
  }
  return events;
}

export function createProbeDiagnosticsDirectory(): {
  readonly directory: string;
  readonly ownershipToken: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), DIAGNOSTICS_PREFIX));
  const ownershipToken = randomUUID();
  writeFileSync(
    path.join(directory, DIAGNOSTICS_OWNER_FILE),
    ownershipToken,
    "utf8",
  );
  return { directory, ownershipToken };
}

export function removeProbeDiagnosticsDirectory(
  directory: string,
  ownershipToken: string,
): void {
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(path.resolve(tmpdir()), resolvedDirectory);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(resolvedDirectory).startsWith(DIAGNOSTICS_PREFIX) ||
    !existsSync(resolvedDirectory) ||
    !lstatSync(resolvedDirectory).isDirectory() ||
    readOwnershipToken(resolvedDirectory) !== ownershipToken
  ) {
    throw new Error("refusing_probe_temp_cleanup");
  }
  rmSync(resolvedDirectory, { recursive: true, force: true });
}

export async function runRelatedContextAttempts(
  attempt: (run: number, budgetMs: number) => Promise<void>,
): Promise<void> {
  for (let run = 1; run <= PROBE_RUNS; run += 1) {
    await attempt(run, CALL_BUDGET_MS);
  }
}

function extractFormalRelatedSection(answer: string): string {
  const relatedStart = answer.indexOf(formalRelatedHeading);
  const conclusionStart = answer.indexOf(formalConclusionHeading);
  const sourcesStart = answer.indexOf(formalSourcesHeading);
  if (
    relatedStart < 0 ||
    conclusionStart <= relatedStart ||
    sourcesStart <= conclusionStart
  ) {
    throw new Error("missing_formal_related_section");
  }
  return answer.slice(
    relatedStart + formalRelatedHeading.length,
    conclusionStart,
  );
}

function validateRelatedProtocols(
  relatedSection: string,
  supportedRelatedFacts: readonly string[],
): void {
  const supportedTokens = new Set(
    supportedRelatedFacts.flatMap((fact) =>
      fact.toLocaleUpperCase("en-US").match(/[A-Z][A-Z0-9]*(?:[/-][A-Z0-9]+)*/gu) ?? []
    ).flatMap((token) => [token, ...token.split(/[/-]/gu)]),
  );
  const visibleTokens = new Set(
    (relatedSection.toLocaleUpperCase("en-US")
      .match(/[A-Z][A-Z0-9]*(?:[/-][A-Z0-9]+)*/gu) ?? [])
      .flatMap((token) => [token, ...token.split(/[/-]/gu)]),
  );
  const requiredTokens = new Set(
    supportedRelatedFacts.flatMap((fact) =>
      (fact.toLocaleUpperCase("en-US")
        .match(/[A-Z][A-Z0-9]*(?:[/-][A-Z0-9]+)*/gu) ?? [])
        .flatMap((token) => token.split(/[/-]/gu))),
  );
  if (
    visibleTokens.size === 0 ||
    [...visibleTokens].some((token) =>
      !supportedTokens.has(token) &&
      token.split(/[/-]/gu).some((part) => !supportedTokens.has(part))) ||
    [...requiredTokens].some((token) => !visibleTokens.has(token))
  ) {
    throw new Error("unsupported_related_protocol");
  }
}

function hasUnsupportedTargetClaim(answer: string): boolean {
  const normalized = answer.replace(/\s+/gu, "");
  const targetSentences = answer
    .split(/[。！？\n]+/gu)
    .map((sentence) => sentence.replace(/\s+/gu, ""))
    .filter((sentence) =>
      /(?:目标协议|该协议|此协议|量子卫星|2035)/u.test(sentence));
  const unsupportedTargetSentence = targetSentences.some(
    (sentence) => !isAllowedTargetSentence(sentence),
  );
  return unsupportedTargetSentence ||
    /不支持|尚未支持|暂未支持|明确不兼容|无法兼容/u.test(normalized) ||
    /(?:支持|兼容)(?:该|此|目标|量子卫星|2035)/u.test(normalized) ||
    /(?:该|此|目标|量子卫星|2035)[^。！？\n]{0,12}(?:受支持|获支持|已支持|支持|兼容)/u
      .test(normalized);
}

function isAllowedTargetSentence(sentence: string): boolean {
  const target =
    "(?:目标协议|该协议|此协议|(?:2035年?)?量子卫星邮件协议)";
  const omitted =
    "(?:未|尚未)(?:提及|覆盖|收录|包含)";
  const uncertainty =
    "(?:无法|不能)(?:根据|基于)?正式知识库(?:确认|判断)" +
    `(?:${target})?(?:是否)?(?:支持|兼容)?`;
  return new RegExp(
    `^正式知识库(?:中)?${omitted}(?:有关|关于)?${target}` +
      `(?:的)?(?:资料|信息|内容)?(?:[，,](?:因此|所以)?${uncertainty})?$`,
    "u",
  ).test(sentence) ||
    new RegExp(
      `^${target}(?:在)?正式知识库(?:中)?${omitted}` +
        "(?:的)?(?:资料|信息|内容)?$",
      "u",
    ).test(sentence) ||
    new RegExp(`^(?:当前)?${uncertainty}$`, "u").test(sentence);
}

function readOwnershipToken(directory: string): string | undefined {
  try {
    return readFileSync(path.join(directory, DIAGNOSTICS_OWNER_FILE), "utf8");
  } catch {
    return undefined;
  }
}

function validateVisibleFormalReferences(
  result: AnswerResult,
  relatedSection: string,
): void {
  const sourcesStart = result.answer.indexOf(formalSourcesHeading);
  const sourcesSection = result.answer.slice(
    sourcesStart + formalSourcesHeading.length,
  );
  const relatedCitations = new Set(
    [...relatedSection.matchAll(/\[(\d+)\]/gu)].map((match) =>
      Number.parseInt(match[1] ?? "", 10)),
  );
  const referenceIndexes = new Set(
    result.references.map((reference) => reference.index),
  );
  if (
    referenceIndexes.size !== result.references.length ||
    relatedCitations.size !== referenceIndexes.size ||
    [...referenceIndexes].some((index) => !relatedCitations.has(index))
  ) {
    throw new Error("formal_reference_partition_mismatch");
  }
  for (const reference of result.references) {
    if (
      reference.project !== "coremail-professional" ||
      !sourcesSection.includes(`[${reference.index}]`) ||
      !sourcesSection.includes(reference.title) ||
      !sourcesSection.includes(`${reference.project}/${reference.path}`)
    ) {
      throw new Error("formal_reference_not_visible");
    }
  }
}

async function probe(): Promise<void> {
  if (process.env.COREMAIL_MCP_ENABLED !== "true") {
    throw new Error("coremail_probe_not_enabled");
  }
  const { directory: diagnosticsDirectory, ownershipToken } =
    createProbeDiagnosticsDirectory();
  const env = getDefaultEnvironment();
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.PSE_DIAGNOSTICS_ENABLED = "true";
  env.PSE_DIAGNOSTICS_DIR = diagnosticsDirectory;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["apps/pseagent/dist/main.js"],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {
    // Drain child status codes without printing configuration or content.
  });
  const client = new Client({
    name: "pseagent-related-context-probe",
    version: "0.1.0",
  });
  const seenRequestIds = new Set<string>();
  try {
    await client.connect(transport, { timeout: 60_000 });
    const tools = await client.listTools(undefined, { timeout: 60_000 });
    if (tools.tools.length !== 1 || tools.tools[0]?.name !== "pse_answer") {
      throw new Error("unexpected_outer_tool_list");
    }

    await runRelatedContextAttempts(async (run, callBudgetMs) => {
      const started = performance.now();
      const raw = await client.callTool(
        {
          name: "pse_answer",
          arguments: { question: probeCase.question },
        },
        undefined,
        { timeout: callBudgetMs },
      );
      const result = answerResultSchema.parse(raw.structuredContent);
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs > callBudgetMs) {
        throw new Error("probe_deadline_exceeded");
      }

      const newFinishEvents = readProbeFinishEvents(diagnosticsDirectory)
        .filter((event) => !seenRequestIds.has(event.requestId));
      if (newFinishEvents.length !== 1) {
        throw new Error("unexpected_finish_event_count");
      }
      const finish = newFinishEvents[0];
      if (!finish) throw new Error("unexpected_finish_event_count");
      seenRequestIds.add(finish.requestId);
      const summary = validateRelatedContextAcceptance(
        result,
        finish,
        probeCase.relatedFacts,
      );
      process.stdout.write(
        `run=${run} scope=${result.scope} status=${result.status}` +
        ` formal_refs=${summary.formalRefs} history_refs=${summary.historyRefs}` +
        ` historical_used=${summary.historicalUsed} elapsed_ms=${elapsedMs}\n`,
      );
    });
  } finally {
    await client.close().catch(() => undefined);
    removeProbeDiagnosticsDirectory(diagnosticsDirectory, ownershipToken);
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(entry)).href
) {
  probe().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    const code = safeFailureCodes.has(message) ? message : "unclassified";
    process.stderr.write(`probe_related_context_failed code=${code}\n`);
    process.exitCode = 1;
  });
}
