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
 * Preserves the supported statements of a structurally incomplete collection
 * without presenting them as a complete ordered list. The caller must also
 * downgrade the requirement to partial coverage.
 */
export function normalizeBrokenCollectionForPartialAnswer(answer: string): string {
  if (collectionEnumerationIssue(answer) === undefined) return answer;
  const withoutDeclaredCount = answer.replace(
    /(?:具体)?[二三四五六七八九十2-9]\s*(?:步|项|点|条|类|种|个)(?:结构|流程|方法|清单|内容|规则|做法|操作|要点)?(?:为|如下)?\s*[：:]?/gu,
    "已确认内容：",
  );
  const bulletized = withoutDeclaredCount.replace(
    /(^|[\s:：；;！？!?。])(?:\d{1,3}\s*[.)、）]|[（(]\s*\d{1,3}\s*[）)]|[一二三四五六七八九十]是)\s*/gmu,
    "$1- ",
  ).trim();
  return `以下仅列出当前已由正式资料确认的部分，不代表完整清单：\n${bulletized}`;
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
  for (const items of explicitFrameworkCollections(documents)) {
    const covered = items.filter((item) =>
      item.alternatives.some((alternative) => normalizedAnswer.includes(alternative)));
    if (covered.length < 2) continue;
    const missing = items.filter((item) =>
      !item.alternatives.some((alternative) => normalizedAnswer.includes(alternative)))
      .map((item) => item.label);
    if (missing.length > 0) return missing;
  }
  return [];
}

export function usesExplicitFrameworkCollection(
  answer: string,
  documents: readonly { readonly content: string }[],
): boolean {
  const normalizedAnswer = normalizeFrameworkText(answer);
  return explicitFrameworkCollections(documents).some((items) =>
    items.filter((item) =>
      item.alternatives.some((alternative) => normalizedAnswer.includes(alternative)))
      .length >= 2);
}

export function missingDirectQueryOperationalConditions(
  answer: string,
  documents: readonly { readonly path?: string; readonly content: string }[],
): readonly string[] {
  const normalizedAnswer = normalizeFrameworkText(answer);
  const missing: string[] = [];
  for (const document of documents) {
    if (document.path !== undefined && !document.path.startsWith("wiki/queries/")) {
      continue;
    }
    for (const sentence of answerableDocumentBody(document.content).split(/[。；;\n]+/u)) {
      const condition = operationalCondition(sentence);
      if (condition === undefined || operationalConditionCovered(normalizedAnswer, condition)) {
        continue;
      }
      const label = sentence.trim();
      if (label && !missing.includes(label)) missing.push(label);
    }
  }
  return missing;
}

function operationalCondition(value: string): {
  readonly action: string;
  readonly object?: string;
  readonly tail: string;
} | undefined {
  if (!/(?:后|前|时|完成|生效).{0,24}(?:需要|需|必须|应当|应|才(?:能|会))/u.test(value)) {
    return undefined;
  }
  const tail = value.match(/(?:需要|需|必须|应当|应|才(?:能|会))(?<tail>[^。；;\n]{1,80})/u)
    ?.groups?.tail?.trim();
  if (tail === undefined) return undefined;
  if (/(?:完成|执行|做好|进行).{0,12}(?:以下|如下).{0,24}[：:]/u.test(tail)) {
    return undefined;
  }
  const action = tail.match(/(?:重新启动|重启|刷新|保存|启用|开启|关闭|配置|确认|校验|同步|安装|授权|登录|切换)/u)?.[0];
  if (action === undefined) return undefined;
  const object = tail.match(/[A-Za-z][A-Za-z0-9._+-]{2,}/u)?.[0]
    ?.toLocaleLowerCase("zh-CN");
  return { action, ...(object === undefined ? {} : { object }), tail };
}

function answerableDocumentBody(value: string): string {
  const normalized = value.replace(/^\uFEFF/u, "");
  if (!/^---\s*(?:\r?\n|$)/u.test(normalized)) return normalized;
  const closing = normalized.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u);
  return closing === null ? normalized : normalized.slice(closing[0].length);
}

