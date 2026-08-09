const ORDERED_ITEM_PATTERN =
  /(?:^|[\s:：；;，,])(?:(\d{1,3})\s*[.)、）]|[（(]\s*(\d{1,3})\s*[）)]|([一二三四五六七八九十])是)/gmu;
const COLLECTION_INTENT_PATTERN =
  /(?:以下|下列|如下|包括|分为|主要有|事项|步骤|要点|规则|清单|检查(?:项|内容)?|多项|几项)/u;
const EXPLICIT_SINGLETON_PATTERN =
  /(?:唯一|仅有|只有)\s*(?:一|1)\s*(?:项|个)/u;
const DECLARED_COLLECTION_COUNT_PATTERN =
  /([二三四五六七八九十2-9])\s*(?:步|项|点|条|类|种|个)(?:结构|流程|方法|清单|内容|规则|做法|操作|要点)?/gu;

/**
 * Detects an answer that announces a collection but either stops after item
 * one or skips an ordinal. This is a structural truncation signal rather than
 * a domain-specific completeness rule.
 */
export function collectionEnumerationIssue(
  answer: string,
):
  | "dangling_first_item"
  | "non_contiguous_ordinals"
  | "declared_count_incomplete"
  | undefined {
  const items = [...answer.matchAll(ORDERED_ITEM_PATTERN)].map((match) => ({
    index: match.index,
    value: orderedItemValue(match),
  }));
  for (let start = 0; start < items.length; start += 1) {
    const first = items[start]!;
    if (first.value !== 1) continue;
    const windowStart = Math.max(0, first.index - 160);
    const context = answer.slice(windowStart, first.index + 80);
    const declaredCount = declaredCollectionCount(context);
    if (!COLLECTION_INTENT_PATTERN.test(context) && declaredCount === undefined) continue;

    let previous = 1;
    for (let cursor = start + 1; cursor < items.length; cursor += 1) {
      const next = items[cursor]!;
      if (next.value === 1) break;
      if (next.value > previous + 1) return "non_contiguous_ordinals";
      if (next.value === previous + 1) previous = next.value;
    }
    if (declaredCount !== undefined && previous < declaredCount) {
      return "declared_count_incomplete";
    }
    if (previous === 1 && !EXPLICIT_SINGLETON_PATTERN.test(context)) {
      return "dangling_first_item";
    }
  }
  return undefined;
}

function declaredCollectionCount(value: string): number | undefined {
  let result: number | undefined;
  for (const match of value.matchAll(DECLARED_COLLECTION_COUNT_PATTERN)) {
    result = collectionCountValue(match[1] ?? "");
  }
  return result;
}

function collectionCountValue(value: string): number | undefined {
  if (/^[2-9]$/u.test(value)) return Number(value);
  return ({
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  } as const)[value as "二" | "三" | "四" | "五" | "六" | "七" | "八" | "九" | "十"];
}

export function hasBrokenCollectionEnumeration(answer: string): boolean {
  return collectionEnumerationIssue(answer) !== undefined;
}

/**
 * Finds a missing sibling in a formally defined framework collection. The
 * guard only activates after the answer already uses at least two members, so
 * a narrow question about one component does not expand into the whole page.
 */
export function missingExplicitFrameworkItems(
  answer: string,
  documents: readonly { readonly content: string }[],
): readonly string[] {
  const normalizedAnswer = normalizeFrameworkText(answer);
  for (const document of documents) {
    for (const match of document.content.matchAll(
      /(?:包括|由)(?<items>[^。\n]{1,800}?)(?<count>[二三四五六七八九十2-9])\s*(?:个|项|种)(?:相互配合的|相互协同的|协同的|核心的)?\s*(?:方法|部分|组件|要素|阶段|维度|原则|步骤)(?:[。；;]|$)/gu,
    )) {
      const expectedCount = collectionCountValue(match.groups?.count ?? "");
      if (expectedCount === undefined) continue;
      const items = [...(match.groups?.items ?? "").matchAll(
        /\*\*([^*\n]{2,100})\*\*(?:[（(]([^）)\n]{1,100})[）)])?/gu,
      )].map((item) => ({
        label: item[1]?.trim() ?? "",
        alternatives: [item[1] ?? "", item[2] ?? ""]
          .map(normalizeFrameworkText)
          .filter(Boolean),
      }));
      if (items.length !== expectedCount) continue;
      const covered = items.filter((item) =>
        item.alternatives.some((alternative) => normalizedAnswer.includes(alternative)));
      if (covered.length < 2) continue;
      const missing = items.filter((item) =>
        !item.alternatives.some((alternative) => normalizedAnswer.includes(alternative)))
        .map((item) => item.label);
      if (missing.length > 0) return missing;
    }
  }
  return [];
}

function normalizeFrameworkText(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function firstOrderedItemValue(answer: string): number | undefined {
  const first = answer.matchAll(ORDERED_ITEM_PATTERN).next().value as
    | RegExpMatchArray
    | undefined;
  return first === undefined ? undefined : orderedItemValue(first);
}

export function verifierOrphanedOrderedSequence(
  draftAnswer: string,
  verifiedAnswer: string,
): boolean {
  return firstOrderedItemValue(draftAnswer) === 1 &&
    (firstOrderedItemValue(verifiedAnswer) ?? 1) > 1;
}

function orderedItemValue(match: RegExpMatchArray): number {
  const numeric = match[1] ?? match[2];
  if (numeric !== undefined) return Number(numeric);
  return ({
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  } as const)[match[3] as "一" | "二" | "三" | "四" | "五" | "六" | "七" | "八" | "九" | "十"];
}
