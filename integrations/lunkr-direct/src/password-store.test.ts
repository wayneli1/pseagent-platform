import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DpapiPasswordStore,
  WindowsDpapiProtector,
  type PasswordProtector,
} from "./password-store.js";

const directories: string[] = [];
const fakeProtector: PasswordProtector = {
  protect: async (value) =>
    `protected:${Buffer.from(value, "utf8").toString("base64")}`,
  unprotect: async (value) =>
    Buffer.from(value.slice("protected:".length), "base64").toString("utf8"),
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("DpapiPasswordStore", () => {
  it("round-trips through its protector without plaintext disk leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pseagent-password-"));
    directories.push(directory);
    const path = join(directory, "password.dpapi.json");
    const store = new DpapiPasswordStore(
      path,
      fakeProtector,
      () => new Date("2026-07-31T00:00:00.000Z"),
    );

    await store.save("Bot@Example.Test", "private-password");

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("private-password");
    expect(raw).toContain("bot@example.test");
    await expect(store.isConfigured()).resolves.toBe(true);
    await expect(store.load()).resolves.toEqual({
      email: "bot@example.test",
      password: "private-password",
    });
  });

  it("clears a stored password without affecting a missing store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pseagent-password-"));
    directories.push(directory);
    const store = new DpapiPasswordStore(
      join(directory, "password.dpapi.json"),
      fakeProtector,
    );

    await store.save("bot@example.test", "password");
    await store.clear();
    await store.clear();

    await expect(store.isConfigured()).resolves.toBe(false);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("rejects unsupported platforms before invoking a protector process", async () => {
    const protector = new WindowsDpapiProtector(
      "linux",
      async () => "unexpected",
    );

    await expect(protector.protect("password")).rejects.toThrow(
      "仅支持 Windows DPAPI",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "uses Windows DPAPI for an exact local-user round trip",
    async () => {
      const protector = new WindowsDpapiProtector();
      const password = "复杂 P@ssword !  ";
      const ciphertext = await protector.protect(password);

      expect(ciphertext).not.toContain(password);
      await expect(protector.unprotect(ciphertext)).resolves.toBe(password);
    },
    30_000,
  );
});
