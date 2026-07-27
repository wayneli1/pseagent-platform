import {
  LunkrApi,
  LunkrAuthService,
  LunkrPseBridge,
  LunkrSocketClient,
  SessionStore,
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
const session = await store.load();
if (session === undefined) {
  process.stderr.write("尚未登录 Lunkr，请先执行 npm run lunkr:login。\n");
  process.exit(1);
}
const auth = new LunkrAuthService(config, store);
if (!(await auth.verify(session))) {
  process.stderr.write("Lunkr Session 已失效，请重新执行 npm run lunkr:login。\n");
  process.exit(1);
}

const runtime = await createPseAgentRuntime(process.env);
const api = new LunkrApi(config, session);
const bridge = new LunkrPseBridge(config, {
  answer: runtime.answer,
  formatAnswer: formatMcpText,
  sendText: (peerUid, text) => api.sendText(peerUid, text),
});
const socket = new LunkrSocketClient(config, session, {
  onState(state) {
    process.stderr.write(`lunkr.socket.${state}\n`);
  },
  onEvent(name, data) {
    if (name !== "message") return;
    const message = normalizeDirectMessage(data, session.selfUid);
    if (message === undefined) return;
    process.stderr.write("lunkr.dm.received\n");
    void bridge.handle(message)
      .then(() => process.stderr.write("lunkr.dm.replied\n"))
      .catch((error) => {
        process.stderr.write(`lunkr.dm.failed ${safeError(error)}\n`);
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
