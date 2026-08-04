import {
  finalActionSchema,
  referenceSchema,
  type FinalAction,
  type Reference,
  type RequirementCoverage,
} from "./contracts.js";
import {
  KNOWLEDGE_DOMAIN_ORDER,
  type DomainKnowledgePlan,
  type DomainRequirementBinding,
} from "./domain-plan.js";
import type { KnowledgeDomain } from "./task-spec.js";
import {
  coverageVerificationReport,
  type CoverageVerificationDetail,
  type CoverageVerificationReport,
} from "./coverage-verifier.js";
import {
  coverageGapSchema,
  type CoverageGap,
} from "./coverage-gap.js";
import type { EvidenceLedger } from "./evidence-ledger.js";

export interface DetailedDomainResult {
  readonly domain: KnowledgeDomain;
  readonly project: Reference["project"];
  readonly revision: string;
  readonly action: FinalAction;
  readonly references: readonly Reference[];
  readonly verification?: CoverageVerificationReport;
  readonly evidenceLedger?: EvidenceLedger;
  readonly coverageGaps?: readonly CoverageGap[];
}

export interface MergedDomainBinding extends DomainRequirementBinding {
  readonly globalRequirementId: RequirementCoverage["id"];
}

export interface MergedDomainAnswer {
  readonly action: FinalAction;
  readonly references: readonly Reference[];
  readonly domainsUsed: readonly KnowledgeDomain[];
  readonly bindings: readonly MergedDomainBinding[];
  readonly verification?: CoverageVerificationReport;
  readonly domainEvidenceLedgers?: readonly EvidenceLedger[];
  readonly coverageGaps?: readonly CoverageGap[];
}

export class DomainAnswerMergeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DomainAnswerMergeError";
  }
}

export function mergeDetailedDomainResults(input: {
  readonly plans: readonly DomainKnowledgePlan[];
  readonly results: readonly DetailedDomainResult[];
}): MergedDomainAnswer {
  const planByDomain = uniqueByDomain(input.plans, "duplicate_domain_plan");
  const resultByDomain = uniqueByDomain(input.results, "duplicate_domain_result");
  if (
    planByDomain.size === 0 ||
    planByDomain.size !== resultByDomain.size ||
    [...planByDomain.keys()].some((domain) => !resultByDomain.has(domain))
  ) {
    throw new DomainAnswerMergeError("domain_result_mismatch");
  }

  const domainsUsed = KNOWLEDGE_DOMAIN_ORDER.filter((domain) => planByDomain.has(domain));
  const localContexts = new Map<KnowledgeDomain, LocalDomainContext>();
  for (const domain of domainsUsed) {
    localContexts.set(
      domain,
      validateLocalDomain(planByDomain.get(domain)!, resultByDomain.get(domain)!),
    );
  }

  const orderedBindings = domainsUsed.flatMap((domain) => {
    const plan = planByDomain.get(domain)!;
    return plan.bindings.map((binding, localIndex) => ({ plan, binding, localIndex }));
  }).sort((left, right) =>
    left.binding.order - right.binding.order ||
    domainRank(left.binding.domain) - domainRank(right.binding.domain));
  validateBindingOrder(orderedBindings.map(({ binding }) => binding));
  if (orderedBindings.length === 0 || orderedBindings.length > 6) {
    throw new DomainAnswerMergeError("merged_requirement_limit_exceeded");
  }

  const references: Reference[] = [];
  const globalIndexByIdentity = new Map<string, number>();
  const titleByIdentity = new Map<string, string>();
  const mergedRequirements: RequirementCoverage[] = [];
  const mergedBindings: MergedDomainBinding[] = [];
  const globalRequirementIdByLocal = new Map<string, RequirementCoverage["id"]>();

  for (const [globalIndex, item] of orderedBindings.entries()) {
    const context = localContexts.get(item.binding.domain)!;
    const localRequirement = context.result.action.requirements[item.localIndex]!;
    const citationMap = (localCitation: number): number => {
      const localReference = context.referenceByIndex.get(localCitation);
      if (localReference === undefined) {
        throw new DomainAnswerMergeError("unknown_local_citation");
      }
      const identity = referenceIdentity(localReference);
      const existingTitle = titleByIdentity.get(identity);
      if (existingTitle !== undefined && existingTitle !== localReference.title) {
        throw new DomainAnswerMergeError("reference_metadata_conflict");
      }
      const existingIndex = globalIndexByIdentity.get(identity);
      if (existingIndex !== undefined) return existingIndex;
      const nextIndex = references.length + 1;
      references.push({ ...localReference, index: nextIndex });
      globalIndexByIdentity.set(identity, nextIndex);
      titleByIdentity.set(identity, localReference.title);
      return nextIndex;
    };

    const rewritten = rewriteRequirement(
      localRequirement,
      `R${globalIndex + 1}` as RequirementCoverage["id"],
      citationMap,
    );
    mergedRequirements.push(rewritten);
    mergedBindings.push({
      ...item.binding,
      globalRequirementId: rewritten.id,
    });
    globalRequirementIdByLocal.set(
      localRequirementKey(item.binding.domain, item.binding.requirementId),
      rewritten.id,
    );
  }

  const action: FinalAction = {
    action: "final",
    requirements: mergedRequirements,
    citations: stableUnique(mergedRequirements.flatMap(requirementCitationUnion)),
  };
  const parsed = finalActionSchema.safeParse(action);
  if (!parsed.success || action.citations.length > 20 || references.length > 20) {
    throw new DomainAnswerMergeError("merged_action_contract_exceeded");
  }

  const metadata = mergeEvidenceMetadata({
    domainsUsed,
    planByDomain,
    localContexts,
    orderedBindings,
    globalRequirementIdByLocal,
    globalIndexByIdentity,
  });
  return {
    action,
    references,
    domainsUsed,
    bindings: mergedBindings,
    ...metadata,
  };
}

