import type { ResolvedQuestion } from "./question-resolver.js";
import {
  analyzeObligationSource,
  type SourceIntentAtom,
} from "./obligation-semantics.js";
import {
  extractExplicitQuestionSignals,
  isTechnicalAcceptanceChecklist,
  isProductNeutralGovernanceDeliverable,
  requiresMixedKnowledgeDomains,
  taskSpecSchema,
  type KnowledgeDomain,
  type TaskSpec,
} from "./task-spec.js";

export type ObligationRisk = "low" | "high" | "prohibited";
export type ObligationEvidenceType =
  | "formal_page"
  | "version_matrix"
  | "customer_fact"
  | "policy"
  | "method";
export type AtomicObligationKind =
  | "fact"
  | "comparison"
  | "diagnosis"
  | "recommendation"
  | "procedure"
  | "risk_assessment"
  | "case_judgement";

export interface AtomicObligation {
  readonly id: `O${number}`;
  readonly sourceSpan: {
    readonly start: number;
    readonly end: number;
  };
  readonly sourceText: string;
  readonly kind: AtomicObligationKind;
  readonly targetEntityIds: readonly string[];
  readonly domains: readonly KnowledgeDomain[];
  readonly evidencePolicy: "direct" | "synthesis" | "customer_input";
  readonly evidenceTypes: readonly ObligationEvidenceType[];
  readonly risk: ObligationRisk;
  readonly completionCriteria: readonly string[];
  readonly required: true;
  readonly provenance?: "governed";
}

export interface AtomicObligationContract {
  readonly subject: string;
  readonly sourceQuestion: string;
  readonly obligations: readonly AtomicObligation[];
}

interface ObligationSeed {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly atom?: SourceIntentAtom;
}

interface TaskSpecObligation {
  readonly deliverable: TaskSpec["deliverables"][number];
  readonly obligation: TaskSpec["deliverables"][number]["obligations"][number];
}

const DIRECT_EVIDENCE_PATTERN =
  /(?:版本|数字|数量|多少|支持|兼容|适配|授权|认证|证书|协议|接口|模块|功能|能力|SLA|RPO|RTO|是否有|能否)/iu;
const CASE_JUDGEMENT_PATTERN =
  /(?:(?:判断|评估|预测).{0,28}(?:当前|现在|本次|这个|该).{0,28}(?:是否|能否|值得|赢率|胜率|成交|推进|可行|足够)|(?:当前|现在|本次|这个|该).{0,28}(?:是否|能否|值得|赢率|胜率|成交|推进|可行|足够)|应该报多少)/u;
const PROCEDURE_PATTERN =
  /(?:如何|怎样|怎么|流程|步骤|组织|实施|推进方式|评估方法|重新分工|保留升级路径|逐项对应)/u;
const SHARED_METHOD_ACTION_PATTERN =
  /(?:(?:如何|怎样|怎么|应如何).{0,160}(?:分阶段验收|关系分层|制定|转回|对应|标记|记录|组织|安排|重新分工|保留|统一|形成|转成|转为|转换)|^(?:(?:先|再|然后|随后|并)\s*)?(?:按\S{0,24})?(?:统一|重新分工|保留|记录|制定|标记|逐项对应))/u;
const TRAILING_CONSTRAINT_PATTERN = /^(?:而不是|而非|但不要|但不应|不要|避免|不得|不能)/u;
const COMPARISON_PATTERN = /(?:对比|比较|差异|区别|异同|优劣)/u;
const RECOMMENDATION_PATTERN = /(?:建议|下一步|改进|提升|优化|应当|应该)/u;
const RISK_PATTERN = /(?:风险|边界|隐患|注意事项)/u;
const DIAGNOSIS_PATTERN = /(?:诊断|分析|评估|判断|原因|为什么|为何)/u;
const PROFESSIONAL_PATTERN =
  /(?:Coremail|Exchange|Office\s*365|邮件|邮箱|归档|网关|反垃圾|迁移|版本|接口|协议|模块|授权|容灾|多活|LDAP|AD|RPO|RTO)/iu;
