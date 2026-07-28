export function selectProbeVariants<T>(
  variants: readonly T[],
  requestedVariant: string | undefined,
  includeParaphrases: boolean,
): Array<{ index: number; value: T }> {
  const entries = variants.map((value, index) => ({ index, value }));
  if (requestedVariant === undefined) {
    return includeParaphrases ? entries : entries.slice(0, 1);
  }
  if (!/^[1-9]\d*$/u.test(requestedVariant)) return [];
  const selected = entries[Number(requestedVariant) - 1];
  return selected === undefined ? [] : [selected];
}
