export type SourceIntentKind =
  | "protected_fact"
  | "synthesis"
  | "relationship_support"
  | "unresolved";

export type SourceIntentReason =
  | "explicit_synthesis_scope"
  | "relationship_support"
  | "protected_occurrence"
  | "default_fact"
  | "context_premise"
  | "governed_object"
  | "ambiguous_structure"
  | "blank_source";

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface SourceOccurrence extends SourceSpan {
  readonly text: string;
  readonly kind:
    | "numeric_fact"
    | "technical_support"
    | "explicit_fact_request"
    | "state_fact"
    | "quantified_fact"
    | "synthesis_governor"
    | "relationship_support"
    | "unresolved";
}

export interface SourceIntentAtom extends SourceSpan {
  readonly nodeType: "atom";
  readonly text: string;
  readonly kind: SourceIntentKind;
  readonly reason: SourceIntentReason;
  readonly occurrences: readonly SourceOccurrence[];
}

export type SourceBoundaryKind =
  | "whitespace"
  | "punctuation"
  | "connector"
  | "sequence"
  | "open_delimiter"
  | "close_delimiter"
  | "structural";

export interface SourceBoundarySpan extends SourceSpan {
  readonly nodeType: "boundary";
  readonly text: string;
  readonly kind: "boundary";
  readonly boundaryKind: SourceBoundaryKind;
}

export type SourceSegment = SourceIntentAtom | SourceBoundarySpan;

export interface SourceToken extends SourceSpan {
  readonly text: string;
  readonly kind: "text" | "boundary";
  readonly boundaryKind?: SourceBoundaryKind;
  readonly depth: number;
}

export interface SourceConstituent extends SourceSpan {
  readonly nodeType: "constituent";
  readonly text: string;
  readonly kind: SourceIntentKind | "boundary";
  readonly occurrences: readonly SourceOccurrence[];
  readonly children: readonly SourceToken[];
}

export interface ObligationSemanticAnalysis {
  readonly sourceSpan: SourceSpan;
  readonly tokens: readonly SourceToken[];
  readonly segments: readonly SourceSegment[];
  readonly boundaries: readonly SourceBoundarySpan[];
  readonly constituents: readonly SourceConstituent[];
  readonly atoms: readonly SourceIntentAtom[];
  readonly requiresDirectEvidence: boolean;
  readonly unresolved: boolean;
  readonly customerInputEligible: boolean;
  readonly diagnostics: {
    readonly rangeEvaluations: number;
    readonly cacheHits: number;
  };
}

export interface WordBoundaryCandidate extends SourceSpan {
  readonly text: string;
}

export type WordBoundaryCandidateProvider = (
  sourceText: string,
) => readonly WordBoundaryCandidate[] | undefined;

interface InternalToken {
  text: string;
  start: number;
  end: number;
  kind: "text" | "boundary";
  boundaryKind?: SourceBoundaryKind;
  depth: number;
}

interface Tokenization {
  readonly tokens: readonly InternalToken[];
  readonly balanced: boolean;
  readonly matchingDelimiters: ReadonlyMap<number, number>;
  readonly candidateWords: readonly WordBoundaryCandidate[] | undefined;
  readonly reliable: boolean;
}

interface AnalyzerContext {
  readonly sourceText: string;
  readonly sourceSpan: SourceSpan;
  readonly tokenization: Tokenization;
  readonly parseCache: Map<string, readonly SourceIntentAtom[]>;
  readonly diagnostics: {
    rangeEvaluations: number;
    cacheHits: number;
  };
}

type PreviewKind = SourceIntentKind | "nominal";
type IncompleteGovernorKind = "diagnostic" | "procedure" | "output";

const HARD_PUNCTUATION = new Map<string, SourceBoundaryKind>([
  ["\r\n", "punctuation"],
  ["\n", "punctuation"],
  ["\r", "punctuation"],
  ["，", "punctuation"],
  [",", "punctuation"],
  ["；", "punctuation"],
  [";", "punctuation"],
  ["。", "punctuation"],
  ["、", "punctuation"],
  ["：", "punctuation"],
  [":", "punctuation"],
  ["！", "punctuation"],
  ["!", "punctuation"],
  ["？", "punctuation"],
  ["?", "punctuation"],
]);
const ORDERED_HARD_PUNCTUATION = [...HARD_PUNCTUATION.keys()]
  .sort((left, right) => right.length - left.length);

const STRONG_CONNECTORS = new Set([
  "并且",
  "同时",
  "然后",
  "随后",
  "继而",
  "还有",
  "以及",
]);

const SEQUENCE_CONNECTORS = new Set([
  "之后",
  "以后",
  "接着",
  "后",
  "再",
  "又要",
]);

const WEAK_CONNECTORS = new Set(["和", "及", "与", "跟", "并"]);
const ALL_WORD_BOUNDARIES = new Set([
  ...STRONG_CONNECTORS,
  ...SEQUENCE_CONNECTORS,
  ...WEAK_CONNECTORS,
]);

const OPEN_TO_CLOSE = new Map<string, string>([
  ["（", "）"],
  ["(", ")"],
  ["“", "”"],
  ["‘", "’"],
]);
const CLOSE_TO_OPEN = new Map([...OPEN_TO_CLOSE].map(([open, close]) => [close, open]));

const SYNTHESIS_NOMINAL_HEAD =
  /(?:操作指引|实施路径|处置路径|工作计划|路线图|诊断方法|风险评估|差距分析|瓶颈诊断|建议|方案|行动|计划|规划|路径|策略|措施|步骤|流程|方法|做法|思路|原因|根因|评估|分析|诊断|识别|澄清|借鉴|类比|取舍)(?:有哪些|是什么|如何|吗|呢|吧)?$/u;

