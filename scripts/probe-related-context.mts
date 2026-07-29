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
  answerStatusSchema,
  answerResultSchema,
  scopeSchema,
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
  allowedSourcePages: z.array(z.string().trim().min(1)).optional(),
}).passthrough();
const regressionCases = z.array(regressionCaseSchema).parse(JSON.parse(
  readFileSync(
    new URL("../tests/regression/questions.json", import.meta.url),
    "utf8",
  ),
));
const selectedProbeCase = regressionCases.find((item) => item.id === "P11");
if (
  !selectedProbeCase ||
  !selectedProbeCase.relatedFacts?.length ||
  !selectedProbeCase.allowedSourcePages?.length
) {
  throw new Error("missing_related_context_probe_case");
}
const probeCase = {
  question: selectedProbeCase.question,
  relatedFacts: selectedProbeCase.relatedFacts,
  allowedSourcePages: selectedProbeCase.allowedSourcePages,
} as const;

const finishEventSchema = z.object({
  event: z.literal("finish"),
  scope: scopeSchema,
  status: answerStatusSchema,
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
  "unexpected_answer_framing",
  "unsupported_related_protocol",
  "unsupported_related_relation",
  "missing_formal_reference",
  "formal_reference_partition_mismatch",
  "formal_reference_not_visible",
  "unexpected_formal_reference_page",
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
  allowedSourcePages: readonly string[],
) {
  const result = answerResultSchema.parse(resultInput);
  const finish = finishEventSchema.parse(finishInput);
  if (
    result.scope !== "professional" ||
    result.status !== "not_covered" ||
    finish.scope !== "professional" ||
    finish.status !== "not_covered"
  ) {
    throw new Error("unexpected_scope_or_status");
  }
  if (result.references.length === 0) {
    throw new Error("missing_formal_reference");
  }

  const {
    prefixSection,
    relatedSection,
    conclusionSection,
    sourcesSection,
  } = extractFormalSections(result.answer);
  if (prefixSection.trim().length > 0) {
    throw new Error("unexpected_answer_framing");
  }
  validateRelatedProtocols(relatedSection, supportedRelatedFacts);
  validateTargetConclusion(conclusionSection);
  if (containsTargetClaim(relatedSection) || containsTargetClaim(sourcesSection)) {
    throw new Error("unsupported_target_claim");
  }
  validateVisibleFormalReferences(
    result,
    relatedSection,
    sourcesSection,
    allowedSourcePages,
  );

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

function extractFormalSections(answer: string): {
  readonly prefixSection: string;
  readonly relatedSection: string;
  readonly conclusionSection: string;
  readonly sourcesSection: string;
} {
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
  return {
    prefixSection: answer.slice(0, relatedStart),
    relatedSection: answer.slice(
      relatedStart + formalRelatedHeading.length,
      conclusionStart,
    ),
    conclusionSection: answer.slice(
      conclusionStart + formalConclusionHeading.length,
      sourcesStart,
    ),
    sourcesSection: answer.slice(sourcesStart + formalSourcesHeading.length),
  };
}

function validateRelatedProtocols(
  relatedSection: string,
  supportedRelatedFacts: readonly string[],
): void {
  const allowedContextTokens = new Set(["COREMAIL"]);
  const protocolTokenPattern =
    /[A-Z][A-Z0-9]*(?:[\/+_.-][A-Z0-9]+)*/gu;
  const supportedTokens = new Set<string>();
  for (const fact of supportedRelatedFacts) {
    const tokens =
      fact.toLocaleUpperCase("en-US").match(protocolTokenPattern) ?? [];
    for (const token of tokens) {
      supportedTokens.add(token);
      if (token.includes("/")) {
        for (const component of token.split("/")) {
          supportedTokens.add(component);
        }
      }
    }
  }
  const visibleTokens =
    relatedSection.toLocaleUpperCase("en-US")
      .match(protocolTokenPattern) ?? [];
  const visibleProtocols = visibleTokens.filter((token) =>
    !allowedContextTokens.has(token));
  if (
    visibleProtocols.length === 0 ||
    visibleProtocols.some((token) => !supportedTokens.has(token))
  ) {
    throw new Error("unsupported_related_protocol");
  }
  const disallowedRelation =
    /(?:(?:可能|或许|疑似|大概|也许|似乎|是否|能否)\s*(?:列出|列举|记载|包括|包含|受支持|支持|兼容|相容|遵循|符合|具备|提供|采用|可用|使用)|(?:不|并非|非|未|尚未)\s*(?:列出|列举|记载|包括|包含|受支持|支持|兼容|相容|遵循|符合|具备|提供|采用|可用|使用)|(?:无法|不能|不足以|难以|拒绝)\s*(?:支持|兼容|相容|使用)|(?:已|已经|被)\s*(?:禁用|废弃|弃用|停用|淘汰)|禁止\s*使用|待确认|不确定)/u;
  if (disallowedRelation.test(relatedSection)) {
    throw new Error("unsupported_related_relation");
  }
  const positiveEvidence =
    /(?:列出|列举|记载|包括|包含|支持|受支持|兼容|相容|遵循|符合|具备|提供|采用|可用)/u
      .test(relatedSection);
  if (!positiveEvidence) {
    throw new Error("unsupported_related_relation");
  }
}

function validateTargetConclusion(conclusionSection: string): void {
  const normalized = conclusionSection.replace(/\s+/gu, "");
  if (
    !normalized.includes("正式知识库") ||
    !/(?:(?:2035年?)?量子卫星邮件协议|目标协议|该协议|此协议)/u.test(normalized) ||
    !/(?:支持|兼容|可用|通信|运行)/u.test(normalized) ||
    !/(?:无法|不能|不足以|难以)/u.test(normalized) ||
    !/(?:作出确认|得出结论|确认|判断|确定|证实|证明)/u.test(normalized)
  ) {
    throw new Error("missing_formal_uncertainty");
  }

  const negativeAssertion =
    /(?:不受支持|不支持|未受支持|未支持|尚未支持|不兼容|不可用|无法使用|禁用|禁止|废弃|弃用|停用|淘汰|过时|下线)/u;
  const positiveAssertion =
    /(?:(?:已经|已|明确)(?:受)?(?:支持|兼容|可用)|(?:已经|已)(?:证实|确认)(?:COREMAIL(?:邮件系统)?|邮件系统|目标协议|该协议|此协议)?(?:受)?(?:支持|兼容|可用)|(?:能够|可以)?正常(?:工作|运行|通信|使用)|(?:工作|运行|通信|使用)正常)/iu;
  const positiveTargetModifier =
    /(?:(?:已经|已|目前|当前|现已)?(?:受)?(?:支持|兼容|可用)|(?:已经|已|目前|当前|现已|正在)?(?:能够|可以)?(?:正常)?(?:工作|运行|通信|使用))的(?:(?:2035年?)?量子卫星邮件协议|目标协议|该协议|此协议)/u;
  if (
    negativeAssertion.test(normalized) ||
    positiveAssertion.test(normalized) ||
    positiveTargetModifier.test(normalized)
  ) {
    throw new Error("unsupported_target_claim");
  }
}

function containsTargetClaim(value: string): boolean {
  return /(?:目标协议|该协议|此协议|量子卫星|2035)/u.test(value);
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
  sourcesSection: string,
  allowedSourcePages: readonly string[],
): void {
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
  const actualPaths = result.references.map((reference) => reference.path);
  if (
    actualPaths.length !== allowedSourcePages.length ||
    new Set(actualPaths).size !== actualPaths.length ||
    allowedSourcePages.some((path) => !actualPaths.includes(path))
  ) {
    throw new Error("unexpected_formal_reference_page");
  }
  const sourceLines = sourcesSection
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const expectedSourceLines = result.references.map((reference) =>
    `[${reference.index}] ${reference.title} — ${reference.project}/${reference.path}`);
  if (
    sourceLines.length !== expectedSourceLines.length ||
    expectedSourceLines.some((line) => !sourceLines.includes(line))
  ) {
    throw new Error("unexpected_answer_framing");
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
        probeCase.allowedSourcePages,
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
