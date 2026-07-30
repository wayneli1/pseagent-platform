export function assertMinimumReferenceCount(
  actual: number,
  minimum: number | undefined,
): void {
  if (minimum !== undefined && actual < minimum) {
    throw new Error("insufficient_reference_count");
  }
}
