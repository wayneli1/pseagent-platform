const DIRECT_COMPARISON_QUESTION_PATTERN =
  /(?:对比|比较|相比|较之|区别|差(?:异|别)|不同|(?:各自|分别|各).{0,24}(?:适合|适用|应用场景|使用场景|优劣|限制)|\bvs\.?\b|\bversus\b)/iu;

export function isDirectComparisonQuestion(question: string): boolean {
  return DIRECT_COMPARISON_QUESTION_PATTERN.test(question);
}

/**
 * Extracts the two explicitly named sides of a comparison without relying on a
 * product dictionary. The result is intentionally bounded because later
 * conjunctions usually join requested dimensions rather than more products.
 */
export function explicitComparisonSubjects(question: string): string[] {
  const normalized = question.normalize("NFKC").trim();
  if (!isDirectComparisonQuestion(normalized)) return [];
  const leadingClause = normalized.split(/[：:]/u, 1)[0] ?? normalized;
  const match = leadingClause.match(
    /^(?<left>.+?)\s*(?:和|与|跟|及|以及|\bvs\.?\b|\bversus\b)\s*(?<right>.+)$/iu,
  );
  if (match?.groups === undefined) return [];
  const left = match.groups.left;
  const right = match.groups.right;
  if (left === undefined || right === undefined) return [];
  const subjects = [left, right]
    .map(cleanExplicitComparisonSubject)
    .filter((subject) => subject.length >= 2 && subject.length <= 64);
  if (subjects.length !== 2) return [];
  const unique = new Map(
    subjects.map((subject) => [subject.toLocaleLowerCase("zh-CN"), subject] as const),
  );
  return unique.size === 2 ? [...unique.values()] : [];
}

function cleanExplicitComparisonSubject(value: string): string {
  return value
    .replace(/^[\s"'“”‘’《》「」『』]+|[\s"'“”‘’《》「」『』]+$/gu, "")
    .replace(/^(?:请(?:帮我)?|麻烦(?:帮我)?|帮我|找一下|查一下|看一下|介绍一下|对比一下|比较一下)\s*/u, "")
    .replace(/\s*(?:在|从).{0,120}(?:区别|差异|对比|比较|不同)[\s\S]*$/u, "")
    .replace(/\s*(?:各自|分别|各).{0,80}(?:适合|适用|应用场景|使用场景)[\s\S]*$/u, "")
    .replace(/\s*的[^：:]{0,80}(?:区别|差异|对比|比较|不同|异同|优劣)[\s\S]*$/u, "")
    .replace(/\s*(?:的)?(?:主要)?(?:功能|能力|定位|架构|部署|依赖|适用场景|使用场景)?(?:区别|差异|对比|比较|不同|异同|优劣|情况)[\s\S]*$/u, "")
    .replace(/\s*(?:有|是)?(?:什么|哪些|怎样|怎么)?$/u, "")
    .replace(/^[\s"'“”‘’《》「」『』]+|[\s"'“”‘’《》「」『』，。；;!?！？]+$/gu, "")
    .trim();
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