const SYNTHESIS_SPEECH_ACT = /^(?:评估|分析|诊断|预测|判断|比较|对比)\S+/u;
const SYNTHESIS_OUTPUT_GOVERNOR = /^(?:给出|提出|制定|输出|形成|提供)/u;
const SYNTHESIS_OUTPUT_OCCURRENCE = /(?:给出|提出|制定|输出|形成|提供)/u;
const SYNTHESIS_CHANGE_WORD =
  /^(?:提升|优化|改造|升级|扩容|适配|迁移|调整|实施|处置)$/u;
const SYNTHESIS_CHANGE_GOVERNOR =
  /^(?:(?:如何|怎样|怎么)\s*)?(?:提升|优化|改造|升级|扩容|适配|迁移|调整|实施|处置)\S*|^.+(?:如何|怎样|怎么|需要|应当|应该)(?:提升|优化|改造|升级|扩容|适配|迁移|调整)\S*$/u;
const SYNTHESIS_PROCEDURE_GOVERNOR =
  /^(?:(?:要|应该|应当)\s*)?(?:如何|怎样|怎么)\s*\S+|^[\p{Script=Han}A-Za-z0-9/]{1,12}(?:要|应该|应当)(?:如何|怎样|怎么)\s*\S+/u;
const SYNTHESIS_DIAGNOSIS_PREDICATE = /(?:能力)?是否足够$|^是否(?:应该|应当|可以|能够|具备).*(?:推进|实施|执行|条件)/u;
const INCOMPLETE_DIAGNOSTIC_GOVERNOR = /^(?:评估|分析|诊断|预测|判断)$/u;
const INCOMPLETE_PROCEDURE_GOVERNOR = /^(?:如何|怎样|怎么)[\p{Script=Han}]{1,2}$/u;
const INCOMPLETE_OUTPUT_GOVERNOR = /^(?:给出|提出|制定|输出|形成|提供)$/u;
const CONTEXT_PREMISE =
  /^(?:(?:如果|若|假如|倘若|只要|除非)\s*\S+|当\s*\S+(?:时|期间|情况下)|在\s*\S+(?:时|期间|阶段|情况下|场景))$/u;

const FACT_REQUEST_AT_START = /^(?:确认|核实|说明|列出)/u;
const FACT_REQUEST_IN_PARALLEL =
  /(?:^|既要|又要|并|同时|另需|还要|还需|另要)\s*(?:确认|核实|说明|列出)/gu;
const STATE_FACT_CUE_TEST = /(?:当前|现有|实际)/u;
const STATE_FACT_CUE_OCCURRENCE = /(?:当前|现有|实际)/gu;
const FACT_QUANTIFIER_CUE_TEST = /(?:所有|全部|完整|全量)/u;
const FACT_QUANTIFIER_CUE_OCCURRENCE = /(?:所有|全部|完整|全量)/gu;
const ABSTRACT_DIAGNOSTIC_OBJECT =
  /(?:风险|问题|原因|根因|因素|瓶颈|差距|可行性|影响|挑战|障碍|优劣|趋势)$/u;
const ABSTRACT_DIAGNOSTIC_NOMINAL =
  /\S+(?:的|之)(?:风险|问题|原因|根因|因素|瓶颈|差距|可行性|影响|挑战|障碍|优劣|趋势)$/u;
const QUANTIFIED_FACT_POSSESSIVE =
  /(?:所有|全部|完整|全量)\S+(?:的|之)(?:风险|问题|原因|根因|因素|瓶颈|差距|可行性|影响|挑战|障碍|优劣|趋势)$/u;
const NUMERIC_FACT =
  /\d+(?:\.\d+)?\s*(?:万|千)?\s*(?:用户|并发|QPS|TPS|GB|TB|PB|毫秒|秒|分钟|小时|%)/giu;
const TECHNICAL_SUPPORT = /支持/gu;

const SUPPORT_RELATION_ACTION =
  /^(?:如何)?(?:识别|联系|争取|获得)\s*(?:客户(?:侧)?支持(?:者|团队)?|内部支持者|业务支持者|支持团队|管理层)$/u;
const SUPPORT_COORDINATION_ACTION =
  /^(?:如何)?(?:协调|联系|识别)\s*(?:[\p{Script=Han}A-Za-z0-9/]{0,12}支持团队|[\p{Script=Han}A-Za-z0-9/]{0,12}支持者|管理层)(?:推进)?(?:项目|机会|客户)?$/u;
const SUPPORT_ADVANCEMENT_RELATION =
  /^(?:(?:(?!支持)[\p{Script=Han}A-Za-z0-9/]){0,12}团队|支持团队|客户(?:侧)?支持(?:者|团队)?|内部支持者|业务支持者|管理层)\s*支持\s*(?:项目|机会|客户)(?:推进)?(?:和(?:项目|机会|客户)(?:推进)?)*$/u;
const SUPPORT_EXISTENCE_QUESTION = /^(?:是否有|有无|有没有)客户支持$/u;
const MANAGEMENT_SUPPORT_ACTION =
  /^(?:如何)?争取(?:[\p{Script=Han}A-Za-z0-9/]{0,12})?管理层支持$/u;

const OPPORTUNITY_FORECAST =
  /^(?:(?:(?:评估|预测|判断|分析))?(?:(?:(?:当前)?(?:商机|机会|项目))?|(?:(?:这个|该|本)(?:商机|机会|项目)|(?:我们|我方|本方))(?:的)?)(?:赢率|胜率|成交概率|成功概率|机会质量|机会预测|销售预测)|(?:当前)?(?:商机|机会|项目)(?:评估|预测|判断|分析)(?:赢率|胜率|成交概率|成功概率|机会质量|机会预测|销售预测))(?:(?:如何|怎么样)|(?:可能)?(?:为|是)?\d+(?:\.\d+)?%)?$/u;

interface WordSegmenter {
  segment(value: string): Iterable<{
    segment: string;
    index: number;
    isWordLike?: boolean;
  }>;
}

const DefaultSegmenter = (Intl as unknown as {
  Segmenter?: new (
    locale: string,
    options: { granularity: "word" },
  ) => WordSegmenter;
}).Segmenter;
const defaultSegmenter = DefaultSegmenter === undefined
  ? undefined
  : new DefaultSegmenter("zh-CN", { granularity: "word" });