const CUSTOMER_INPUT_GOVERNANCE_PATTERN =
  /(?:客户(?:信息|现状|事实|输入).{0,12}(?:不足|缺失|不完整|未知)|如何推进项目|项目如何推进|售前.{0,8}(?:推进|建议))/u;
const HIGH_RISK_PATTERN =
  /(?:合同|承诺|保证|必然|认证|合规|监管|安全|权限|隐私|凭据|密码|密钥|审计|删除|导出|生产环境|SLA|价格底线|责任)/iu;
const PROHIBITED_PATTERN =
  /(?:绕过|规避|伪造|篡改|隐瞒|不留痕|未经授权|无需审批|真实密码|回扣|好处费)/iu;

export function compileAtomicObligationContract(input: {
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
}): AtomicObligationContract {
  const question = input.resolvedQuestion.standaloneQuestion;
  const taskItems = flattenTaskSpec(input.taskSpec);
  const seeds = obligationSeeds(question);
  const obligations = ensureMixedAtomicDomainCoverage(
    seeds.map((seed, index) => classifySeedWithModelTaskSpecOrDeterministicFallback(
      seed,
      index,
      question,
      input.taskSpec,
      taskItems,
    )),
    question,
  );
  const contract: AtomicObligationContract = Object.freeze({
    subject: input.taskSpec.subject,
    sourceQuestion: question,
    obligations: Object.freeze(obligations),
  });
  const validation = validateAtomicObligationContract(contract);
  if (!validation.ok) {
    throw new Error(`invalid_atomic_obligation_contract:${validation.issueCodes.join(",")}`);
  }
  return contract;
}

export function compileGovernedAtomicObligationContract(input: {
  readonly resolvedQuestion: ResolvedQuestion;
  readonly taskSpec: TaskSpec;
}): AtomicObligationContract {
  const compiled = compileAtomicObligationContract(input);
  const governed = flattenTaskSpec(input.taskSpec)
    .filter(({ deliverable, obligation }) => deliverable.required && obligation.required);
  if (governed.length === 0) return compiled;
  const question = input.resolvedQuestion.standaloneQuestion;
  const contract: AtomicObligationContract = Object.freeze({
    ...compiled,
    obligations: Object.freeze(governed.map((taskItem, index) => {
      const source = governedSourceSeed(
        question,
        taskItem,
        compiled.obligations[index] ?? compiled.obligations.at(-1)!,
      );
      const evidencePolicy = taskItem.obligation.evidencePolicy;
      const risk = deterministicRisk(source.text);
      return Object.freeze({
        id: `O${index + 1}` as const,
        sourceSpan: Object.freeze({ start: source.start, end: source.end }),
        sourceText: source.text,
        kind: taskItem.deliverable.kind,
        targetEntityIds: Object.freeze([...taskItem.obligation.targetEntityIds]),
        domains: Object.freeze([...taskItem.obligation.domains]),
        evidencePolicy,
        evidenceTypes: Object.freeze(evidenceTypes(
          source.text,
          evidencePolicy,
          risk,
        )),
        risk,
        completionCriteria: Object.freeze(completionCriteria(
          evidencePolicy,
          risk,
        )),
        required: true as const,
        provenance: "governed" as const,
      });
    })),
  });
  const validation = validateAtomicObligationContract(contract);
  if (!validation.ok) {
    throw new Error(`invalid_governed_obligation_contract:${validation.issueCodes.join(",")}`);
  }
  return contract;
}

function governedSourceSeed(
  question: string,
  taskItem: TaskSpecObligation,
  fallback: AtomicObligation,
): ObligationSeed {
  const candidates = [
    taskItem.obligation.sourceText,
    taskItem.deliverable.sourceText,
  ].filter((candidate, index, values) =>
    candidate.trim() !== "" && values.indexOf(candidate) === index);
  for (const candidate of candidates) {
    const start = question.indexOf(candidate);
    if (start >= 0) {
      return {
        start,
        end: start + candidate.length,
        text: question.slice(start, start + candidate.length),
      };
    }
  }
  return {
    start: fallback.sourceSpan.start,
    end: fallback.sourceSpan.end,
    text: fallback.sourceText,
  };
}

