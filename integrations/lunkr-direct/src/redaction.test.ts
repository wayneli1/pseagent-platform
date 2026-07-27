import { describe, expect, it } from "vitest";
import { redact, safeError } from "./redaction.js";

describe("redaction", () => {
  it("redacts nested secret fields", () => {
    expect(redact({
      password: "test-password",
      nested: { sid: "secret-sid", cookie: "Cim=secret", value: "ok" },
    })).toEqual({
      password: "[REDACTED]",
      nested: { sid: "[REDACTED]", cookie: "[REDACTED]", value: "ok" },
    });
  });

  it("redacts credentials embedded in error messages", () => {
    const message = safeError(new Error("Authorization: Bearer-secret Cookie: Cim=secret"));
    expect(message).not.toContain("Bearer-secret");
    expect(message).not.toContain("Cim=secret");
  });
});