const defaultWordBoundaryCandidateProvider: WordBoundaryCandidateProvider = (sourceText) => {
  if (defaultSegmenter === undefined) return undefined;
  return [...defaultSegmenter.segment(sourceText)]
    .filter((segment) => segment.isWordLike !== false)
    .map((segment) => ({
      text: segment.segment,
      start: segment.index,
      end: segment.index + segment.segment.length,
    }));
};

export function createObligationSourceAnalyzer(
  candidateProvider: WordBoundaryCandidateProvider = defaultWordBoundaryCandidateProvider,
): (sourceText: string) => ObligationSemanticAnalysis {
  return (sourceText) => analyzeWithProvider(sourceText, candidateProvider);
}

export const analyzeObligationSource = createObligationSourceAnalyzer();

function analyzeWithProvider(
  sourceText: string,
  candidateProvider: WordBoundaryCandidateProvider,
): ObligationSemanticAnalysis {
  const sourceSpan = findTrimmedSpan(sourceText);
  if (sourceSpan.start === sourceSpan.end) {
    return {
      sourceSpan,
      tokens: [],
      segments: [],
      boundaries: [],
      constituents: [],
      atoms: [],
      requiresDirectEvidence: true,
      unresolved: true,
      customerInputEligible: false,
      diagnostics: {
        rangeEvaluations: 0,
        cacheHits: 0,
      },
    };
  }

  const candidateWords = candidateProvider(sourceText);
  const tokenization = tokenizeSource(sourceText, sourceSpan, candidateWords);
  const context: AnalyzerContext = {
    sourceText,
    sourceSpan,
    tokenization,
    parseCache: new Map(),
    diagnostics: {
      rangeEvaluations: 0,
      cacheHits: 0,
    },
  };
  const atoms = !tokenization.balanced || !tokenization.reliable
    ? [createAtom(context, sourceSpan, "unresolved", "ambiguous_structure")]
    : parseRange(context, sourceSpan, 0);
  const safeAtoms = atoms.length > 0
    ? [...atoms].sort((left, right) => left.start - right.start)
    : [createAtom(context, sourceSpan, "unresolved", "ambiguous_structure")];
  const boundaries = complementAtoms(context, safeAtoms);
  const segments = [...safeAtoms, ...boundaries]
    .sort((left, right) => left.start - right.start);
  const constituents = segments.map((segment) => ({
    nodeType: "constituent" as const,
    text: segment.text,
    start: segment.start,
    end: segment.end,
    kind: segment.kind,
    occurrences: segment.nodeType === "atom" ? segment.occurrences : [],
    children: tokenization.tokens.filter((token) =>
      token.start >= segment.start && token.end <= segment.end),
  }));
  const unresolved = safeAtoms.some((atom) => atom.kind === "unresolved");

  return {
    sourceSpan,
    tokens: tokenization.tokens,
    segments,
    boundaries,
    constituents,
    atoms: safeAtoms,
    requiresDirectEvidence: unresolved || safeAtoms.some((atom) => atom.kind === "protected_fact"),
    unresolved,
    customerInputEligible: isPureOpportunityForecast(sourceText.slice(sourceSpan.start, sourceSpan.end)),
    diagnostics: { ...context.diagnostics },
  };
}

function tokenizeSource(
  sourceText: string,
  sourceSpan: SourceSpan,
  candidateWords: readonly WordBoundaryCandidate[] | undefined,
): Tokenization {
  if (candidateWords === undefined) {
    return {
      tokens: [{
        text: sourceText.slice(sourceSpan.start, sourceSpan.end),
        start: sourceSpan.start,
        end: sourceSpan.end,
        kind: "text",
        depth: 0,
      }],
      balanced: true,
      matchingDelimiters: new Map(),
      candidateWords,
      reliable: false,
    };
  }

  const normalizedCandidates = [...candidateWords]
    .filter((candidate) =>
      candidate.start >= sourceSpan.start &&
      candidate.end <= sourceSpan.end &&
      candidate.end > candidate.start &&
      candidate.text === sourceText.slice(candidate.start, candidate.end))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const boundaryByStart = new Map(
    normalizedCandidates
      .filter((candidate) => ALL_WORD_BOUNDARIES.has(candidate.text))
      .map((candidate) => [candidate.start, candidate]),
  );
  const reliable = normalizedCandidates.length === candidateWords.length &&
    candidatesCoverLexicalSource(sourceText, sourceSpan, normalizedCandidates) &&
    normalizedCandidates.every((candidate) =>
      !containsEmbeddedWeakGlyph(candidate.text) || candidate.text.length <= 2);

  const tokens: InternalToken[] = [];
  let cursor = sourceSpan.start;
  while (cursor < sourceSpan.end) {
    const punctuation = matchPunctuation(sourceText, cursor);
    if (punctuation !== undefined) {
      tokens.push(makeBoundaryToken(sourceText, cursor, cursor + punctuation.length, "punctuation"));
      cursor += punctuation.length;
      continue;
    }

    const character = sourceText[cursor]!;
    if (OPEN_TO_CLOSE.has(character)) {
      tokens.push(makeBoundaryToken(sourceText, cursor, cursor + 1, "open_delimiter"));
      cursor += 1;
      continue;
    }
    if (CLOSE_TO_OPEN.has(character)) {
      tokens.push(makeBoundaryToken(sourceText, cursor, cursor + 1, "close_delimiter"));
      cursor += 1;
      continue;
    }
    if (character === "\"") {
      tokens.push(makeBoundaryToken(sourceText, cursor, cursor + 1, "open_delimiter"));
      cursor += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      let end = cursor + 1;
      while (end < sourceSpan.end && /\s/u.test(sourceText[end]!) && matchPunctuation(sourceText, end) === undefined) {
        end += 1;
      }
      tokens.push(makeBoundaryToken(sourceText, cursor, end, "whitespace"));
      cursor = end;
      continue;
    }

    const wordBoundary = boundaryByStart.get(cursor);
    if (wordBoundary !== undefined) {
      const boundaryKind = STRONG_CONNECTORS.has(wordBoundary.text)
        ? "connector"
        : SEQUENCE_CONNECTORS.has(wordBoundary.text)
          ? "sequence"
          : "connector";
      tokens.push(makeBoundaryToken(sourceText, cursor, wordBoundary.end, boundaryKind));
      cursor = wordBoundary.end;
      continue;
    }

    let end = cursor + 1;
    while (end < sourceSpan.end) {
      if (
        matchPunctuation(sourceText, end) !== undefined ||
        OPEN_TO_CLOSE.has(sourceText[end]!) ||
        CLOSE_TO_OPEN.has(sourceText[end]!) ||
        sourceText[end] === "\"" ||
        /\s/u.test(sourceText[end]!) ||
        boundaryByStart.has(end)
      ) {
        break;
      }
      end += 1;
    }
    tokens.push({
      text: sourceText.slice(cursor, end),
      start: cursor,
      end,
      kind: "text",
      depth: 0,
    });
    cursor = end;
  }

  const stack: Array<{ open: string; expected: string; start: number }> = [];
  const matchingDelimiters = new Map<number, number>();
  let balanced = true;
  for (const token of tokens) {
    if (token.boundaryKind === "open_delimiter") {
      if (token.text === "\"" && stack[stack.length - 1]?.expected === "\"") {
        const opened = stack.pop()!;
        token.depth = stack.length;
        matchingDelimiters.set(opened.start, token.start);
        matchingDelimiters.set(token.start, opened.start);
        token.boundaryKind = "close_delimiter";
        continue;
      }
      token.depth = stack.length;
      stack.push({
        open: token.text,
        expected: token.text === "\"" ? "\"" : OPEN_TO_CLOSE.get(token.text)!,
        start: token.start,
      });
      continue;
    }
    if (token.boundaryKind === "close_delimiter") {
      const opened = stack.pop();
      token.depth = stack.length;
      if (opened === undefined || opened.expected !== token.text) {
        balanced = false;
        continue;
      }
      matchingDelimiters.set(opened.start, token.start);
      matchingDelimiters.set(token.start, opened.start);
      continue;
    }
    token.depth = stack.length;
  }
  if (stack.length > 0) balanced = false;

  return {
    tokens,
    balanced,
    matchingDelimiters,
    candidateWords: normalizedCandidates,
    reliable,
  };
}

