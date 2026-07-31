import { describe, expect, it, vi } from "vitest";
import type { LunkrSession } from "./contracts.js";
import {
  LunkrLoginRequiredError,
  ensureLunkrSession,
} from "./session-bootstrap.js";

const session: LunkrSession = {
  email: "bot@example.test",
  selfUid: "#bot#U",
  deviceUuid: "device-1",
  sid: "private-sid",
  cookie: "Cim=private-cookie",
  createdAt: "2026-07-31T00:00:00.000Z",
  lastVerifiedAt: "2026-07-31T00:00:00.000Z",
};

describe("ensureLunkrSession", () => {
  it("uses a valid session without loading a stored password", async () => {
    const loadPassword = vi.fn();
    const login = vi.fn();

    await expect(ensureLunkrSession({
      sessions: { load: vi.fn(async () => session) },
      passwords: { load: loadPassword },
      auth: {
        verify: vi.fn(async () => true),
        login,
      },
    })).resolves.toEqual({
      session,
      renewedWithStoredPassword: false,
    });
    expect(loadPassword).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("renews an invalid session with the DPAPI-stored password", async () => {
    const renewed = {
      ...session,
      sid: "renewed-sid",
      cookie: "Cim=renewed-cookie",
    };
    const login = vi.fn(async () => renewed);

    await expect(ensureLunkrSession({
      sessions: { load: vi.fn(async () => session) },
      passwords: {
        load: vi.fn(async () => ({
          email: session.email,
          password: "stored-password",
        })),
      },
      auth: {
        verify: vi.fn(async () => false),
        login,
      },
    })).resolves.toEqual({
      session: renewed,
      renewedWithStoredPassword: true,
    });
    expect(login).toHaveBeenCalledWith({
      email: session.email,
      password: "stored-password",
    });
  });

  it("requires interactive login when no password was stored", async () => {
    await expect(ensureLunkrSession({
      sessions: { load: vi.fn(async () => session) },
      passwords: { load: vi.fn(async () => undefined) },
      auth: {
        verify: vi.fn(async () => false),
        login: vi.fn(),
      },
    })).rejects.toMatchObject({
      name: "LunkrLoginRequiredError",
      reason: "invalid_session",
    } satisfies Partial<LunkrLoginRequiredError>);
  });

  it("does not switch accounts using a stale stored password", async () => {
    await expect(ensureLunkrSession({
      sessions: { load: vi.fn(async () => session) },
      passwords: {
        load: vi.fn(async () => ({
          email: "other@example.test",
          password: "stored-password",
        })),
      },
      auth: {
        verify: vi.fn(async () => false),
        login: vi.fn(),
      },
    })).rejects.toMatchObject({
      reason: "stored_account_mismatch",
    });
  });
});
