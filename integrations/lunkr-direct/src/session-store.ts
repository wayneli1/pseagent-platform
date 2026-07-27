import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname } from "node:path";
import type {
  EncryptedValue,
  LunkrSession,
  StoredLunkrSession,
} from "./contracts.js";

export interface MachineIdentity {
  readonly hostname: string;
  readonly username: string;
}

export class SessionStore {
  constructor(
    readonly path: string,
    private readonly identity: MachineIdentity = {
      hostname: hostname(),
      username: userInfo().username,
    },
  ) {}

  async save(session: LunkrSession): Promise<void> {
    const stored: StoredLunkrSession = {
      version: 1,
      email: session.email,
      selfUid: session.selfUid,
      deviceUuid: session.deviceUuid,
      secrets: encryptSecrets(
        JSON.stringify({ sid: session.sid, cookie: session.cookie }),
        deriveKey(session.deviceUuid, this.identity),
      ),
      createdAt: session.createdAt,
      lastVerifiedAt: session.lastVerifiedAt,
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }

  async load(): Promise<LunkrSession | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const stored = parseStoredSession(raw);
    const plaintext = decryptSecrets(
      stored.secrets,
      deriveKey(stored.deviceUuid, this.identity),
    );
    const secrets = JSON.parse(plaintext) as { sid?: unknown; cookie?: unknown };
    if (typeof secrets.sid !== "string" || typeof secrets.cookie !== "string") {
      throw new Error("Lunkr Session 密文内容无效");
    }
    return {
      email: stored.email,
      selfUid: stored.selfUid,
      deviceUuid: stored.deviceUuid,
      sid: secrets.sid,
      cookie: secrets.cookie,
      createdAt: stored.createdAt,
      lastVerifiedAt: stored.lastVerifiedAt,
    };
  }
}

function deriveKey(deviceUuid: string, identity: MachineIdentity): Buffer {
  return createHash("sha256")
    .update(`pseagent-lunkr-key:${deviceUuid}:${identity.hostname}:${identity.username}`)
    .digest();
}

function encryptSecrets(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptSecrets(value: EncryptedValue, key: Buffer): string {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(value.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("无法在当前 Windows 用户和设备上解密 Lunkr Session");
  }
}

function parseStoredSession(raw: string): StoredLunkrSession {
  const value = JSON.parse(raw) as Partial<StoredLunkrSession>;
  if (
    value.version !== 1 ||
    typeof value.email !== "string" ||
    typeof value.selfUid !== "string" ||
    typeof value.deviceUuid !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastVerifiedAt !== "string" ||
    value.secrets?.algorithm !== "aes-256-gcm" ||
    typeof value.secrets.iv !== "string" ||
    typeof value.secrets.tag !== "string" ||
    typeof value.secrets.data !== "string"
  ) {
    throw new Error("Lunkr Session 文件格式无效");
  }
  return value as StoredLunkrSession;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