function parseRange(
  context: AnalyzerContext,
  untrimmed: SourceSpan,
  depth: number,
): readonly SourceIntentAtom[] {
  const span = trimSpan(context.sourceText, untrimmed);
  if (span === undefined) return [];
  const cacheKey = `${depth}:${span.start}:${span.end}`;
  const cached = context.parseCache.get(cacheKey);
  if (cached !== undefined) {
    context.diagnostics.cacheHits += 1;
    return cached;
  }
  context.diagnostics.rangeEvaluations += 1;
  const result = Object.freeze([...parseTrimmedRange(context, span, depth)]);
  context.parseCache.set(cacheKey, result);
  return result;
}

function parseTrimmedRange(
  context: AnalyzerContext,
  span: SourceSpan,
  depth: number,
): readonly SourceIntentAtom[] {
  const outer = outerDelimiter(context, span);
  if (outer !== undefined) {
    return parseRange(context, outer.inner, depth + 1);
  }

  const wholeText = context.sourceText.slice(span.start, span.end);
  if (isRelationshipSupport(wholeText)) {
    return [createAtom(context, span, "relationship_support", "relationship_support")];
  }

  const structuralBoundaries = tokensWithin(context, span).filter((token) =>
    token.depth === depth &&
    token.kind === "boundary" &&
    (token.boundaryKind === "punctuation" ||
      token.boundaryKind === "sequence" ||
      (token.boundaryKind === "connector" && STRONG_CONNECTORS.has(token.text))));
  const structuralParts = splitByTokens(context.sourceText, span, structuralBoundaries);
  if (structuralParts.length > 1) {
    return composeStructuralParts(context, structuralParts, depth);
  }

  const embeddedGroups = embeddedDelimiterGroups(context, span, depth);
  if (embeddedGroups.length > 0) {
    if (canComposeDelimitedGovernorObject(context, span, embeddedGroups, depth)) {
      return [createAtom(context, span, "synthesis", "governed_object")];
    }
    if (embeddedGroupsBelongToOuterSynthesis(context, span, embeddedGroups, depth)) {
      return [classifyConstituent(context, span)];
    }
    const atoms: SourceIntentAtom[] = [];
    let cursor = span.start;
    for (const group of embeddedGroups) {
      const gap = { start: cursor, end: group.start };
      if (!containsOnlyBoundaries(context, gap)) {
        atoms.push(...parseRange(context, gap, depth));
      }
      atoms.push(...parseRange(context, group, depth));
      cursor = group.end;
    }
    const tail = { start: cursor, end: span.end };
    if (!containsOnlyBoundaries(context, tail)) {
      atoms.push(...parseRange(context, tail, depth));
    }
    return atoms;
  }

  const weakBoundaries = tokensWithin(context, span).filter((token) =>
    token.depth === depth &&
    token.kind === "boundary" &&
    token.boundaryKind === "connector" &&
    WEAK_CONNECTORS.has(token.text));

  if (weakBoundaries.length > 0) {
    for (const boundary of weakBoundaries) {
      const left = trimSpan(context.sourceText, { start: span.start, end: boundary.start });
      const right = trimSpan(context.sourceText, { start: boundary.end, end: span.end });
      if (left === undefined || right === undefined) continue;
      const leftKind = previewRange(context, left, depth);
      const rightKind = previewRange(context, right, depth);
      const decision = decideWeakBoundary(
        boundary.text,
        leftKind,
        rightKind,
        canBindSingleCharacterPrefix(context, boundary, right),
      );
      if (decision === "ambiguous") {
        return [createAtom(context, span, "unresolved", "ambiguous_structure")];
      }
      if (decision === "split") {
        return [
          ...parseRange(context, left, depth),
          ...parseRange(context, right, depth),
        ];
      }
    }
  }

  return [classifyConstituent(context, span)];
}

