import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectProbeVariants } from "./probe-selection.js";

describe("selectProbeVariants", () => {
  const variants = ["original", "paraphrase"] as const;

  it("selects only the original by default", () => {
    assert.deepEqual(selectProbeVariants(variants, undefined, false), [
      { index: 0, value: "original" },
    ]);
  });

  it("selects both variants while preserving their stable indexes", () => {
    assert.deepEqual(selectProbeVariants(variants, undefined, true), [
      { index: 0, value: "original" },
      { index: 1, value: "paraphrase" },
    ]);
  });

  it("selects only the requested one-based variant", () => {
    assert.deepEqual(selectProbeVariants(variants, "2", false), [
      { index: 1, value: "paraphrase" },
    ]);
  });

  it("returns no probes for an invalid or unavailable variant", () => {
    assert.deepEqual(selectProbeVariants(variants, "0", true), []);
    assert.deepEqual(selectProbeVariants(variants, "3", true), []);
    assert.deepEqual(selectProbeVariants(variants, "second", true), []);
  });
});