function mergeEvidenceMetadata(input: {
  readonly domainsUsed: readonly KnowledgeDomain[];
  readonly planByDomain: ReadonlyMap<KnowledgeDomain, DomainKnowledgePlan>;
  readonly localContexts: ReadonlyMap<KnowledgeDomain, LocalDomainContext>;
  readonly orderedBindings: readonly {
    readonly plan: DomainKnowledgePlan;
    readonly binding: DomainRequirementBinding;
    readonly localIndex: number;
  }[];
  readonly globalRequirementIdByLocal: ReadonlyMap<
    string,
    RequirementCoverage["id"]
  >;
  readonly globalIndexByIdentity: ReadonlyMap<string, number>;
}): Pick<
  MergedDomainAnswer,
  "verification" | "domainEvidenceLedgers" | "coverageGaps"
> {
  const results = input.domainsUsed.map((domain) =>
    input.localContexts.get(domain)!.result);
  const verificationAvailable = allOrNoneMetadata(
    results.map((result) => result.verification),
  );
  const ledgersAvailable = allOrNoneMetadata(
    results.map((result) => result.evidenceLedger),
  );
  const gapsAvailable = allOrNoneMetadata(
    results.map((result) => result.coverageGaps),
  );
  const metadataFieldCount = [
    verificationAvailable,
    ledgersAvailable,
    gapsAvailable,
  ].filter(Boolean).length;
  if (metadataFieldCount !== 0 && metadataFieldCount !== 3) {
    throw new DomainAnswerMergeError("evidence_metadata_incomplete");
  }

  const domainEvidenceLedgers = ledgersAvailable
    ? input.domainsUsed.map((domain) => {
        const context = input.localContexts.get(domain)!;
        const plan = input.planByDomain.get(domain)!;
        const ledger = context.result.evidenceLedger!;
        validateLocalEvidenceLedger(plan, context.result, ledger);
        return ledger;
      })
    : undefined;

  const verification = verificationAvailable
    ? mergeVerificationReports(
        input.orderedBindings,
        input.localContexts,
        input.globalIndexByIdentity,
      )
    : undefined;
  const coverageGaps = gapsAvailable
    ? mergeCoverageGaps(
        input.orderedBindings,
        input.localContexts,
        input.globalRequirementIdByLocal,
      )
    : undefined;
  return {
    ...(verification === undefined ? {} : { verification }),
    ...(domainEvidenceLedgers === undefined
      ? {}
      : { domainEvidenceLedgers: Object.freeze(domainEvidenceLedgers) }),
    ...(coverageGaps === undefined ? {} : { coverageGaps }),
  };
}