function previewRange(context: AnalyzerContext, span: SourceSpan, depth: number): PreviewKind {
  const atoms = parseRange(context, span, depth);
  if (atoms.some((atom) => atom.kind === "unresolved")) return "unresolved";
  if (atoms.some((atom) =>
    atom.kind === "protected_fact" && atom.reason === "protected_occurrence")) {
    return "protected_fact";
  }
  if (atoms.length > 0 && atoms.every((atom) => atom.kind === "synthesis")) return "synthesis";
  if (atoms.length > 0 && atoms.every((atom) => atom.kind === "relationship_support")) {
    return "relationship_support";
  }
  const text = context.sourceText.slice(span.start, span.end);
  if (isNominalConstituent(context, span, text)) return "nominal";
  if (atoms.some((atom) => atom.kind === "protected_fact")) return "unresolved";
  return "unresolved";
}

function decideWeakBoundary(
  connector: string,
  left: PreviewKind,
  right: PreviewKind,
  canBindAsPrefix: boolean,
): "keep" | "split" | "ambiguous" {
  if (left === "synthesis" && right === "synthesis") return "split";
  if (left === "relationship_support" && right === "relationship_support") return "split";
  if (connector === "并") {
    if (left === "unresolved" || right === "unresolved") {
      return canBindAsPrefix ? "keep" : "split";
    }
    return "split";
  }
  if (left === "nominal" || right === "nominal") return "ambiguous";
  if (left === "unresolved" || right === "unresolved") return "ambiguous";
  return "split";
}

function canComposeDelimitedGovernorObject(
  context: AnalyzerContext,
  span: SourceSpan,
  groups: readonly SourceSpan[],
  depth: number,
): boolean {
  if (groups.length !== 1) return false;
  const group = groups[0]!;
  const prefix = trimSpan(context.sourceText, { start: span.start, end: group.start });
  const suffix = trimSpan(context.sourceText, { start: group.end, end: span.end });
  const delimited = outerDelimiter(context, group);
  if (prefix === undefined || suffix !== undefined || delimited === undefined) return false;
  const governorSpan = trimTrailingBoundaries(context, prefix);
  if (governorSpan === undefined) return false;

  const governor = incompleteGovernorKind(
    context.sourceText.slice(governorSpan.start, governorSpan.end),
  );
  if (governor === undefined) return false;
  const objectAtoms = parseRange(context, delimited.inner, depth + 1);
  return governorAcceptsObject(
    governor,
    context.sourceText.slice(delimited.inner.start, delimited.inner.end),
    objectAtoms,
  );
}

function trimTrailingBoundaries(
  context: AnalyzerContext,
  span: SourceSpan,
): SourceSpan | undefined {
  let end = span.end;
  for (const token of [...tokensWithin(context, span)].reverse()) {
    if (token.end !== end || token.kind !== "boundary") break;
    end = token.start;
  }
  return trimSpan(context.sourceText, { start: span.start, end });
}

function composeStructuralParts(
  context: AnalyzerContext,
  parts: readonly SourceSpan[],
  depth: number,
): readonly SourceIntentAtom[] {
  const atoms: SourceIntentAtom[] = [];
  const hasLaterSynthesis = parts.slice(1).some((part) => {
    const text = context.sourceText.slice(part.start, part.end);
    return isExplicitSynthesis(text) || incompleteGovernorKind(text) !== undefined;
  });
  let leadingContext = true;
  let index = 0;
  while (index < parts.length) {
    const part = parts[index]!;
    const partText = context.sourceText.slice(part.start, part.end);
    if (leadingContext && hasLaterSynthesis && isContextPremise(partText)) {
      atoms.push(createAtom(context, part, "synthesis", "context_premise"));
      index += 1;
      continue;
    }
    leadingContext = false;

    const object = parts[index + 1];
    if (object !== undefined) {
      const objectText = context.sourceText.slice(object.start, object.end);
      if (isRelationshipSupport(`${partText}${objectText}`)) {
        atoms.push(createAtom(
          context,
          { start: part.start, end: object.end },
          "relationship_support",
          "relationship_support",
        ));
        index += 2;
        continue;
      }

      const governor = incompleteGovernorKind(partText);
      if (governor !== undefined) {
        const objectAtoms = parseRange(context, object, depth);
        if (governorAcceptsObject(governor, objectText, objectAtoms)) {
          atoms.push(createAtom(
            context,
            { start: part.start, end: object.end },
            "synthesis",
            "governed_object",
          ));
          index += 2;
          continue;
        }
      }
    }

    atoms.push(...parseRange(context, part, depth));
    index += 1;
  }
  return atoms;
}

function incompleteGovernorKind(value: string): IncompleteGovernorKind | undefined {
  const text = semanticSkeleton(stripQuestionParticles(value.trim()));
  if (INCOMPLETE_DIAGNOSTIC_GOVERNOR.test(text)) return "diagnostic";
  if (INCOMPLETE_PROCEDURE_GOVERNOR.test(text)) return "procedure";
  if (INCOMPLETE_OUTPUT_GOVERNOR.test(text)) return "output";
  return undefined;
}

function governorAcceptsObject(
  governor: IncompleteGovernorKind,
  value: string,
  atoms: readonly SourceIntentAtom[],
): boolean {
  if (atoms.length === 0 || atoms.some((atom) =>
    atom.kind === "protected_fact" && atom.reason === "protected_occurrence")) {
    return false;
  }
  const text = semanticSkeleton(stripQuestionParticles(value.trim()));
  if (atoms.some((atom) => atom.kind === "unresolved")) return false;
  if (governor === "diagnostic") {
    return atoms.length === 1 && ABSTRACT_DIAGNOSTIC_OBJECT.test(text);
  }
  if (governor === "output") {
    return atoms.every((atom) => atom.kind === "synthesis");
  }
  return atoms.every((atom) =>
    atom.kind === "synthesis" ||
    (atom.kind === "protected_fact" && atom.reason === "default_fact"));
}

