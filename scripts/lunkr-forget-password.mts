import {
  DpapiPasswordStore,
  loadLunkrConfig,
  safeError,
} from "../integrations/lunkr-direct/src/index.ts";

try {
  const config = loadLunkrConfig();
  const passwords = new DpapiPasswordStore(config.passwordPath);
  await passwords.clear();
  process.stdout.write("Lunkr 已保存密码已清除。\n");
} catch (error) {
  process.stderr.write(`清除 Lunkr 已保存密码失败：${safeError(error)}\n`);
  process.exitCode = 1;
}
