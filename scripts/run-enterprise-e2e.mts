import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.js";
import type { PseAnswerExecution } from "../apps/pseagent/src/answer-service.js";
import { answerResultSchema } from "../apps/pseagent/src/contracts.js";
import { createPseMcpServer } from "../apps/pseagent/src/mcp-server.js";
import {
  acceptanceFactGroupCovered,
  selectAcceptanceCases,
  validateAcceptanceMatrix,
  type AcceptanceCase,
  type AcceptanceMatrix,
  type AcceptancePhase,
} from "../apps/pseagent/src/enterprise-e2e-matrix.js";
import {
  buildAnswerOutline,
  ConversationStore,
  HttpFeedbackClient,
  pseudonymizeFeedbackUser,
} from "../integrations/lunkr-direct/src/index.js";

const firstRoundMatrixPath = new URL("../tests/e2e/enterprise-knowledge-acceptance-20260806.json", import.meta.url);
const configuredMatrixPath = process.env.E2E_MATRIX_PATH?.trim();
const matrixPath = configuredMatrixPath === undefined || configuredMatrixPath === ""
  ? firstRoundMatrixPath
  : configuredMatrixPath;
const firstRoundMatrix = JSON.parse(await readFile(firstRoundMatrixPath, "utf8")) as AcceptanceMatrix;
const isStrictSecondRound = matrixPath !== firstRoundMatrixPath;
const matrix = validateAcceptanceMatrix(JSON.parse(await readFile(matrixPath, "utf8")), {
  phase1Count: isStrictSecondRound ? 20 : 19,
  supplementCount: isStrictSecondRound ? 0 : 4,
  postPublishCount: isStrictSecondRound ? 0 : 5,
  forbiddenQuestions: isStrictSecondRound
    ? [...firstRoundMatrix.cases, ...firstRoundMatrix.supplementCases, ...firstRoundMatrix.postPublishCases]
      .map((testCase) => testCase.question)
    : [],
});
assertEnvironment(matrix);
const requestedPhase = process.env.E2E_PHASE?.trim();
const phase: AcceptancePhase = requestedPhase === "supplement"
  ? "supplement"
  : requestedPhase === "post_publish"
    ? "post_publish"
    : "phase1";
const selectedCases = selectAcceptanceCases(matrix, phase, process.env.E2E_CASE_ID, {
  requireSingleCase: isStrictSecondRound,
});
if (process.env.E2E_VALIDATE_ONLY === "1") {
  process.stdout.write(`${JSON.stringify({
    type: "matrix_validated",
    batchId: matrix.batchId,
    phase,
    selectedCaseIds: selectedCases.map((testCase) => testCase.id),
    strictSingleCase: isStrictSecondRound,
  })}\n`);
  process.exit(0);
}

