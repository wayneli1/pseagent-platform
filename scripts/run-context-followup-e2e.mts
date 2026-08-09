import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPseAgentRuntime } from "../apps/pseagent/src/embedded.js";
import type { PseAnswerExecution } from "../apps/pseagent/src/answer-service.js";
import { answerResultSchema } from "../apps/pseagent/src/contracts.js";
import { createPseMcpServer } from "../apps/pseagent/src/mcp-server.js";
import {
  buildAnswerOutline,
  ConversationStore,
  HttpFeedbackClient,
  pseudonymizeFeedbackUser,
} from "../integrations/lunkr-direct/src/index.js";

const batchId = required("E2E_CONTEXT_BATCH_ID");
const session = required("E2E_CONTEXT_SESSION");
const question = required("E2E_FOLLOWUP_QUESTION");
const peerUid = `codex-e2e:${batchId}:${session}`;
const feedback = new HttpFeedbackClient({
  baseUrl: required("KNOWLEDGE_OPS_BASE_URL"),
  serviceToken: required("KNOWLEDGE_OPS_SERVICE_TOKEN"),
  timeoutMs: 30_000,
});
const pseudonymousUserId = pseudonymizeFeedbackUser(
  peerUid,
  required("PSE_FEEDBACK_PSEUDONYMIZATION_KEY"),
);
const persisted = await feedback.loadConversation(pseudonymousUserId, 6);
const conversation = new ConversationStore(6, 32_768);
conversation.replace(peerUid, persisted.recentTurns.map((turn) => ({
  question: turn.resolvedQuestion,
  ...(turn.answerOutline === undefined ? {} : { answerOutline: turn.answerOutline }),
  ...(turn.scope === undefined ? {} : { scope: turn.scope }),
  ...(turn.answerCardMatch?.cardIdHashes === undefined
    ? {}
    : { answerCardIdHashes: turn.answerCardMatch.cardIdHashes }),
})));
const conversationContext = conversation.context(peerUid, question);
if (conversationContext === undefined) throw new Error("persisted_conversation_context_required");

const runtime = await createPseAgentRuntime(process.env);
let execution: PseAnswerExecution | undefined;
const server = createPseMcpServer({
  answer: async (value, context, signal) => {
    execution = await runtime.answerDetailed(value, context, signal);
    return execution.result;
  },
});
const client = new Client({ name: "codex-context-followup-e2e", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const raw = await client.callTool({
    name: "pse_answer",
    arguments: { question, conversationContext },
  }, undefined, { timeout: 330_000, maxTotalTimeout: 330_000 });
  const current = execution;
  if (current === undefined) throw new Error("execution_missing");
  const answer = answerResultSchema.parse(raw.structuredContent);
  const answeredAt = new Date().toISOString();
  const questionId = Number(process.env.E2E_QUESTION_ID ?? "401");
  const resolvedQuestion = current.questionResolution?.standaloneQuestion ?? question;
  const answerOutline = buildAnswerOutline(answer.answer);

  if (answer.status === "answered" || answer.status === "partially_answered") {
    await feedback.appendConversation({
      turnId: randomUUID(),
      requestId: current.requestId,
      pseudonymousUserId,
      questionId,
      rawQuestion: question,
      resolvedQuestion,
      contextUsed: current.questionResolution?.contextUsed === true,
      inheritedSubjects: current.questionResolution?.inheritedSubjects ?? [],
      ...(answerOutline === undefined ? {} : { answerOutline }),
      answerStatus: answer.status,
      scope: answer.scope,
      ...(current.answerCardMatch === undefined ? {} : { answerCardMatch: current.answerCardMatch }),
      answeredAt,
      expiresAt: new Date(Date.parse(answeredAt) + 86_400_000).toISOString(),
      source: "lunkr_direct",
    });
  }

  let reviewId: string | undefined;
  if (answer.scope === "professional" || answer.scope === "general") {
    reviewId = randomUUID();
    await feedback.submitReview({
      reviewId,
      requestId: current.requestId,
      pseudonymousUserId,
      userDisplayName: process.env.E2E_USER_DISPLAY_NAME?.trim() || `Codex 自动测试 · ${batchId}`,
      questionId,
      question,
      answer: answer.answer,
      answerStatus: answer.status,
      scope: answer.scope,
      references: answer.references,
      answeredAt,
      submittedAt: new Date().toISOString(),
      source: "lunkr_direct",
      ...(current.answerCardMatch === undefined ? {} : { answerCardMatch: current.answerCardMatch }),
      ...(current.answerCardActivation === undefined ? {} : { answerCardActivation: current.answerCardActivation }),
    });
  }

  console.log(JSON.stringify({
    batchId,
    session,
    persistedTurnCount: persisted.recentTurns.length,
    conversationContext,
    question,
    resolvedQuestion,
    requestId: current.requestId,
    reviewId,
    answerStatus: answer.status,
    scope: answer.scope,
    answer: answer.answer,
    references: answer.references,
    answerCardMatch: current.answerCardMatch,
    answerCardActivation: current.answerCardActivation,
    questionResolution: current.questionResolution,
  }, null, 2));
} finally {
  await Promise.allSettled([client.close(), server.close(), runtime.close()]);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}
