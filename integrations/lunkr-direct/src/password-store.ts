import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredPasswordCredential {
  readonly email: string;
  readonly password: string;
}

export interface PasswordProtector {
  protect(plaintext: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

interface StoredPasswordFile {
  readonly version: 1;
  readonly email: string;
  readonly protectedPassword: string;
  readonly createdAt: string;
}

const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$plain=[Console]::In.ReadToEnd()",
  "$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force",
  "$cipher=ConvertFrom-SecureString -SecureString $secure",
  "[Console]::Out.Write($cipher)",
].join(";");

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$cipher=[Console]::In.ReadToEnd()",
  "$secure=ConvertTo-SecureString -String $cipher",
  "$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
  "try{$plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);[Console]::Out.Write($plain)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}",
].join(";");

export class WindowsDpapiProtector implements PasswordProtector {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runPowerShell: (
      script: string,
      input: string,
    ) => Promise<string> = invokePowerShell,
  ) {}

  async protect(plaintext: string): Promise<string> {
    this.requireWindows();
    if (plaintext.length === 0) throw new Error("不能保存空密码");
    const ciphertext = await this.runPowerShell(PROTECT_SCRIPT, plaintext);
    if (ciphertext.length === 0) throw new Error("Windows 密码加密失败");
    return ciphertext;
  }

  async unprotect(ciphertext: string): Promise<string> {
    this.requireWindows();
    if (ciphertext.length === 0) throw new Error("Windows 密码密文为空");
    return this.runPowerShell(UNPROTECT_SCRIPT, ciphertext);
  }

  private requireWindows(): void {
    if (this.platform !== "win32") {
      throw new Error("Lunkr 密码保存仅支持 Windows DPAPI");
    }
  }
}

export class DpapiPasswordStore {
  constructor(
    readonly path: string,
    private readonly protector: PasswordProtector =
      new WindowsDpapiProtector(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(emailInput: string, password: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const protectedPassword = await this.protector.protect(password);
    const stored: StoredPasswordFile = {
      version: 1,
      email,
      protectedPassword,
      createdAt: this.now().toISOString(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(stored, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.path);
  }

  async load(): Promise<StoredPasswordCredential | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const stored = parseStoredPassword(raw);
    const password = await this.protector.unprotect(
      stored.protectedPassword,
    );
    if (password.length === 0) throw new Error("Windows 密码解密结果为空");
    return { email: stored.email, password };
  }

  async isConfigured(): Promise<boolean> {
    try {
      parseStoredPassword(await readFile(this.path, "utf8"));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function parseStoredPassword(raw: string): StoredPasswordFile {
  const value = JSON.parse(raw) as Partial<StoredPasswordFile>;
  if (
    value.version !== 1 ||
    typeof value.email !== "string" ||
    value.email.length === 0 ||
    typeof value.protectedPassword !== "string" ||
    value.protectedPassword.length === 0 ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Lunkr 密码存储文件格式无效");
  }
  return value as StoredPasswordFile;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/u.test(email)) {
    throw new Error("Lunkr 密码存储邮箱无效");
  }
  return email;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function invokePowerShell(
  script: string,
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let outputExceeded = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows 密码保护操作超时"));
    }, 30_000);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 65_536) {
        outputExceeded = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("无法启动 Windows 密码保护服务"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (outputExceeded) {
        reject(new Error("Windows 密码保护输出异常"));
      } else if (code !== 0) {
        reject(new Error("Windows 密码保护操作失败"));
      } else {
        resolve(stdout);
      }
    });
    child.stdin.end(input, "utf8");
  });
}
