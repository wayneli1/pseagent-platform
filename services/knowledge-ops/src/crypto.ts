import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedPayload } from "./types.js";

export class ContentCipher {
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(
    private readonly key: Buffer,
    private readonly keyVersion = 1,
    decryptionKeys?: ReadonlyMap<number, Buffer>,
  ) {
    if (key.length !== 32 || !Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
      throw new Error("content_cipher_configuration_invalid");
    }
    const keys = new Map(decryptionKeys ?? [[keyVersion, key]]);
    keys.set(keyVersion, key);
    for (const [version, candidate] of keys) {
      if (!Number.isSafeInteger(version) || version <= 0 || candidate.length !== 32) {
        throw new Error("content_cipher_configuration_invalid");
      }
    }
    this.keys = keys;
  }

  static fromBase64(encodedKey: string, keyVersion = 1): ContentCipher {
    const key = Buffer.from(encodedKey, "base64");
    return new ContentCipher(key, keyVersion);
  }

  static fromBase64Keyring(
    encodedKeys: Readonly<Record<string, string>>,
    currentKeyVersion: number,
  ): ContentCipher {
    const keys = new Map<number, Buffer>();
    for (const [rawVersion, encodedKey] of Object.entries(encodedKeys)) {
      const version = Number(rawVersion);
      keys.set(version, Buffer.from(encodedKey, "base64"));
    }
    const current = keys.get(currentKeyVersion);
    if (current === undefined) throw new Error("content_cipher_current_key_missing");
    return new ContentCipher(current, currentKeyVersion, keys);
  }

  encrypt(value: unknown): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      keyVersion: this.keyVersion,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  decrypt<T>(payload: EncryptedPayload): T {
    if (
      payload.algorithm !== "aes-256-gcm"
    ) {
      throw new Error("content_cipher_key_version_mismatch");
    }
    const key = this.keys.get(payload.keyVersion);
    if (key === undefined) throw new Error("content_cipher_key_version_mismatch");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.data, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
      throw new Error("content_cipher_decryption_failed");
    }
  }
}