function allOrNoneMetadata<T>(values: readonly (T | undefined)[]): boolean {
  const count = values.filter((value) => value !== undefined).length;
  if (count !== 0 && count !== values.length) {
    throw new DomainAnswerMergeError("evidence_metadata_mismatch");
  }
  return count === values.length && values.length > 0;
}

function validateLocalEvidenceLedger(
  plan: DomainKnowledgePlan,
  result: DetailedDomainResult,
  ledger: EvidenceLedger,
): void {
  if (
    ledger.project !== result.project ||
    ledger.revision !== result.revision ||
    ledger.units.length !== plan.bindings.length
  ) {
    throw new DomainAnswerMergeError("evidence_ledger_snapshot_mismatch");
  }
  for (let index = 0; index < plan.bindings.length; index += 1) {
    const binding = plan.bindings[index]!;
    const unit = ledger.units[index];
    const requirement = result.action.requirements[index];
    if (
      unit === undefined ||
      requirement === undefined ||
      !sameBinding(unit.binding, binding) ||
      unit.requirement.id !== binding.requirementId ||
      unit.verification.coverage !== requirement.coverage
    ) {
      throw new DomainAnswerMergeError("evidence_ledger_binding_mismatch");
    }
  }
}

function mergeVerificationReports(
  orderedBindings: readonly {
    readonly binding: DomainRequirementBinding;
    readonly localIndex: number;
  }[],
  contexts: ReadonlyMap<KnowledgeDomain, LocalDomainContext>,
  globalIndexByIdentity: ReadonlyMap<string, number>,
): CoverageVerificationReport {
  for (const context of contexts.values()) {
    validateLocalVerification(context.result);
  }
  const summaries: CoverageVerificationDetail[] = [];
  const coveredRequirementIds: RequirementCoverage["id"][] = [];
  const missingRequirementIds: RequirementCoverage["id"][] = [];
  for (const [globalIndex, item] of orderedBindings.entries()) {
    const globalId = `R${globalIndex + 1}` as RequirementCoverage["id"];
    const context = contexts.get(item.binding.domain)!;
    const localRequirement = context.result.action.requirements[item.localIndex]!;
    const summary = context.result.verification!.summaries[item.localIndex]!;
    summaries.push({
      ...summary,
      id: globalId,
      claimDecisions: summary.claimDecisions.map((decision) => ({
        ...decision,
        citations: stableUnique(decision.citations.flatMap((citation) => {
          const localReference = context.referenceByIndex.get(citation);
          if (localReference === undefined) {
            if (decision.status === "removed") return [];
            throw new DomainAnswerMergeError("verification_citation_mismatch");
          }
          const globalCitation = globalIndexByIdentity.get(
            referenceIdentity(localReference),
          );
          if (globalCitation === undefined) {
            throw new DomainAnswerMergeError("verification_citation_mismatch");
          }
          return [globalCitation];
        })),
      })),
    });
    if (localRequirement.coverage !== "none") coveredRequirementIds.push(globalId);
    if (localRequirement.coverage !== "complete") missingRequirementIds.push(globalId);
  }
  return Object.freeze({
    summaries: Object.freeze(summaries),
    coveredRequirementIds: Object.freeze(coveredRequirementIds),
    missingRequirementIds: Object.freeze(missingRequirementIds),
  });
}

function validateLocalVerification(result: DetailedDomainResult): void {
  const report = result.verification;
  if (report === undefined || report.summaries.length !== result.action.requirements.length) {
    throw new DomainAnswerMergeError("verification_metadata_mismatch");
  }
  const expectedCovered = result.action.requirements.flatMap((requirement) =>
    requirement.coverage === "none" ? [] : [requirement.id]);
  const expectedMissing = result.action.requirements.flatMap((requirement) =>
    requirement.coverage === "complete" ? [] : [requirement.id]);
  if (
    !sameStrings(report.coveredRequirementIds, expectedCovered) ||
    !sameStrings(report.missingRequirementIds, expectedMissing) ||
    report.summaries.some((summary, index) =>
      summary.id !== result.action.requirements[index]?.id)
  ) {
    throw new DomainAnswerMergeError("verification_metadata_mismatch");
  }
  try {
    coverageVerificationReport(result.action, report.summaries);
  } catch {
    throw new DomainAnswerMergeError("verification_metadata_mismatch");
  }
}