export function validateAtomicObligationContract(
  contract: AtomicObligationContract,
): { readonly ok: boolean; readonly issueCodes: readonly string[] } {
  const issueCodes: string[] = [];
  if (contract.obligations.length === 0) issueCodes.push("obligation_contract_empty");
  let previousEnd = -1;
  let previousProvenance: AtomicObligation["provenance"];
  for (const [index, obligation] of [...contract.obligations]
    .sort((left, right) => left.sourceSpan.start - right.sourceSpan.start)
    .entries()) {
    const { start, end } = obligation.sourceSpan;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > contract.sourceQuestion.length
    ) {
      issueCodes.push("obligation_source_span_invalid");
    } else if (contract.sourceQuestion.slice(start, end) !== obligation.sourceText) {
      issueCodes.push("obligation_source_text_mismatch");
    }
    if (
      start < previousEnd &&
      !(previousProvenance === "governed" && obligation.provenance === "governed")
    ) {
      issueCodes.push("obligation_source_span_overlap");
    }
    previousEnd = Math.max(previousEnd, end);
    previousProvenance = obligation.provenance;
    if (obligation.id !== `O${index + 1}`) {
      issueCodes.push("obligation_ids_must_be_sequential");
    }
    if (obligation.domains.length === 0 || new Set(obligation.domains).size !== obligation.domains.length) {
      issueCodes.push("obligation_domain_invalid");
    }
    if (obligation.completionCriteria.length === 0) {
      issueCodes.push("obligation_completion_criteria_missing");
    }
  }
  const ordered = stableUnique(issueCodes);
  return Object.freeze({ ok: ordered.length === 0, issueCodes: Object.freeze(ordered) });
}

export function materializeGuardedTaskSpec(input: {
  readonly original: TaskSpec;
  readonly contract: AtomicObligationContract;
}): TaskSpec {
  const knownEntityIds = new Set(input.original.entities.map((entity) => entity.id));
  return taskSpecSchema.parse({
    subject: input.contract.subject,
    entities: input.original.entities,
    deliverables: input.contract.obligations.map((obligation, index) => ({
      id: `D${index + 1}`,
      label: takeCharacters(obligation.sourceText, 256),
      kind: taskDeliverableKind(obligation.kind),
      required: true,
      sourceText: obligation.sourceText,
      obligations: [{
        id: obligation.id,
        label: takeCharacters(obligation.sourceText, 256),
        targetEntityIds: obligation.targetEntityIds.filter((id) => knownEntityIds.has(id)),
        evidencePolicy: obligation.evidencePolicy,
        evidenceCondition: {
          inputState: obligation.evidencePolicy === "customer_input"
            ? "missing"
            : "not_applicable",
          ambiguous: false,
          conflictDetected: false,
          freshness: "not_assessed",
        },
        domains: obligation.domains,
        required: true,
        sourceText: obligation.sourceText,
      }],
    })),
  });
}

function obligationSeeds(question: string): ObligationSeed[] {
  const analysis = analyzeObligationSource(question);
  let seeds = analysis.atoms
    .filter((atom) =>
      atom.kind !== "unresolved" &&
      atom.reason !== "context_premise" &&
      atom.text.trim() !== "")
    .map((atom) => trimSeedBounds(question, atom.start, atom.end, atom))
    .filter((seed): seed is ObligationSeed => seed !== undefined);
  const signals = extractExplicitQuestionSignals(question);
  const explicitSeeds: ObligationSeed[] = [];
  for (const sourceText of [
    ...signals.requestClauses,
    ...signals.independentRequestClauses,
    ...signals.requiredParallelGroups.flatMap((group) => group.items),
  ]) {
    const start = question.indexOf(sourceText);
    if (start < 0) continue;
    const end = start + sourceText.length;
    const seed = trimSeedBounds(question, start, end);
    if (seed === undefined || explicitSeeds.some((item) =>
      item.start === seed.start && item.end === seed.end)) continue;
    explicitSeeds.push(seed);
  }
  for (const explicit of explicitSeeds) {
    const overlappingAtoms = analysis.atoms.filter((atom) =>
      explicit.start < atom.end && explicit.end > atom.start);
    const overlappingSeeds = seeds.filter((seed) =>
      explicit.start < seed.end && explicit.end > seed.start);
    const shouldCoalesce = overlappingAtoms.length >= 2 ||
      overlappingAtoms.some((atom) => atom.kind === "unresolved");
    if (shouldCoalesce) {
      seeds = seeds.filter((seed) =>
        !(explicit.start < seed.end && explicit.end > seed.start));
      seeds.push(explicit);
      continue;
    }
    if (overlappingSeeds.length === 0) seeds.push(explicit);
  }
  const firstExplicitStart = explicitSeeds.reduce(
    (minimum, seed) => Math.min(minimum, seed.start),
    Number.POSITIVE_INFINITY,
  );
  seeds = seeds.filter((seed) =>
    !(explicitSeeds.length > 0 && seed.atom !== undefined && seed.end <= firstExplicitStart) &&
    !TRAILING_CONSTRAINT_PATTERN.test(seed.text));
  if (seeds.length === 0) {
    const start = question.search(/\S/u);
    const end = question.trimEnd().length;
    if (start >= 0 && end > start) seeds.push({ start, end, text: question.slice(start, end) });
  }
  return seeds.sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((seed, index, ordered) => !ordered.slice(0, index).some((earlier) =>
      seed.start >= earlier.start && seed.end <= earlier.end));
}

