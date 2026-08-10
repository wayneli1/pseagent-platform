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
  if (/(?:相比|较之)/u.test(leadingClause)) return [];
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
    .replace(/\s*的(?:优势|劣势|优劣|功能|能力|定位|架构|部署|依赖|适用场景|使用场景|适用边界)[\s\S]*$/u, "")
    .replace(/\s*(?:在|从).{0,120}(?:区别|差异|差别|对比|比较|不同)[\s\S]*$/u, "")
    .replace(/\s*(?:各自|分别|各).{0,80}(?:适合|适用|应用场景|使用场景)[\s\S]*$/u, "")
    .replace(/\s*的[^：:]{0,80}(?:区别|差异|差别|对比|比较|不同|异同|优劣)[\s\S]*$/u, "")
    .replace(/\s*(?:的)?(?:主要)?(?:功能|能力|定位|架构|部署|依赖|适用场景|使用场景)?(?:区别|差异|差别|对比|比较|不同|异同|优劣|情况)[\s\S]*$/u, "")
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
  const extractedSubjects = explicitComparisonSubjects(question);
  const subjectLabels = extractedSubjects.some(isMixedLanguageSubject)
    ? extractedSubjects.filter(hasStableComparisonIdentity)
      .map((label) => label.toLocaleLowerCase("zh-CN"))
    : [];
  const explicitLabels = [...new Set([
    ...subjectLabels,
    ...scenarioLabels,
    ...pairLabels,
  ])];
  if (explicitLabels.length < 2) return [];
  const normalizedAnswer = answer.toLocaleLowerCase("zh-CN");
  return explicitLabels.filter((label) => {
    return !comparisonIdentityMentioned(label, normalizedAnswer);
  });
}

function hasStableComparisonIdentity(subject: string): boolean {
  return comparisonIdentityParts(subject).length > 0;
}

function isMixedLanguageSubject(subject: string): boolean {
  return /[A-Za-z]/u.test(subject) && /\p{Script=Han}/u.test(subject);
}

function comparisonIdentityMentioned(subject: string, answer: string): boolean {
  const parts = comparisonIdentityParts(subject);
  if (parts.length === 0) return true;
  if (parts.length === 1) {
    const [part] = parts;
    if (part === undefined) return true;
    const asciiOnly = /^[a-z0-9._+-]+$/iu.test(part);
    const pattern = asciiOnly
      ? new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(part)}(?![A-Za-z0-9])`,
          "iu",
        )
      : new RegExp(escapeRegExp(part), "iu");
    return pattern.test(answer);
  }
  return new RegExp(
    parts.map(escapeRegExp).join("[\\s\\p{P}\\p{S}\\p{Script=Han}]{0,12}"),
    "iu",
  ).test(answer);
}

function comparisonIdentityParts(subject: string): string[] {
  const normalized = subject.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const asciiMatches = [...normalized.matchAll(/[a-z][a-z0-9._+-]*/giu)];
  if (asciiMatches.length > 0) {
    const last = asciiMatches.at(-1);
    const tailStart = (last?.index ?? 0) + (last?.[0].length ?? 0);
    const tail = normalized.slice(tailStart);
    return [
      ...asciiMatches.map((match) => match[0]),
      ...(tail.match(/[\p{Script=Han}]{2,12}/gu) ?? []),
    ];
  }
  const compact = normalized.replace(/[\s\p{P}\p{S}]+/gu, "");
  return compact.length >= 2 && compact.length <= 24 ? [compact] : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