function mergeCoverageGaps(
  orderedBindings: readonly {
    readonly binding: DomainRequirementBinding;
  }[],
  contexts: ReadonlyMap<KnowledgeDomain, LocalDomainContext>,
  globalRequirementIdByLocal: ReadonlyMap<string, RequirementCoverage["id"]>,
): readonly CoverageGap[] {
  const merged: CoverageGap[] = [];
  for (const item of orderedBindings) {
    const context = contexts.get(item.binding.domain)!;
    const localGaps = context.result.coverageGaps!
      .filter((gap) => gap.requirementId === item.binding.requirementId)
      .sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
    for (const gap of localGaps) {
      if (
        !coverageGapSchema.safeParse(gap).success ||
        gap.domain !== item.binding.domain ||
        gap.deliverableId !== item.binding.deliverableId ||
        gap.obligationId !== item.binding.obligationId
      ) {
        throw new DomainAnswerMergeError("coverage_gap_binding_mismatch");
      }
      const requirementId = globalRequirementIdByLocal.get(
        localRequirementKey(item.binding.domain, item.binding.requirementId),
      );
      if (requirementId === undefined) {
        throw new DomainAnswerMergeError("coverage_gap_binding_mismatch");
      }
      merged.push(Object.freeze(coverageGapSchema.parse({
        ...gap,
        id: `G${merged.length + 1}`,
        requirementId,
      })));
    }
  }
  const sourceGapCount = [...contexts.values()].reduce(
    (count, context) => count + context.result.coverageGaps!.length,
    0,
  );
  if (sourceGapCount !== merged.length) {
    throw new DomainAnswerMergeError("coverage_gap_binding_mismatch");
  }
  return Object.freeze(merged);
}

function sameBinding(
  left: DomainRequirementBinding,
  right: DomainRequirementBinding,
): boolean {
  return left.domain === right.domain &&
    left.requirementId === right.requirementId &&
    left.deliverableId === right.deliverableId &&
    left.obligationId === right.obligationId &&
    left.order === right.order;
}

function localRequirementKey(
  domain: KnowledgeDomain,
  requirementId: string,
): string {
  return `${domain}\u0000${requirementId}`;
}

interface LocalDomainContext {
  readonly result: DetailedDomainResult;
  readonly referenceByIndex: ReadonlyMap<number, Reference>;
}

function validateLocalDomain(
  plan: DomainKnowledgePlan,
  result: DetailedDomainResult,
): LocalDomainContext {
  if (result.domain !== plan.domain || result.project !== plan.domain || !result.revision.trim()) {
    throw new DomainAnswerMergeError("snapshot_mismatch");
  }
  if (
    plan.bindings.length !== plan.plan.requirements.length ||
    result.action.requirements.length !== plan.bindings.length
  ) {
    throw new DomainAnswerMergeError("requirement_binding_mismatch");
  }
  for (let index = 0; index < plan.bindings.length; index += 1) {
    const expectedId = plan.bindings[index]!.requirementId;
    if (
      plan.plan.requirements[index]?.id !== expectedId ||
      result.action.requirements[index]?.id !== expectedId ||
      plan.bindings[index]!.domain !== plan.domain
    ) {
      throw new DomainAnswerMergeError("requirement_binding_mismatch");
    }
  }
  if (!finalActionSchema.safeParse(result.action).success) {
    throw new DomainAnswerMergeError("invalid_local_action");
  }

  const referenceByIndex = new Map<number, Reference>();
  for (const [index, reference] of result.references.entries()) {
    if (
      !referenceSchema.safeParse(reference).success ||
      reference.index !== index + 1 ||
      reference.project !== result.project ||
      reference.revision !== result.revision
    ) {
      throw new DomainAnswerMergeError("snapshot_mismatch");
    }
    referenceByIndex.set(reference.index, reference);
  }
  validateLocalCitations(result.action, referenceByIndex);
  return { result, referenceByIndex };
}