function classifyConstituent(context: AnalyzerContext, span: SourceSpan): SourceIntentAtom {
  const text = context.sourceText.slice(span.start, span.end);
  if (isRelationshipSupport(text)) {
    return createAtom(context, span, "relationship_support", "relationship_support");
  }

  const protectedOccurrences = findProtectedOccurrences(text, span.start);
  const synthesis = isExplicitSynthesis(text);
  const effectiveProtectedOccurrences = synthesis && isSynthesisCollectionRequestedByFactVerb(text)
    ? protectedOccurrences.filter((occurrence) => occurrence.kind !== "explicit_fact_request")
    : protectedOccurrences;
  if (effectiveProtectedOccurrences.length > 0) {
    return createAtom(
      context,
      span,
      "protected_fact",
      "protected_occurrence",
      effectiveProtectedOccurrences,
    );
  }
  if (synthesis) {
    return createAtom(context, span, "synthesis", "explicit_synthesis_scope");
  }
  if (hasDanglingSynthesisGovernor(text)) {
    return createAtom(context, span, "unresolved", "ambiguous_structure");
  }
  return createAtom(context, span, "protected_fact", "default_fact");
}

function isExplicitSynthesis(value: string): boolean {
  const text = stripQuestionParticles(value.trim());
  if (!text) return false;
  if (
    ABSTRACT_DIAGNOSTIC_NOMINAL.test(text) &&
    !QUANTIFIED_FACT_POSSESSIVE.test(text)
  ) return true;
  if (SYNTHESIS_NOMINAL_HEAD.test(text)) return true;
  if (SYNTHESIS_SPEECH_ACT.test(text)) return true;
  if (SYNTHESIS_CHANGE_GOVERNOR.test(text)) return true;
  if (SYNTHESIS_DIAGNOSIS_PREDICATE.test(text)) return true;
  return SYNTHESIS_PROCEDURE_GOVERNOR.test(text);
}

function isSynthesisCollectionRequestedByFactVerb(value: string): boolean {
  const text = stripQuestionParticles(value.trim());
  if (!FACT_REQUEST_AT_START.test(text)) return false;
  const scope = text.replace(FACT_REQUEST_AT_START, "");
  return SYNTHESIS_NOMINAL_HEAD.test(scope) && !SYNTHESIS_OUTPUT_OCCURRENCE.test(scope);
}

function hasDanglingSynthesisGovernor(value: string): boolean {
  const text = stripQuestionParticles(value.trim());
  if (/\S(?:建议|方案|行动|计划|规划|路线图|路径|策略|措施|步骤|流程|方法|做法|思路)\S/u.test(text)) {
    return true;
  }
  return /\S+(?:优化|提升|改造|升级)$/u.test(text) &&
    !SYNTHESIS_CHANGE_GOVERNOR.test(text);
}

function findProtectedOccurrences(value: string, offset: number): readonly SourceOccurrence[] {
  const occurrences: SourceOccurrence[] = [];
  for (const match of value.matchAll(NUMERIC_FACT)) {
    occurrences.push(createOccurrence(value, offset, match, "numeric_fact"));
  }
  for (const match of value.matchAll(TECHNICAL_SUPPORT)) {
    occurrences.push(createOccurrence(value, offset, match, "technical_support"));
  }
  if (isAssessmentOfStateFact(value)) {
    for (const match of value.matchAll(STATE_FACT_CUE_OCCURRENCE)) {
      occurrences.push(createOccurrence(value, offset, match, "state_fact"));
    }
  }
  if (isAssessmentOfQuantifiedFact(value) || QUANTIFIED_FACT_POSSESSIVE.test(value)) {
    for (const match of value.matchAll(FACT_QUANTIFIER_CUE_OCCURRENCE)) {
      occurrences.push(createOccurrence(value, offset, match, "quantified_fact"));
    }
  }
  if (!isSynthesisCollectionRequestedByFactVerb(value)) {
    for (const match of value.matchAll(FACT_REQUEST_IN_PARALLEL)) {
      const cue = match[0].match(/(?:确认|核实|说明|列出)/u);
      if (cue === null) continue;
      const relativeStart = (match.index ?? 0) + match[0].lastIndexOf(cue[0]);
      occurrences.push({
        text: cue[0],
        start: offset + relativeStart,
        end: offset + relativeStart + cue[0].length,
        kind: "explicit_fact_request",
      });
    }
  }
  return deduplicateOccurrences(occurrences);
}

function isRelationshipSupport(value: string): boolean {
  const text = stripQuestionParticles(semanticSkeleton(value));
  return SUPPORT_RELATION_ACTION.test(text) ||
    SUPPORT_COORDINATION_ACTION.test(text) ||
    SUPPORT_ADVANCEMENT_RELATION.test(text) ||
    SUPPORT_EXISTENCE_QUESTION.test(text) ||
    MANAGEMENT_SUPPORT_ACTION.test(text);
}

function semanticSkeleton(value: string): string {
  return [...value]
    .filter((character) =>
      !/\s/u.test(character) &&
      character !== "\"" &&
      !OPEN_TO_CLOSE.has(character) &&
      !CLOSE_TO_OPEN.has(character))
    .join("");
}

function isPureOpportunityForecast(value: string): boolean {
  const text = normalizeOpportunityForecastContext(
    stripQuestionParticles(value.trim()).replace(/\s+/gu, ""),
  );
  return OPPORTUNITY_FORECAST.test(text);
}

function normalizeOpportunityForecastContext(value: string): string {
  return value
    .replace(
      /^(?:在(?:这种|上述|当前|该)情况下|基于(?:这些|上述|当前)信息|根据(?:这些|上述|当前)情况)/u,
      "",
    )
    .replace(
      /^((?:当前)?(?:商机|机会|项目))的(?=(?:赢率|胜率|成交概率|成功概率|机会质量|机会预测|销售预测))/u,
      "$1",
    );
}

