import {
  LunkrAuthService,
  LunkrPasswordError,
  SessionStore,
  loadLunkrConfig,
  promptHidden,
  promptLine,
  safeError,
} from "../integrations/lunkr-direct/src/index.ts";

const config = loadLunkrConfig();
const store = new SessionStore(config.sessionPath);
const previous = await store.load();
const email = await promptLine("Lunkr 专用账号邮箱", previous?.email);
const auth = new LunkrAuthService(config, store);

try {
  let session;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await promptHidden("邮箱密码（不会保存）");
    try {
      session = await auth.login({
        email,
        password,
        onOtpRequired: async () => {
          await promptLine("服务端要求二次验证；请在其他设备完成后按回车");
        },
      });
      break;
    } catch (error) {
      if (!(error instanceof LunkrPasswordError) || attempt === 3) throw error;
      process.stderr.write(`邮箱或密码错误，还可重试 ${3 - attempt} 次。\n`);
    }
  }
  if (session === undefined) throw new Error("登录未完成");
  process.stdout.write(JSON.stringify({
    login: "success",
    email: session.email,
    selfUid: session.selfUid,
    sessionPath: config.sessionPath,
    passwordStored: false,
  }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`Lunkr 登录失败：${safeError(error)}\n`);
  process.exitCode = 1;
}