function trimSeedBounds(
  question: string,
  start: number,
  end: number,
  atom?: SourceIntentAtom,
): ObligationSeed | undefined {
  const source = question.slice(start, end);
  const leading = source.match(/^[\s：:，,；;。！？!?、]+/u)?.[0].length ?? 0;
  const trailing = source.match(/[\s：:，,；;。！？!?、]+$/u)?.[0].length ?? 0;
  const boundedStart = start + leading;
  const boundedEnd = end - trailing;
  if (boundedEnd <= boundedStart) return undefined;
  return {
    start: boundedStart,
    end: boundedEnd,
    text: question.slice(boundedStart, boundedEnd),
    ...(atom === undefined ? {} : { atom }),
  };
}

function classifySeedWithModelTaskSpecOrDeterministicFallback(
  seed: ObligationSeed,
  index: number,
  question: string,
  taskSpec: TaskSpec,
  taskItems: readonly TaskSpecObligation[],
): AtomicObligation {
  const matched = bestTaskSpecMatch(seed.text, taskItems);
  const source = refinedSourceSeed(seed, question, matched);
  const kind = deterministicKind(source.text, matched?.deliverable.kind);
  const evidencePolicy = deterministicEvidencePolicy(source.text, kind, matched);
  const domains = deterministicDomains(
    source.text,
    question,
    kind,
    evidencePolicy,
    matched,
    stableUnique(taskItems
      .filter(({ deliverable, obligation }) => deliverable.required && obligation.required)
      .flatMap(({ obligation }) => obligation.domains)),
  );
  const risk = deterministicRisk(source.text);
  const targetEntityIds = matched?.obligation.targetEntityIds ?? taskSpec.entities
    .filter((entity) => normalize(source.text).includes(normalize(entity.sourceText)))
    .map((entity) => entity.id);
  return Object.freeze({
    id: `O${index + 1}`,
    sourceSpan: Object.freeze({ start: source.start, end: source.end }),
    sourceText: source.text,
    kind,
    targetEntityIds: Object.freeze([...targetEntityIds]),
    domains: Object.freeze(domains),
    evidencePolicy,
    evidenceTypes: Object.freeze(evidenceTypes(source.text, evidencePolicy, risk)),
    risk,
    completionCriteria: Object.freeze(completionCriteria(evidencePolicy, risk)),
    required: true,
  });
}

function refinedSourceSeed(
  seed: ObligationSeed,
  question: string,
  matched: TaskSpecObligation | undefined,
): ObligationSeed {
  if (matched === undefined) return seed;
  const candidates = [
    matched.obligation.sourceText,
    matched.deliverable.sourceText,
  ].filter((candidate, index, values) =>
    candidate.trim() !== "" && values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    const relativeStart = seed.text.indexOf(candidate);
    if (relativeStart < 0) continue;
    const start = seed.start + relativeStart;
    return {
      start,
      end: start + candidate.length,
      text: question.slice(start, start + candidate.length),
      ...(seed.atom === undefined ? {} : { atom: seed.atom }),
    };
  }
  return seed;
}

