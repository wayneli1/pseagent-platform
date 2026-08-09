const FIRST_ORDERED_ITEM_PATTERN =
  /(?:^|[\s:：；;，,])(?:1\s*[.)、）]|[（(]\s*1\s*[）)]|一是)/mu;
const SECOND_ORDERED_ITEM_PATTERN =
  /(?:^|[\s:：；;，,])(?:2\s*[.)、）]|[（(]\s*2\s*[）)]|二是)/mu;
const COLLECTION_INTENT_PATTERN =
  /(?:以下|下列|如下|包括|分为|主要有|事项|步骤|要点|清单|多项|几项)/u;
const EXPLICIT_SINGLETON_PATTERN =
  /(?:唯一|仅有|只有)\s*(?:一|1)\s*(?:项|个)/u;

/**
 * Detects an answer that announces a collection, starts item one, and then
 * stops before item two. This is a structural truncation signal rather than a
 * domain-specific completeness rule.
 */
export function hasDanglingCollectionEnumeration(answer: string): boolean {
  const first = FIRST_ORDERED_ITEM_PATTERN.exec(answer);
  if (first === null || SECOND_ORDERED_ITEM_PATTERN.test(answer)) return false;
  const windowStart = Math.max(0, first.index - 160);
  const context = answer.slice(windowStart, first.index + first[0].length + 40);
  return COLLECTION_INTENT_PATTERN.test(context) &&
    !EXPLICIT_SINGLETON_PATTERN.test(context);
}
