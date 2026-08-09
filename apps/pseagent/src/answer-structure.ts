const ORDERED_ITEM_PATTERN =
  /(?:^|[\s:：；;，,])(?:(\d{1,3})\s*[.)、）]|[（(]\s*(\d{1,3})\s*[）)]|([一二三四五六七八九十])是)/gmu;
const COLLECTION_INTENT_PATTERN =
  /(?:以下|下列|如下|包括|分为|主要有|事项|步骤|要点|清单|多项|几项)/u;
const EXPLICIT_SINGLETON_PATTERN =
  /(?:唯一|仅有|只有)\s*(?:一|1)\s*(?:项|个)/u;

/**
 * Detects an answer that announces a collection but either stops after item
 * one or skips an ordinal. This is a structural truncation signal rather than
 * a domain-specific completeness rule.
 */
export function collectionEnumerationIssue(
  answer: string,
): "dangling_first_item" | "non_contiguous_ordinals" | undefined {
  const items = [...answer.matchAll(ORDERED_ITEM_PATTERN)].map((match) => ({
    index: match.index,
    value: orderedItemValue(match),
  }));
  for (let start = 0; start < items.length; start += 1) {
    const first = items[start]!;
    if (first.value !== 1) continue;
    const windowStart = Math.max(0, first.index - 160);
    const context = answer.slice(windowStart, first.index + 80);
    if (!COLLECTION_INTENT_PATTERN.test(context)) continue;

    let previous = 1;
    for (let cursor = start + 1; cursor < items.length; cursor += 1) {
      const next = items[cursor]!;
      if (next.value === 1) break;
      if (next.value > previous + 1) return "non_contiguous_ordinals";
      if (next.value === previous + 1) previous = next.value;
    }
    if (previous === 1 && !EXPLICIT_SINGLETON_PATTERN.test(context)) {
      return "dangling_first_item";
    }
  }
  return undefined;
}

export function hasBrokenCollectionEnumeration(answer: string): boolean {
  return collectionEnumerationIssue(answer) !== undefined;
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
