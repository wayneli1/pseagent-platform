import { performance } from "node:perf_hooks";
import {
  createPseAgentRuntime,
  formatMcpText,
  type PseAnswerExecution,
} from "../apps/pseagent/src/embedded.ts";
import {
  LunkrPseBridge,
  loadLunkrConfig,
  type BridgeQuestionEvent,
  type LunkrDirectMessage,
} from "../integrations/lunkr-direct/src/index.ts";

const question = process.env.PSE_REPEAT_QUESTION?.trim() ||
  "对比exchange邮件系统，coremail的优势有哪些呢";
const repeat = positiveInteger(process.env.PSE_REPEAT_COUNT, 10);
const sessions = positiveInteger(process.env.PSE_REPEAT_SESSIONS, 2);
if (sessions > 4) throw new Error("PSE_REPEAT_SESSIONS must be <= 4");

const requiredFactGroups = [
  ["个性化定制", "定制化需求"],
  ["TCO", "总拥有成本"],
  ["现场服务", "原厂人员"],
  ["安全功能", "安全能力", "密级邮件", "私有加密"],
  ["客观", "实际情况", "具体场景", "版本", "许可"],
] as const;
const expectedEvidencePages = new Set([
  "wiki/comparison/coremail-vs-exchange对比.md",
  "wiki/concepts/功能对比清单-Exchange-vs-Coremail.md",
]);

const summaries = await Promise.all(
  Array.from({ length: sessions }, (_, index) => runSession(index + 1)),
);
const total = summaries.reduce((sum, item) => sum + item.total, 0);
const failed = summaries.reduce((sum, item) => sum + item.failed, 0);
const retried = summaries.reduce((sum, item) => sum + item.retried, 0);
process.stdout.write(`${JSON.stringify({
  type: "summary",
  sessions,
  repeat,
  total,
  failed,
  retried,
})}\n`);
if (failed > 0) process.exitCode = 1;

async function runSession(sessionNumber: number): Promise<{
  readonly total: number;
  readonly failed: number;
  readonly retried: number;
}> {
  const runtime = await createPseAgentRuntime(process.env);
  let lastAttempts: Array<{
    readonly contextChars: number;
    readonly execution: PseAnswerExecution;
  }> = [];
  let lastEvent: BridgeQuestionEvent | undefined;
  const bridge = new LunkrPseBridge(loadLunkrConfig(), {
    answer: async (input, context, signal) => {
      const execution = await runtime.answerDetailed(input, context, signal);
      lastAttempts.push({ contextChars: context?.length ?? 0, execution });
      return execution;
    },
    formatAnswer: (execution) => formatMcpText(execution.result),
    formatContextAnswer: (execution) => execution.result.answer,
    describeResult: (execution) => ({
      scope: execution.result.scope,
      status: execution.result.status,
      retryable: execution.retryable,
      stopReason: execution.stopReason,
      referenceCount: execution.result.references.length,
      historicalAttempted: execution.historicalAttempted,
      historicalUsed: execution.historicalUsed,
      draftCoverage: execution.draftCoverage,
      verifiedCoverage: execution.verifiedCoverage,
      historicalGateReason: execution.historicalGateReason,
    }),
    sendText: async () => undefined,
    sendTextFile: async () => undefined,
    sendPost: async () => undefined,
    onEvent(event) {
      if (event.type === "answered" || event.type === "failed") {
        lastEvent = event;
      }
    },
  });
  let failed = 0;
  let retried = 0;
  try {
    for (let sequence = 1; sequence <= repeat; sequence += 1) {
      lastAttempts = [];
      lastEvent = undefined;
      const started = performance.now();
      await bridge.handle(message(sessionNumber, sequence));
      const finalAttempt = lastAttempts.at(-1);
      const execution = finalAttempt?.execution;
      const answer = execution?.result.answer ?? "";
      const paths = execution?.result.references.map((reference) => reference.path) ?? [];
      const factGroupsCovered = requiredFactGroups.filter((group) =>
        group.some((fact) => answer.includes(fact))).length;
      const missingFactGroups = requiredFactGroups
        .map((group, index) => ({ index: index + 1, group }))
        .filter(({ group }) => !group.some((fact) => answer.includes(fact)))
        .map(({ index }) => index);
      const contextIsolated = lastAttempts.every((attempt) => attempt.contextChars === 0);
      const succeeded =
        lastEvent?.type === "answered" &&
        (execution?.result.status === "answered" ||
          execution?.result.status === "partially_answered") &&
        (execution.result.references.length ?? 0) > 0 &&
        paths.some((path) => expectedEvidencePages.has(path)) &&
        execution.historicalAttempted === false &&
        contextIsolated &&
        factGroupsCovered === requiredFactGroups.length;
      if (!succeeded) failed += 1;
      if (lastAttempts.length > 1) retried += 1;
      process.stdout.write(`${JSON.stringify({
        type: "result",
        session: sessionNumber,
        sequence,
        event: lastEvent?.type ?? "missing",
        attempts: lastAttempts.length,
        contextChars: lastAttempts.map((attempt) => attempt.contextChars),
        scope: execution?.result.scope,
        status: execution?.result.status,
        stopReason: execution?.stopReason,
        references: execution?.result.references.length ?? 0,
        evidenceMatched: paths.some((path) => expectedEvidencePages.has(path)),
        evidencePaths: paths,
        factGroupsCovered,
        missingFactGroups,
        historicalAttempted: execution?.historicalAttempted,
        elapsedMs: Math.round(performance.now() - started),
        succeeded,
        ...(process.env.PSE_REPEAT_INCLUDE_ANSWER === "1" ? { answer } : {}),
      })}\n`);
    }
  } finally {
    await runtime.close();
  }
  return { total: repeat, failed, retried };
}

function message(sessionNumber: number, sequence: number): LunkrDirectMessage {
  const peerUid = `#repeat-session-${sessionNumber}#U`;
  return {
    id: `repeat-${sessionNumber}-${sequence}`,
    peerUid,
    senderUid: peerUid,
    timestamp: Date.now(),
    text: question,
    hasAttachments: false,
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("repeat options must be positive integers");
  }
  return parsed;
}