const runtime = await createPseAgentRuntime(process.env);
const feedback = new HttpFeedbackClient({
  baseUrl: required("KNOWLEDGE_OPS_BASE_URL"),
  serviceToken: required("KNOWLEDGE_OPS_SERVICE_TOKEN"),
  timeoutMs: 12_000,
});
const pseudonymizationKey = required("PSE_FEEDBACK_PSEUDONYMIZATION_KEY");
const conversations = new Map<string, ConversationStore>();
const executions: PseAnswerExecution[] = [];
const server = createPseMcpServer({
  answer: async (question, conversationContext, signal) => {
    const execution = await runtime.answerDetailed(question, conversationContext, signal);
    executions.push(execution);
    return execution.result;
  },
});
const client = new Client({ name: "codex-enterprise-e2e", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const catalog = JSON.parse(await readFile(required("PSE_ANSWER_CARD_CATALOG_PATH"), "utf8")) as {
  cards: readonly { readonly cardId: string }[];
};
const cardIdsByHash = new Map(catalog.cards.map((card) => [sha256(card.cardId), card.cardId]));
const toolList = await client.listTools();
const pseTool = toolList.tools.find((tool) => tool.name === "pse_answer");
if (toolList.tools.length !== 1 || pseTool === undefined) throw new Error("pse_answer_tool_contract_invalid");
process.stdout.write(`${JSON.stringify({ type: "schema", tool: pseTool })}\n`);

const startCase = process.env.E2E_START_CASE?.trim();
const startIndex = startCase === undefined || startCase === ""
  ? 0
  : selectedCases.findIndex((testCase) => testCase.id === startCase);
if (startIndex < 0) throw new Error(`enterprise_e2e_start_case_unknown:${startCase}`);
const records: Record<string, unknown>[] = [];
try {
  for (const [index, testCase] of selectedCases.entries()) {
    if (index < startIndex) continue;
    const questionId = index + 1 + (phase === "supplement" ? 100 : phase === "post_publish" ? 200 : 0);
    const peerUid = `codex-e2e:${matrix.batchId}:${testCase.session}`;
    const userId = pseudonymizeFeedbackUser(peerUid, pseudonymizationKey);
    let conversation = conversations.get(testCase.session);
    if (conversation === undefined) {
      conversation = new ConversationStore(6, 32_768);
      const persisted = await feedback.loadConversation(userId, 6);
      conversation.replace(peerUid, persisted.recentTurns.map((turn) => ({
        question: turn.resolvedQuestion,
        ...(turn.answerOutline === undefined ? {} : { answerOutline: turn.answerOutline }),
        ...(turn.scope === undefined ? {} : { scope: turn.scope }),
        ...(turn.answerCardMatch?.cardIdHashes === undefined
          ? {}
          : { answerCardIdHashes: turn.answerCardMatch.cardIdHashes }),
      })));
      conversations.set(testCase.session, conversation);
    }
    let forceNewSession = false;
    if (testCase.resetConversationBefore) {
      conversation.clear(peerUid);
      await feedback.endConversation(userId, "manual", new Date().toISOString());
      forceNewSession = true;
    }
    const conversationContext = testCase.useConversationContext
      ? conversation.context(peerUid, testCase.question)
      : undefined;
    if (testCase.useConversationContext && conversationContext === undefined) {
      throw new Error(`required_context_missing:${testCase.id}`);
    }
    const expectation = {
      testId: testCase.id,
      batchId: matrix.batchId,
      question: testCase.question,
      type: testCase.matrixType,
      contextMode: testCase.useConversationContext ? "follow_up" : testCase.resetConversationBefore ? "new_session" : "independent",
      expectedScope: testCase.expectedScope,
      expectedTarget: testCase.expectedTarget,
      expectedCardId: testCase.expectedCardId,
      expectedEvidence: testCase.expectedEvidence,
      requiredFactGroups: testCase.requiredFactGroups,
      forbiddenClaims: testCase.forbiddenClaims,
      expectedBehavior: testCase.expectedBehavior,
      baselineAssessment: testCase.baselineAssessment,
      expectedIssueCenter: testCase.expectedIssueCenter,
    };
    process.stdout.write(`${JSON.stringify({ type: "case_started", expectation })}\n`);
    const executionIndex = executions.length;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let rawResult: Awaited<ReturnType<Client["callTool"]>>;
    try {
      rawResult = await client.callTool(
        {
          name: "pse_answer",
          arguments: {
            question: testCase.question,
            ...(conversationContext === undefined ? {} : { conversationContext }),
          },
        },
        undefined,
        { timeout: 330_000, maxTotalTimeout: 330_000 },
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      const failure = error instanceof Error ? `${error.name}:${error.message}` : "unknown_error";
      records.push({ expectation, conversationContext: conversationContext ?? "", startedAt, completedAt, failure });
      process.stdout.write(`${JSON.stringify({ type: "case_failed", testId: testCase.id, failure, completedAt })}\n`);
      continue;
    }
    const execution = executions[executionIndex];
    if (execution === undefined || executions.length !== executionIndex + 1) {
      throw new Error(`pse_answer_execution_correlation_failed:${testCase.id}`);
    }
    const result = answerResultSchema.parse(rawResult.structuredContent);
    const completedAt = new Date().toISOString();
    const latencyMs = Math.round(performance.now() - started);
    const match = execution.answerCardMatch;
    const matchedCardIds = (match?.cardIdHashes ?? []).map((hash) => cardIdsByHash.get(hash) ?? `hash:${hash}`);
    const questionResolution = execution.questionResolution;
    const answeredAt = completedAt;
    let conversationPersisted = false;
    if (result.status === "answered" || result.status === "partially_answered") {
      const answerOutline = buildAnswerOutline(result.answer);
      conversation.append(peerUid, {
        question: questionResolution?.standaloneQuestion ?? testCase.question,
        answer: result.answer,
        scope: result.scope,
        ...(match?.cardIdHashes === undefined
          ? {}
          : { answerCardIdHashes: match.cardIdHashes }),
      });
      try {
        await feedback.appendConversation({
          turnId: randomUUID(),
          requestId: execution.requestId,
          pseudonymousUserId: userId,
          questionId,
          rawQuestion: testCase.question,
          resolvedQuestion: questionResolution?.standaloneQuestion ?? testCase.question,
          contextUsed: questionResolution?.contextUsed === true,
          inheritedSubjects: questionResolution?.inheritedSubjects ?? [],
          ...(answerOutline === undefined ? {} : { answerOutline }),
          answerStatus: result.status,
          scope: result.scope,
          ...(match === undefined ? {} : { answerCardMatch: { ...match } }),
          answeredAt,
          expiresAt: new Date(Date.parse(answeredAt) + 24 * 60 * 60_000).toISOString(),
          source: "lunkr_direct",
          ...(forceNewSession ? { forceNewSession: true } : {}),
        });
        conversationPersisted = true;
      } catch {
        conversationPersisted = false;
      }
    }
    let answerReviewSubmitted: boolean | undefined;
    if (result.scope === "professional" || result.scope === "general") {
      try {
        await feedback.submitReview({
          reviewId: randomUUID(),
          requestId: execution.requestId,
          pseudonymousUserId: userId,
          userDisplayName: matrix.userDisplayName,
          questionId,
          question: testCase.question,
          answer: result.answer,
          answerStatus: result.status,
          scope: result.scope,
          references: result.references,
          answeredAt,
          submittedAt: new Date().toISOString(),
          source: "lunkr_direct",
          ...(match === undefined ? {} : { answerCardMatch: { ...match } }),
          ...(execution.answerCardActivation === undefined ? {} : { answerCardActivation: { ...execution.answerCardActivation } }),
        });
        answerReviewSubmitted = true;
      } catch {
        answerReviewSubmitted = false;
      }
    }
    const deterministicChecks = evaluate(testCase, execution, matchedCardIds);
    const record = {
      expectation,
      conversationContext: conversationContext ?? "",
      startedAt,
      completedAt,
      latencyMs,
      requestId: execution.requestId,
      actualScope: result.scope,
      answerStatus: result.status,
      answer: result.answer,
      references: result.references,
      evidencePaths: result.references.map((reference) => reference.path),
      evidenceRevisions: [...new Set(result.references.map((reference) => reference.revision))],
      answerCardIds: matchedCardIds,
      answerCardMatch: execution.answerCardMatch,
      answerCardActivation: execution.answerCardActivation,
      questionResolution,
      contextUsed: questionResolution?.contextUsed ?? false,
      conversationPersisted,
      answerReviewSubmitted: answerReviewSubmitted ?? false,
      deterministicChecks,
      publicResult: result,
      execution,
    };
    records.push(record);
    process.stdout.write(`${JSON.stringify({
      type: "case_completed",
      testId: testCase.id,
      requestId: execution.requestId,
      scope: result.scope,
      status: result.status,
      matchType: match?.matchType ?? "none",
      answerCardIds: matchedCardIds,
      activated: execution.answerCardActivation?.activated ?? false,
      contextUsed: questionResolution?.contextUsed ?? false,
      referenceCount: result.references.length,
      conversationPersisted,
      answerReviewSubmitted: answerReviewSubmitted ?? false,
      deterministicPassed: deterministicChecks.every((check) => check.passed),
      latencyMs,
      completedAt,
    })}\n`);
  }
} finally {
  await Promise.allSettled([client.close(), server.close(), runtime.close()]);
}

const report = {
  batchId: matrix.batchId,
  userDisplayName: matrix.userDisplayName,
  model: matrix.model,
  phase,
  schema: pseTool,
  generatedAt: new Date().toISOString(),
  records,
};
const reportDirectory = join(tmpdir(), "pseagent-enterprise-e2e", matrix.batchId);
await mkdir(reportDirectory, { recursive: true });
const reportPath = join(reportDirectory, `${phase}-${Date.now()}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ type: "phase_summary", reportPath, caseCount: records.length })}\n`);

function evaluate(testCase: AcceptanceCase, execution: PseAnswerExecution, cardIds: readonly string[]) {
  const answer = execution.result.answer.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const paths = new Set(execution.result.references.map((reference) => reference.path));
  const expectedCardIds = testCase.expectedCardId === undefined
    ? []
    : [testCase.expectedCardId, `hash:${sha256(testCase.expectedCardId)}`];
  return [
    { id: "scope", passed: execution.result.scope === testCase.expectedScope, expected: testCase.expectedScope, actual: execution.result.scope },
    { id: "card", passed: testCase.expectedCardId === undefined || expectedCardIds.some((cardId) => cardIds.includes(cardId)), expected: testCase.expectedCardId ?? "none_required", actual: cardIds },
    ...testCase.expectedEvidence.map((path) => ({ id: `evidence:${path}`, passed: paths.has(path), expected: path, actual: [...paths] })),
    ...testCase.requiredFactGroups.map((group, index) => ({ id: `fact:${index + 1}`, passed: acceptanceFactGroupCovered(execution.result.answer, testCase.question, group), expected: group, actual: "answer" })),
    ...testCase.forbiddenClaims.map((claim) => ({ id: `forbidden:${claim}`, passed: !answer.includes(claim.normalize("NFKC").toLocaleLowerCase("zh-CN")), expected: "absent", actual: "answer" })),
  ];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertEnvironment(value: AcceptanceMatrix): void {
  const models = [
    process.env.PSE_MODEL_NAME,
    process.env.PSE_RESOLVER_MODEL_NAME,
    process.env.PSE_PLANNER_MODEL_NAME,
    process.env.PSE_SYNTHESIZER_MODEL_NAME,
    process.env.PSE_VERIFIER_MODEL_NAME,
    process.env.PSE_ANSWER_REVIEW_MODEL_NAME,
    process.env.PSE_REPAIR_MODEL_NAME ?? process.env.PSE_MODEL_NAME,
  ];
  if (value.model !== "deepseek_v4_flash" || models.some((model) => model !== value.model)) {
    throw new Error("enterprise_e2e_requires_deepseek_v4_flash");
  }
}
