export interface StabilityExpectationRecord {
  readonly expectedScope?: string;
  readonly expectedStatus?: string;
  readonly scopeMatches?: boolean;
  readonly statusMatches?: boolean;
}

export interface StabilityVerdict {
  readonly unavailable: number;
  readonly failures: number;
  readonly scopeMismatches: number;
  readonly statusMismatches: number;
}

export function countExpectationMismatches(
  records: readonly StabilityExpectationRecord[],
): Pick<StabilityVerdict, "scopeMismatches" | "statusMismatches"> {
  return {
    scopeMismatches: records.filter((record) =>
      record.expectedScope !== undefined && record.scopeMatches !== true
    ).length,
    statusMismatches: records.filter((record) =>
      record.expectedStatus !== undefined && record.statusMatches !== true
    ).length,
  };
}

export function hasStabilityFailure(verdict: StabilityVerdict): boolean {
  return verdict.unavailable > 0 ||
    verdict.failures > 0 ||
    verdict.scopeMismatches > 0 ||
    verdict.statusMismatches > 0;
}