function flattenTaskSpec(taskSpec: TaskSpec): TaskSpecObligation[] {
  return taskSpec.deliverables.flatMap((deliverable) =>
    deliverable.obligations.map((obligation) => ({ deliverable, obligation })));
}

function bestTaskSpecMatch(
  seedText: string,
  items: readonly TaskSpecObligation[],
): TaskSpecObligation | undefined {
  const seed = normalize(seedText);
  const sourceContained = items
    .map((item) => ({ item, source: normalize(item.obligation.sourceText) }))
    .filter(({ source }) =>
      source.length > 0 && seed.length > 0 &&
      (source.includes(seed) || seed.includes(source)))
    .sort((left, right) =>
      Math.abs(left.source.length - seed.length) -
        Math.abs(right.source.length - seed.length));
  if (sourceContained.length > 0) return sourceContained[0]!.item;
  let best: { readonly item: TaskSpecObligation; readonly score: number } | undefined;
  for (const item of items) {
    const source = normalize(item.obligation.sourceText);
    const label = normalize(item.obligation.label);
    const score = Math.max(semanticMatchScore(seed, source), semanticMatchScore(seed, label));
    if (score < 0.35 || (best !== undefined && score <= best.score)) continue;
    best = { item, score };
  }
  return best?.item;
}

function deterministicKind(
  text: string,
  matchedKind?: TaskSpec["deliverables"][number]["kind"],
): AtomicObligationKind {
  if (CASE_JUDGEMENT_PATTERN.test(text)) return "case_judgement";
  if (COMPARISON_PATTERN.test(text)) return "comparison";
  if (PROCEDURE_PATTERN.test(text)) return "procedure";
  if (RECOMMENDATION_PATTERN.test(text)) return "recommendation";
  if (RISK_PATTERN.test(text)) return "risk_assessment";
  if (DIAGNOSIS_PATTERN.test(text)) return "diagnosis";
  return matchedKind ?? "fact";
}

function deterministicEvidencePolicy(
  text: string,
  kind: AtomicObligationKind,
  matched: TaskSpecObligation | undefined,
): AtomicObligation["evidencePolicy"] {
  if (kind === "case_judgement") return "customer_input";
  if (kind === "procedure" && SHARED_METHOD_ACTION_PATTERN.test(text)) return "synthesis";
  const sourceAnalysis = analyzeObligationSource(text);
  const containsDefaultProtectedFact = sourceAnalysis.atoms.some((atom) =>
    atom.kind === "protected_fact" && atom.reason === "default_fact");
  const containsExplicitSynthesis = sourceAnalysis.atoms.some((atom) =>
    atom.kind === "synthesis");
  if (
    DIRECT_EVIDENCE_PATTERN.test(text) ||
    (
      sourceAnalysis.requiresDirectEvidence &&
      containsDefaultProtectedFact &&
      !containsExplicitSynthesis
    )
  ) {
    return "direct";
  }
  if (["procedure", "recommendation", "diagnosis", "risk_assessment"].includes(kind)) {
    return "synthesis";
  }
  return matched?.obligation.evidencePolicy ?? "direct";
}

function deterministicDomains(
  text: string,
  question: string,
  kind: AtomicObligationKind,
  evidencePolicy: AtomicObligation["evidencePolicy"],
  matched: TaskSpecObligation | undefined,
  fallbackDomains: readonly KnowledgeDomain[],
): KnowledgeDomain[] {
  const stableFallbackDomains = stableUnique(fallbackDomains);
  if (
    stableFallbackDomains.length === 1 &&
    stableFallbackDomains[0] === "coremail-professional" &&
    isTechnicalAcceptanceChecklist(question)
  ) {
    return [...stableFallbackDomains];
  }
  const professional = PROFESSIONAL_PATTERN.test(text);
  const general = evidencePolicy === "customer_input" ||
    CUSTOMER_INPUT_GOVERNANCE_PATTERN.test(text) ||
    isProductNeutralGovernanceDeliverable(text) ||
    (
      isProductNeutralGovernanceDeliverable(question) &&
      !professional &&
      ["procedure", "recommendation", "diagnosis", "risk_assessment"]
        .includes(kind)
    );
  if (professional && general) {
    return ["coremail-professional", "presales-general"];
  }
  if (professional) return ["coremail-professional"];
  if (general) return ["presales-general"];
  if (matched !== undefined) return [...matched.obligation.domains];
  if (["procedure", "recommendation", "diagnosis", "risk_assessment"].includes(kind)) {
    return ["presales-general"];
  }
  if (fallbackDomains.length > 0) return [...fallbackDomains];
  return PROFESSIONAL_PATTERN.test(question)
    ? ["coremail-professional"]
    : ["presales-general"];
}

