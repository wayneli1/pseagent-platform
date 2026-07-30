import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertMinimumReferenceCount } from "./probe-live-contract.js";

describe("assertMinimumReferenceCount", () => {
  it("rejects a real probe below its configured formal reference minimum", () => {
    expect(() => assertMinimumReferenceCount(3, 4))
      .toThrowError("insufficient_reference_count");
  });

  it("accepts an omitted or satisfied minimum", () => {
    expect(() => assertMinimumReferenceCount(0, undefined)).not.toThrow();
    expect(() => assertMinimumReferenceCount(4, 4)).not.toThrow();
  });

  it("keeps the process alive until the real probe settles", () => {
    const source = readFileSync(
      new URL("./probe-live.mts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/\nawait probe\(\)\.catch\(/u);
    expect(source).toContain("const keepAlive = setInterval");
    expect(source).toContain("clearInterval(keepAlive)");
  });
});