function isContextPremise(value: string): boolean {
  return CONTEXT_PREMISE.test(stripQuestionParticles(value.trim()));
}

function isAssessmentOfStateFact(value: string): boolean {
  const text = stripQuestionParticles(value.trim());
  return SYNTHESIS_SPEECH_ACT.test(text) &&
    STATE_FACT_CUE_TEST.test(text) &&
    !SYNTHESIS_NOMINAL_HEAD.test(text) &&
    !ABSTRACT_DIAGNOSTIC_OBJECT.test(text);
}

function isAssessmentOfQuantifiedFact(value: string): boolean {
  const text = stripQuestionParticles(value.trim());
  return SYNTHESIS_SPEECH_ACT.test(text) &&
    FACT_QUANTIFIER_CUE_TEST.test(text) &&
    !SYNTHESIS_NOMINAL_HEAD.test(text) &&
    !ABSTRACT_DIAGNOSTIC_OBJECT.test(text);
}

function isNominalConstituent(
  context: AnalyzerContext,
  span: SourceSpan,
  value: string,
): boolean {
  if (!value.trim() || isExplicitSynthesis(value) || isRelationshipSupport(value)) return false;
  const candidates = context.tokenization.candidateWords?.filter((candidate) =>
    candidate.start >= span.start && candidate.end <= span.end) ?? [];
  return candidates.some((candidate) =>
    candidate.text.length >= 2 && !ALL_WORD_BOUNDARIES.has(candidate.text));
}

function canBindSingleCharacterPrefix(
  context: AnalyzerContext,
  boundary: SourceToken,
  right: SourceSpan,
): boolean {
  if (boundary.text !== "并") return false;
  const text = context.sourceText.slice(right.start, right.end);
  if (SYNTHESIS_OUTPUT_GOVERNOR.test(text)) return false;
  const firstWord = context.tokenization.candidateWords
    ?.filter((candidate) => candidate.start >= right.start && candidate.end <= right.end)
    .sort((left, other) => left.start - other.start);
  return firstWord?.[0]?.start === right.start &&
    firstWord[0].text.length === 1 &&
    firstWord[1] !== undefined &&
    SYNTHESIS_CHANGE_WORD.test(firstWord[1].text);
}

function createAtom(
  context: AnalyzerContext,
  span: SourceSpan,
  kind: SourceIntentKind,
  reason: SourceIntentReason,
  occurrences?: readonly SourceOccurrence[],
): SourceIntentAtom {
  const text = context.sourceText.slice(span.start, span.end);
  const inferredOccurrences = occurrences ?? (kind === "relationship_support"
    ? [{ text, start: span.start, end: span.end, kind: "relationship_support" as const }]
    : kind === "synthesis"
      ? [{ text, start: span.start, end: span.end, kind: "synthesis_governor" as const }]
      : kind === "unresolved"
        ? [{ text, start: span.start, end: span.end, kind: "unresolved" as const }]
        : []);
  return {
    nodeType: "atom",
    text,
    start: span.start,
    end: span.end,
    kind,
    reason,
    occurrences: inferredOccurrences,
  };
}

function complementAtoms(
  context: AnalyzerContext,
  atoms: readonly SourceIntentAtom[],
): readonly SourceBoundarySpan[] {
  const boundaries: SourceBoundarySpan[] = [];
  let cursor = context.sourceSpan.start;
  for (const atom of atoms) {
    if (atom.start > cursor) boundaries.push(createBoundary(context, cursor, atom.start));
    cursor = Math.max(cursor, atom.end);
  }
  if (cursor < context.sourceSpan.end) {
    boundaries.push(createBoundary(context, cursor, context.sourceSpan.end));
  }
  return boundaries;
}

function createBoundary(
  context: AnalyzerContext,
  start: number,
  end: number,
): SourceBoundarySpan {
  const coveredTokens = context.tokenization.tokens.filter((token) =>
    token.start >= start && token.end <= end && token.kind === "boundary");
  const kinds = new Set(coveredTokens.map((token) => token.boundaryKind));
  const boundaryKind = kinds.size === 1
    ? [...kinds][0] ?? "structural"
    : "structural";
  return {
    nodeType: "boundary",
    text: context.sourceText.slice(start, end),
    start,
    end,
    kind: "boundary",
    boundaryKind,
  };
}

function outerDelimiter(
  context: AnalyzerContext,
  span: SourceSpan,
): { readonly inner: SourceSpan } | undefined {
  const first = context.tokenization.tokens.find((token) => token.start === span.start);
  const last = [...context.tokenization.tokens].reverse().find((token) => token.end === span.end);
  if (
    first?.boundaryKind !== "open_delimiter" ||
    last?.boundaryKind !== "close_delimiter" ||
    context.tokenization.matchingDelimiters.get(first.start) !== last.start
  ) {
    return undefined;
  }
  const inner = trimSpan(context.sourceText, { start: first.end, end: last.start });
  return inner === undefined ? undefined : { inner };
}