function ensureMixedAtomicDomainCoverage(
  obligations: readonly AtomicObligation[],
  question: string,
): AtomicObligation[] {
  if (!requiresMixedKnowledgeDomains(question)) {
    return [...obligations];
  }
  const expectedDomains = [
    "coremail-professional",
    "presales-general",
  ] as const satisfies readonly KnowledgeDomain[];
  const output = [...obligations];
  for (const missingDomain of expectedDomains.filter((domain) =>
    !output.some((obligation) => obligation.domains.includes(domain)))) {
    let preferredIndex = output.findIndex((obligation) =>
      missingDomain === "coremail-professional"
        ? PROFESSIONAL_PATTERN.test(obligation.sourceText)
        : obligation.evidencePolicy === "customer_input" ||
          isProductNeutralGovernanceDeliverable(obligation.sourceText));
    if (preferredIndex < 0) {
      preferredIndex = output.findIndex((obligation) =>
        missingDomain === "coremail-professional"
          ? obligation.evidencePolicy === "direct"
          : obligation.evidencePolicy === "synthesis");
    }
    if (preferredIndex < 0) preferredIndex = 0;
    const obligation = output[preferredIndex];
    if (obligation === undefined) continue;
    const domains = (["coremail-professional", "presales-general"] as const)
      .filter((domain) => obligation.domains.includes(domain) || domain === missingDomain);
    output[preferredIndex] = Object.freeze({
      ...obligation,
      domains: Object.freeze(domains),
    });
  }
  return output;
}

function deterministicRisk(text: string): ObligationRisk {
  if (PROHIBITED_PATTERN.test(text)) return "prohibited";
  return HIGH_RISK_PATTERN.test(text) ? "high" : "low";
}

function evidenceTypes(
  text: string,
  policy: AtomicObligation["evidencePolicy"],
  risk: ObligationRisk,
): ObligationEvidenceType[] {
  if (risk === "prohibited") return ["policy"];
  if (policy === "customer_input") return ["customer_fact"];
  if (policy === "synthesis") return risk === "high" ? ["method", "policy"] : ["method"];
  return /(?:版本|兼容|适配|升级矩阵|支持矩阵)/u.test(text)
    ? ["version_matrix"]
    : ["formal_page"];
}

function completionCriteria(
  policy: AtomicObligation["evidencePolicy"],
  risk: ObligationRisk,
): string[] {
  const criteria = policy === "customer_input"
    ? ["customer_input_available", "claim_supported"]
    : ["claim_supported", "all_required_aspects_covered"];
  if (risk === "high") criteria.push("high_risk_consensus");
  if (risk === "prohibited") return ["fixed_refusal_contract_complete"];
  return criteria;
}

function taskDeliverableKind(
  kind: AtomicObligationKind,
): TaskSpec["deliverables"][number]["kind"] {
  return kind === "case_judgement" ? "diagnosis" : kind;
}

function semanticMatchScore(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  const shared = [...leftPairs].filter((pair) => rightPairs.has(pair)).length;
  return shared / Math.max(1, Math.min(leftPairs.size, rightPairs.size));
}

function bigrams(value: string): Set<string> {
  const chars = [...value];
  if (chars.length < 2) return new Set(chars);
  return new Set(chars.slice(0, -1).map((char, index) =>
    `${char}${chars[index + 1] ?? ""}`));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function takeCharacters(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function stableUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
