import {
  DpapiPasswordStore,
  LunkrApi,
  LunkrAuthService,
  LunkrLoginRequiredError,
  LunkrPseBridge,
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
const api = new LunkrApi(config, session);
const logQuestionEvent = createRuntimeLogger(
  (line) => process.stderr.write(line),
);
const bridge = new LunkrPseBridge(config, {
  answer: runtime.answerDetailed,
  formatAnswer: (execution) => formatMcpText(execution.result),
  formatContextAnswer: (execution) => execution.result.answer,
  describeResult: (execution) => ({
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
  }),
  sendText: (peerUid, text) => api.sendText(peerUid, text),
  onEvent: logQuestionEvent,
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
      .catch(() => {
        process.stderr.write("lunkr.dm.failed\n");
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
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

try {
  await socket.connect();
  process.stderr.write("pseagent.lunkr.ready\n");
  await socket.wait();
} catch (error) {
  process.stderr.write(`PSEAgent Lunkr 启动失败：${safeError(error)}\n`);
  process.exitCode = 1;
} finally {
  await stop();
}
