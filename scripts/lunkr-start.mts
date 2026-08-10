import {
  DpapiPasswordStore,
  LunkrApi,
  LunkrAuthService,
  LunkrLoginRequiredError,
  LunkrPseBridge,
  HttpFeedbackClient,
  LunkrSocketClient,
  SessionStore,
  createRuntimeLogger,
  ensureLunkrSession,
  loadLunkrConfig,
  normalizeDirectMessage,
  safeError,
} from "../integrations/lunkr-direct/src/index.ts";
import {
  createPseAgentRuntime,
  formatMcpText,
} from "../apps/pseagent/src/embedded.ts";

const config = loadLunkrConfig();
const store = new SessionStore(config.sessionPath);
const passwords = new DpapiPasswordStore(config.passwordPath);
const auth = new LunkrAuthService(config, store);
let session;
try {
  const resolved = await ensureLunkrSession({
    sessions: store,
    passwords,
    auth,
  });
  session = resolved.session;
  if (resolved.renewedWithStoredPassword) {
    process.stderr.write("lunkr.session.renewed_from_stored_password\n");
  }
} catch (error) {
  if (error instanceof LunkrLoginRequiredError) {
    process.stderr.write(
      "Lunkr 需要登录；如需保存密码，请执行 npm run lunkr:login -- --store-password。\n",
    );
  } else {
    process.stderr.write(
      `Lunkr 自动续登失败：${safeError(error)}。请执行 npm run lunkr:login -- --store-password。\n`,
    );
  }
  process.exit(1);
}

const runtime = await createPseAgentRuntime(process.env);
const feedbackValues = [
  process.env.KNOWLEDGE_OPS_BASE_URL,
  process.env.KNOWLEDGE_OPS_SERVICE_TOKEN,
  process.env.PSE_FEEDBACK_PSEUDONYMIZATION_KEY,
];
if (feedbackValues.some(Boolean) && !feedbackValues.every(Boolean)) {
  throw new Error("knowledge_ops_feedback_configuration_incomplete");
}
const feedbackClient = feedbackValues.every(Boolean)
  ? new HttpFeedbackClient({
      baseUrl: feedbackValues[0]!,
      serviceToken: feedbackValues[1]!,
    })
  : undefined;
const api = new LunkrApi(config, session);
const logQuestionEvent = createRuntimeLogger(
  (line) => process.stderr.write(line),
);
const bridge = new LunkrPseBridge(config, {
  answer: runtime.answerDetailed,
  formatAnswer: (execution) => formatMcpText(execution.result),
  formatContextAnswer: (execution) => execution.result.answer,
  describeResult: (execution) => ({
    requestId: execution.requestId,
    scope: execution.result.scope,
    status: execution.result.status,
    retryable: execution.retryable,
    stopReason: execution.stopReason,
    referenceCount:
      execution.result.references.length +
      (execution.result.historicalAnswer?.references.length ?? 0),
    historicalAttempted: execution.historicalAttempted,
    historicalUsed: execution.historicalUsed,
    historicalNoticeShown: execution.historicalNoticeShown,
    historicalRejectedReason: execution.historicalRejectedReason,
    draftCoverage: execution.draftCoverage,
    verifiedCoverage: execution.verifiedCoverage,
    retainedDirectSegmentCount: execution.retainedDirectSegmentCount,
    retainedSynthesizedSegmentCount:
      execution.retainedSynthesizedSegmentCount,
    removedSegmentCount: execution.removedSegmentCount,
    historicalGateReason: execution.historicalGateReason,
    answerCardMatch: execution.answerCardMatch,
    answerCardActivation: execution.answerCardActivation,
    references: execution.result.references,
    resolvedQuestion: execution.questionResolution?.standaloneQuestion,
    contextUsed: execution.questionResolution?.contextUsed,
    inheritedSubjects: execution.questionResolution?.inheritedSubjects,
  }),
  sendText: (peerUid, text) => api.sendText(peerUid, text),
  sendTextFile: (peerUid, title, content, caption) =>
    api.sendTextFile(peerUid, title, content, caption),
  sendPost: (peerUid, title, content) =>
    api.sendPost(peerUid, title, content),
  onEvent: logQuestionEvent,
  ...(feedbackClient === undefined ? {} : {
    feedback: {
      pseudonymizationKey: feedbackValues[2]!,
      submit: (submission) => feedbackClient.submit(submission),
    },
    answerReview: {
      pseudonymizationKey: feedbackValues[2]!,
      submit: (submission) => feedbackClient.submitReview(submission),
    },
    conversation: {
      pseudonymizationKey: feedbackValues[2]!,
      load: (pseudonymousUserId,maxTurns) => feedbackClient.loadConversation(pseudonymousUserId,maxTurns),
      append: (submission) => feedbackClient.appendConversation(submission),
      end: (pseudonymousUserId,reason,endedAt) => feedbackClient.endConversation(pseudonymousUserId,reason,endedAt),
    },
  }),
});
const socket = new LunkrSocketClient(config, session, {
  onState(state) {
    process.stderr.write(`lunkr.socket.${state}\n`);
  },
  onEvent(name, data) {
    if (name !== "message") return;
    const message = normalizeDirectMessage(data, session.selfUid);
    if (message === undefined) return;
    void bridge.handle(message)
      .catch((error: unknown) => {
        process.stderr.write(`lunkr.dm.failed reason=${safeError(error)}\n`);
      });
  },
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  socket.close();
  await runtime.close();
};
process.once("SIGINT", () => {
  process.stderr.write("pseagent.lunkr.stopping signal=SIGINT\n");
  void stop();
});
process.once("SIGTERM", () => {
  process.stderr.write("pseagent.lunkr.stopping signal=SIGTERM\n");
  void stop();
});

try {
  await socket.connect();
  process.stderr.write("pseagent.lunkr.ready\n");
  await socket.wait();
} catch (error) {
  process.stderr.write(`PSEAgent Lunkr 启动失败：${safeError(error)}\n`);
  process.exitCode = 1;
} finally {
  await stop();
  process.stderr.write("pseagent.lunkr.stopped\n");
}