function embeddedGroupsBelongToOuterSynthesis(
  context: AnalyzerContext,
  span: SourceSpan,
  groups: readonly SourceSpan[],
  depth: number,
): boolean {
  const wholeText = context.sourceText.slice(span.start, span.end);
  if (!isExplicitSynthesis(wholeText)) return false;

  return groups.every((group) => {
    const delimited = outerDelimiter(context, group);
    if (delimited === undefined) return false;
    const childAtoms = parseRange(context, delimited.inner, depth + 1);
    if (childAtoms.some((atom) =>
      atom.kind === "unresolved" ||
      (atom.kind === "protected_fact" && atom.reason === "protected_occurrence"))) {
      return false;
    }
    if (childAtoms.length > 0 && childAtoms.every((atom) => atom.kind === "synthesis")) {
      return true;
    }
    if (childAtoms.some((atom) => atom.kind === "relationship_support")) return false;

    const childText = unwrapDelimitedText(
      context.sourceText.slice(delimited.inner.start, delimited.inner.end),
    );
    if (STATE_FACT_CUE_TEST.test(childText)) {
      return false;
    }

    const unresolvedDefault = childAtoms.length === 0 || childAtoms.some((atom) =>
      atom.kind !== "protected_fact" || atom.reason !== "default_fact");
    if (unresolvedDefault) return false;

    const prefix = trimSpan(context.sourceText, { start: span.start, end: group.start });
    const suffix = trimSpan(context.sourceText, { start: group.end, end: span.end });
    if (suffix === undefined) return false;
    const prefixCompletesGovernor = prefix !== undefined && isExplicitSynthesis(
      context.sourceText.slice(prefix.start, prefix.end),
    );
    const suffixCompletesHead = isExplicitSynthesis(
      context.sourceText.slice(suffix.start, suffix.end).replace(/^的/u, ""),
    );
    return prefixCompletesGovernor || suffixCompletesHead;
  });
}

function containsOnlyBoundaries(context: AnalyzerContext, span: SourceSpan): boolean {
  const trimmed = trimSpan(context.sourceText, span);
  if (trimmed === undefined) return true;
  const tokens = tokensWithin(context, trimmed);
  return tokens.length > 0 &&
    tokens.every((token) => token.kind === "boundary") &&
    tokens[0]!.start === trimmed.start &&
    tokens[tokens.length - 1]!.end === trimmed.end;
}

function unwrapDelimitedText(value: string): string {
  let text = value.trim();
  while (text.length >= 2) {
    const expected = text[0] === "\"" ? "\"" : OPEN_TO_CLOSE.get(text[0]!);
    if (expected === undefined || text[text.length - 1] !== expected) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function embeddedDelimiterGroups(
  context: AnalyzerContext,
  span: SourceSpan,
  depth: number,
): readonly SourceSpan[] {
  const groups: SourceSpan[] = [];
  for (const token of tokensWithin(context, span)) {
    if (token.boundaryKind !== "open_delimiter" || token.depth !== depth) continue;
    const closeStart = context.tokenization.matchingDelimiters.get(token.start);
    if (closeStart === undefined) continue;
    const close = context.tokenization.tokens.find((candidate) =>
      candidate.start === closeStart && candidate.boundaryKind === "close_delimiter");
    if (close === undefined) continue;
    if (token.start === span.start && close.end === span.end) continue;
    groups.push({ start: token.start, end: close.end });
  }
  return groups.sort((left, right) => left.start - right.start);
}

function tokensWithin(context: AnalyzerContext, span: SourceSpan): readonly SourceToken[] {
  return context.tokenization.tokens.filter((token) =>
    token.start >= span.start && token.end <= span.end);
}

function splitByTokens(
  sourceText: string,
  span: SourceSpan,
  boundaries: readonly SourceToken[],
): readonly SourceSpan[] {
  const parts: SourceSpan[] = [];
  let cursor = span.start;
  for (const boundary of boundaries) {
    const part = trimSpan(sourceText, { start: cursor, end: boundary.start });
    if (part !== undefined) parts.push(part);
    cursor = boundary.end;
  }
  const tail = trimSpan(sourceText, { start: cursor, end: span.end });
  if (tail !== undefined) parts.push(tail);
  return parts;
}

function makeBoundaryToken(
  sourceText: string,
  start: number,
  end: number,
  boundaryKind: SourceBoundaryKind,
): InternalToken {
  return {
    text: sourceText.slice(start, end),
    start,
    end,
    kind: "boundary",
    boundaryKind,
    depth: 0,
  };
}

function matchPunctuation(value: string, index: number): string | undefined {
  return ORDERED_HARD_PUNCTUATION.find((candidate) => value.startsWith(candidate, index));
}

function containsEmbeddedWeakGlyph(value: string): boolean {
  return /[和及与跟并]/u.test(value) && !WEAK_CONNECTORS.has(value);
}

function candidatesCoverLexicalSource(
  sourceText: string,
  sourceSpan: SourceSpan,
  candidates: readonly WordBoundaryCandidate[],
): boolean {
  let cursor = sourceSpan.start;
  for (const candidate of candidates) {
    if (candidate.start < cursor) return false;
    if (!isIgnorableCandidateGap(sourceText.slice(cursor, candidate.start))) {
      return false;
    }
    cursor = candidate.end;
  }
  return isIgnorableCandidateGap(sourceText.slice(cursor, sourceSpan.end));
}

function isIgnorableCandidateGap(value: string): boolean {
  return [...value].every((character) => /[\s\p{P}\p{S}]/u.test(character));
}

function createOccurrence(
  value: string,
  offset: number,
  match: RegExpMatchArray,
  kind: SourceOccurrence["kind"],
): SourceOccurrence {
  const start = offset + (match.index ?? 0);
  return {
    text: match[0],
    start,
    end: start + match[0].length,
    kind,
  };
}

function deduplicateOccurrences(
  occurrences: readonly SourceOccurrence[],
): readonly SourceOccurrence[] {
  const seen = new Set<string>();
  return [...occurrences]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((occurrence) => {
      const key = `${occurrence.start}:${occurrence.end}:${occurrence.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function stripQuestionParticles(value: string): string {
  return value.replace(/[？?吗呢吧]+$/u, "");
}

function findTrimmedSpan(sourceText: string): SourceSpan {
  let start = 0;
  let end = sourceText.length;
  while (start < end && /\s/u.test(sourceText[start]!)) start += 1;
  while (end > start && /\s/u.test(sourceText[end - 1]!)) end -= 1;
  return { start, end };
}

function trimSpan(sourceText: string, span: SourceSpan): SourceSpan | undefined {
  let { start, end } = span;
  while (start < end && /\s/u.test(sourceText[start]!)) start += 1;
  while (end > start && /\s/u.test(sourceText[end - 1]!)) end -= 1;
  return start < end ? { start, end } : undefined;
}