function operationalConditionCovered(
  normalizedAnswer: string,
  condition: { readonly action: string; readonly object?: string; readonly tail: string },
): boolean {
  const normalizedAction = normalizeFrameworkText(condition.action);
  if (condition.object !== undefined) {
    const normalizedObject = escapeRegExp(condition.object);
    const action = escapeRegExp(normalizedAction);
    return new RegExp(
      `(?:${action}.{0,20}${normalizedObject}|${normalizedObject}.{0,20}${action})`,
      "u",
    ).test(normalizedAnswer);
  }
  const normalizedTail = normalizeFrameworkText(condition.tail);
  return normalizedAnswer.includes(normalizedAction) &&
    hasCommonSubstring(normalizedAnswer, normalizedTail, 4);
}

export function missingStrictFrameworkBoundaries(
  answer: string,
  documents: readonly { readonly content: string }[],
): readonly string[] {
  if (!usesExplicitFrameworkCollection(answer, documents)) return [];
  const normalizedAnswer = normalizeFrameworkText(answer);
  return strictFrameworkBoundaries(documents).filter((boundary) =>
    !strictFrameworkBoundaryCovered(normalizedAnswer, boundary));
}

export function missingRequestedEvidenceBoundaries(
  answer: string,
  documents: readonly { readonly content: string }[],
): readonly string[] {
  const normalizedAnswer = normalizeFrameworkText(answer);
  return requestedEvidenceBoundaries(documents).filter((boundary) =>
    !requestedEvidenceBoundaryCovered(normalizedAnswer, boundary));
}

const REQUESTED_EVIDENCE_BOUNDARY_PATTERN =
  /(?:缺少|未提供|未说明|没有).{0,100}(?:样本|统计|定义|基准|验证|证据|报告|范围|版本)|(?:待核实|不能|不得|不应|无法).{0,80}(?:承诺|宣称|指标|结论|标准|依据)/u;
const DEICTIC_EVIDENCE_BOUNDARY_PATTERN = /(?:这些|上述|该等)(?:数字|指标|结果|数据|宣称)/u;
const EVIDENCE_LIMITATION_DETAIL_PATTERN =
  /(?:样本规模|统计周期|准确率定义|指标定义|基准线|独立验证|待核实宣称)/u;
const NON_COMMITMENT_BOUNDARY_PATTERN =
  /(?:不能|不可|不应|不得|无法).{0,24}(?:通用|普遍|对外|产品|正式)?.{0,12}(?:承诺|宣称|指标|标准)|待核实宣称/u;

function requestedEvidenceBoundaryCovered(
  normalizedAnswer: string,
  boundary: string,
): boolean {
  const normalizedBoundary = normalizeFrameworkText(boundary);
  if (
    EVIDENCE_LIMITATION_DETAIL_PATTERN.test(normalizedBoundary) &&
    NON_COMMITMENT_BOUNDARY_PATTERN.test(normalizedBoundary)
  ) {
    return EVIDENCE_LIMITATION_DETAIL_PATTERN.test(normalizedAnswer) &&
      NON_COMMITMENT_BOUNDARY_PATTERN.test(normalizedAnswer);
  }
  return hasCommonSubstring(normalizedAnswer, normalizedBoundary, 6);
}

export function requestedEvidenceBoundaries(
  documents: readonly { readonly content: string }[],
): string[] {
  const boundaries: string[] = [];
  for (const document of documents) {
    const sentences = answerableDocumentBody(document.content)
      .replace(/\r?\n+/gu, "。")
      .split(/[。；;]+/u)
      .map((sentence) => sentence.replace(/^\s*[-*+]\s*/u, "").trim())
      .filter(Boolean);
    for (const [index, sentence] of sentences.entries()) {
      if (!REQUESTED_EVIDENCE_BOUNDARY_PATTERN.test(sentence)) continue;
      const previous = sentences[index - 1];
      const boundary = previous !== undefined &&
          DEICTIC_EVIDENCE_BOUNDARY_PATTERN.test(sentence) &&
          /\d/u.test(previous)
        ? `${previous}。${sentence}`
        : sentence;
      if (!boundaries.includes(boundary)) boundaries.push(boundary);
      if (boundaries.length >= 6) return boundaries;
    }
  }
  return boundaries;
}

