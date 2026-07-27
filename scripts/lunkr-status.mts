import {
  LunkrAuthService,
  SessionStore,
  getLunkrSessionStatus,
  loadLunkrConfig,
  safeError,
} from "../integrations/lunkr-direct/src/index.ts";

try {
  const config = loadLunkrConfig();
  const store = new SessionStore(config.sessionPath);
  const auth = new LunkrAuthService(config, store);
  const status = await getLunkrSessionStatus(
    store,
    (session) => auth.verify(session),
  );
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (!status.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Lunkr Session 检查失败：${safeError(error)}\n`);
  process.exitCode = 1;
}
