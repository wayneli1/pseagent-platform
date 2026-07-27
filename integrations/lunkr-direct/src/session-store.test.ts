import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LunkrSession } from "./contracts.js";
import { SessionStore } from "./session-store.js";

const directories: string[] = [];
const identity = { hostname: "test-host", username: "test-user" };
const session: LunkrSession = {
  email: "bot@example.test",
  selfUid: "#bot#U",
  deviceUuid: "device-1",
  sid: "private-sid",
  cookie: "Cim=private-cookie",
  createdAt: "2026-07-27T00:00:00.000Z",
  lastVerifiedAt: "2026-07-27T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("SessionStore", () => {
  it("round-trips encrypted session secrets without plaintext leakage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pseagent-lunkr-"));
    directories.push(directory);
    const path = join(directory, "session.json");
    const store = new SessionStore(path, identity);
    await store.save(session);

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain(session.sid);
    expect(raw).not.toContain(session.cookie);
    await expect(store.load()).resolves.toEqual(session);
  });

  it("rejects decryption under another Windows identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pseagent-lunkr-"));
    directories.push(directory);
    const path = join(directory, "session.json");
    await new SessionStore(path, identity).save(session);

    await expect(new SessionStore(path, {
      hostname: "another-host",
      username: "another-user",
    }).load()).rejects.toThrow("无法在当前 Windows 用户和设备上解密");
  });

  it("returns undefined when no session exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pseagent-lunkr-"));
    directories.push(directory);
    await expect(new SessionStore(join(directory, "missing.json"), identity).load())
      .resolves.toBeUndefined();
  });
});
