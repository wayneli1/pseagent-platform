import { describe, expect, it } from "vitest";
import {
  countExpectationMismatches,
  hasStabilityFailure,
} from "./probe-stability-contract.js";

describe("probe stability contract", () => {
  it("counts configured scope and status mismatches", () => {
    expect(countExpectationMismatches([
      {
        expectedScope: "professional",
        scopeMatches: false,
        expectedStatus: "answered",
        statusMatches: false,
      },
      {
        expectedScope: "professional",
        scopeMatches: true,
        expectedStatus: "answered",
        statusMatches: true,
      },
    ])).toEqual({ scopeMismatches: 1, statusMismatches: 1 });
  });

  it("ignores expectations that were not configured", () => {
    expect(countExpectationMismatches([{}])).toEqual({
      scopeMismatches: 0,
      statusMismatches: 0,
    });
  });

  it("fails for an expectation mismatch as well as runtime failures", () => {
    expect(hasStabilityFailure({
      unavailable: 0,
      failures: 0,
      scopeMismatches: 0,
      statusMismatches: 1,
    })).toBe(true);
    expect(hasStabilityFailure({
      unavailable: 0,
      failures: 0,
      scopeMismatches: 0,
      statusMismatches: 0,
    })).toBe(false);
  });
});