function validateLocalCitations(
  action: FinalAction,
  referenceByIndex: ReadonlyMap<number, Reference>,
): void {
  for (const requirement of action.requirements) {
    validateCitationCarrier(requirement.answer, requirement.citations, referenceByIndex);
    if (
      (requirement.coverage === "none" && requirement.citations.length > 0) ||
      (requirement.coverage !== "none" && requirement.citations.length === 0) ||
      (requirement.coverage !== "none" && requirement.relatedContext !== undefined)
    ) {
      throw new DomainAnswerMergeError("invalid_local_coverage");
    }
    for (const related of requirement.relatedContext ?? []) {
      validateCitationCarrier(related.statement, related.citations, referenceByIndex);
    }
  }
  const union = stableUnique(action.requirements.flatMap(requirementCitationUnion));
  if (!sameNumbers(union, action.citations)) {
    throw new DomainAnswerMergeError("citation_union_mismatch");
  }
  for (const citation of action.citations) {
    if (!referenceByIndex.has(citation)) {
      throw new DomainAnswerMergeError("unknown_local_citation");
    }
  }
}

function validateCitationCarrier(
  text: string,
  citations: readonly number[],
  referenceByIndex: ReadonlyMap<number, Reference>,
): void {
  if (new Set(citations).size !== citations.length) {
    throw new DomainAnswerMergeError("duplicate_local_citation");
  }
  if (citations.some((citation) => !referenceByIndex.has(citation))) {
    throw new DomainAnswerMergeError("unknown_local_citation");
  }
  const embedded = stableUnique(
    [...text.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
  );
  if (!sameNumberSet(embedded, citations)) {
    throw new DomainAnswerMergeError("citation_metadata_mismatch");
  }
}

function rewriteRequirement(
  requirement: RequirementCoverage,
  id: RequirementCoverage["id"],
  citationMap: (index: number) => number,
): RequirementCoverage {
  const citations = stableUnique(requirement.citations.map(citationMap));
  const relatedContext = requirement.relatedContext?.map((related) => ({
    statement: rewriteCitationText(related.statement, citationMap),
    citations: stableUnique(related.citations.map(citationMap)),
  }));
  return {
    id,
    coverage: requirement.coverage,
    answer: rewriteCitationText(requirement.answer, citationMap),
    citations,
    ...(relatedContext === undefined ? {} : { relatedContext }),
  };
}

function rewriteCitationText(value: string, citationMap: (index: number) => number): string {
  return value.replace(/\[(\d+)\]/gu, (_match, index: string) =>
    `[${citationMap(Number(index))}]`);
}

function requirementCitationUnion(requirement: RequirementCoverage): readonly number[] {
  return [
    ...requirement.citations,
    ...(requirement.relatedContext ?? []).flatMap((related) => related.citations),
  ];
}

function validateBindingOrder(bindings: readonly DomainRequirementBinding[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index]!;
    const key = `${binding.domain}\u0000${binding.obligationId}`;
    if (seen.has(key)) throw new DomainAnswerMergeError("duplicate_obligation_binding");
    seen.add(key);
    const previous = bindings[index - 1];
    if (
      previous !== undefined &&
      previous.order === binding.order &&
      (previous.obligationId !== binding.obligationId ||
        previous.deliverableId !== binding.deliverableId)
    ) {
      throw new DomainAnswerMergeError("binding_order_conflict");
    }
  }
}

function uniqueByDomain<T extends { readonly domain: KnowledgeDomain }>(
  values: readonly T[],
  errorCode: string,
): Map<KnowledgeDomain, T> {
  const result = new Map<KnowledgeDomain, T>();
  for (const value of values) {
    if (result.has(value.domain)) throw new DomainAnswerMergeError(errorCode);
    result.set(value.domain, value);
  }
  return result;
}

function referenceIdentity(reference: Reference): string {
  return [
    reference.project,
    reference.revision,
    reference.path,
    reference.contentHash,
  ].join("\u0000");
}

function domainRank(domain: KnowledgeDomain): number {
  return KNOWLEDGE_DOMAIN_ORDER.indexOf(domain);
}

function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
