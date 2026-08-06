const DIRECT_COMPARISON_QUESTION_PATTERN =
  /(?:对比|比较|相比|较之|区别|差(?:异|别)|不同|(?:各自|分别|各).{0,24}(?:适合|适用|应用场景|使用场景|优劣|限制)|\bvs\.?\b|\bversus\b)/iu;

export function isDirectComparisonQuestion(question: string): boolean {
  return DIRECT_COMPARISON_QUESTION_PATTERN.test(question);
}

export function missingExplicitComparisonLabels(
  question: string,
  answer: string,
): string[] {
  const choicePrefix = question.match(
    /^(.*?)(?:(?:各自|分别|各).{0,16}(?:适合|适用|应用场景|使用场景))/u,
  )?.[1];
  const scenarioLabels = choicePrefix === undefined
    ? []
    : (choicePrefix.match(/[A-Za-z][A-Za-z0-9._+-]*/gu) ?? [])
      .filter((label) => !/^(?:vs|versus)$/iu.test(label))
      .map((label) => label.toLocaleLowerCase("zh-CN"));
  const pairLabels = [...question.matchAll(
    /(?<left>[A-Za-z][A-Za-z0-9._+-]*)\s*(?:和|与|及|\bvs\.?\b|\bversus\b)\s*(?<right>[A-Za-z][A-Za-z0-9._+-]*)(?=.{0,120}(?:区别|差(?:异|别)|对比|比较|不同|各自|分别|各))/giu,
  )].flatMap((match) => [
    match.groups?.left ?? "",
    match.groups?.right ?? "",
  ]).filter(Boolean).map((label) => label.toLocaleLowerCase("zh-CN"));
  const explicitLabels = [...new Set([...scenarioLabels, ...pairLabels])];
  if (explicitLabels.length < 2) return [];
  const normalizedAnswer = answer.toLocaleLowerCase("zh-CN");
  return explicitLabels.filter((label) => {
    const pattern = label.length === 1
      ? new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(label)}(?![A-Za-z0-9])`,
          "iu",
        )
      : new RegExp(escapeRegExp(label), "iu");
    return !pattern.test(normalizedAnswer);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