const STRONG_EPISTEMIC_BOUNDARY_PATTERN =
  /(?:不足以|不能|无法).{0,32}(?:证明|确认)|未(?:提供|有).{0,24}(?:足够|充分)?证据.{0,20}(?:证明|确认)|(?:不得|不能|不应).{0,24}(?:据此|直接).{0,40}(?:生成|推断|承诺|认定|得出)/u;

function strictFrameworkBoundaryCovered(
  normalizedAnswer: string,
  boundary: string,
): boolean {
  if (STRONG_EPISTEMIC_BOUNDARY_PATTERN.test(boundary)) {
    return STRONG_EPISTEMIC_BOUNDARY_PATTERN.test(normalizedAnswer);
  }
  return hasCommonSubstring(
    normalizedAnswer,
    normalizeFrameworkText(boundary),
    4,
  );
}

export function strictFrameworkBoundaries(
  documents: readonly { readonly content: string }[],
): string[] {
  const boundaries: string[] = [];
  for (const document of documents) {
    if (explicitFrameworkCollections([document]).length === 0) continue;
    let boundaryLevel: number | undefined;
    for (const rawLine of document.content.split(/\r?\n/u)) {
      const heading = rawLine.match(/^(#{2,6})\s+(.+)$/u);
      if (heading !== null) {
        const level = heading[1]?.length ?? 6;
        const title = heading[2] ?? "";
        if (/(?:边界|风险|关键原则|注意事项)/u.test(title)) {
          boundaryLevel = level;
        } else if (boundaryLevel !== undefined && level <= boundaryLevel) {
          boundaryLevel = undefined;
        }
        continue;
      }
      if (boundaryLevel === undefined) continue;
      const bullet = rawLine.match(/^\s*[-*+]\s+(.+)$/u)?.[1]?.trim();
      if (
        bullet !== undefined &&
        /(?:必须|不能|不得|禁止|需(?:要)?|不应)/u.test(bullet) &&
        !boundaries.includes(bullet)
      ) {
        boundaries.push(bullet);
      }
    }
    for (const sentence of document.content.split(/[。；;\n]+/u)) {
      const boundary = sentence.trim();
      if (
        boundary !== "" &&
        STRONG_EPISTEMIC_BOUNDARY_PATTERN.test(boundary) &&
        !boundaries.includes(boundary)
      ) {
        boundaries.push(boundary);
      }
    }
  }
  return boundaries;
}

function hasCommonSubstring(left: string, right: string, length: number): boolean {
  if (left.length < length || right.length < length) return false;
  for (let index = 0; index <= right.length - length; index += 1) {
    if (left.includes(right.slice(index, index + length))) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function explicitFrameworkCollections(
  documents: readonly { readonly content: string }[],
): Array<Array<{ readonly label: string; readonly alternatives: string[] }>> {
  const collections: Array<Array<{
    readonly label: string;
    readonly alternatives: string[];
  }>> = [];
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
      if (items.length === expectedCount) collections.push(items);
    }
    for (const match of document.content.matchAll(
      /(?:包括|应同时检查|需要检查|需检查)(?<items>[^。；;\n]{4,400})[。；;]/gu,
    )) {
      const source = match.groups?.items ?? "";
      if (source.includes("**")) continue;
      const labels = source.split(/[、，,]|\s*(?:以及|和|及)\s*/u)
        .map((item) => item.trim())
        .filter(Boolean);
      if (
        labels.length < 3 ||
        labels.length > 12 ||
        labels.some((label) => label.length < 2 || label.length > 40)
      ) {
        continue;
      }
      collections.push(labels.map((label) => ({
        label,
        alternatives: [normalizeFrameworkText(label)],
      })));
    }
  }
  return collections;
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
