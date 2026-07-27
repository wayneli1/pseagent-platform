import { describe, expect, it, vi } from "vitest";
import type { LunkrSession } from "./contracts.js";
import { getLunkrSessionStatus } from "./status.js";

const session: LunkrSession = {
  email: "bot@example.test",
  selfUid: "#bot#U",
  deviceUuid: "device",
  sid: "sid",
  cookie: "Cim=cookie",
  createdAt: "2026-07-27T00:00:00.000Z",
  lastVerifiedAt: "2026-07-27T00:00:00.000Z",
};

describe("getLunkrSessionStatus", () => {
  it("reports an unconfigured non-secret status", async () => {
    await expect(getLunkrSessionStatus(
      { load: vi.fn(async () => undefined) },
      vi.fn(),
    )).resolves.toEqual({ configured: false, valid: false });
  });

  it("reports identity but never session secrets", async () => {
    const status = await getLunkrSessionStatus(
      { load: vi.fn(async () => session) },
      vi.fn(async () => true),
    );
    expect(status).toMatchObject({
      configured: true,
      valid: true,
      email: session.email,
      selfUid: session.selfUid,
    });
    expect(JSON.stringify(status)).not.toContain(session.sid);
    expect(JSON.stringify(status)).not.toContain(session.cookie);
  });
});
