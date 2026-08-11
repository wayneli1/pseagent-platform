import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerCardSchema,
  answerCardCatalogSchema,
  catalogDomainSnapshotSchema,
  knowledgeDomainSchema,
  questionFamilySchema,
  type AnswerCardCatalog,
  type AnswerCard,
  type KnowledgeDomain,
  type QuestionFamily,
} from "@pseagent/knowledge-governance-contracts";
import { z } from "zod";

export { answerCardCatalogSchema } from "@pseagent/knowledge-governance-contracts";
export type { AnswerCardCatalog } from "@pseagent/knowledge-governance-contracts";

export interface ActiveAnswerCardCatalog {
  readonly schemaVersion: 1;
  readonly domains: readonly z.infer<typeof catalogDomainSnapshotSchema>[];
  readonly cards: readonly AnswerCard[];
  readonly families: readonly QuestionFamily[];
}

export class AnswerCardRegistryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AnswerCardRegistryError";
  }
}

export class AnswerCardRegistry {
  readonly catalogHash: string;
  readonly catalog: ActiveAnswerCardCatalog;
  readonly activeCardCount: number;
  private readonly snapshotByDomain: ReadonlyMap<
    KnowledgeDomain,
    z.infer<typeof catalogDomainSnapshotSchema>
  >;
  private readonly cardById: ReadonlyMap<string, AnswerCard>;
  private readonly exactCardByQuestion: ReadonlyMap<string, AnswerCard>;
  private readonly activeFamilies: readonly QuestionFamily[];

  constructor(source: unknown) {
    const parsed = answerCardCatalogSchema.safeParse(source);
    if (!parsed.success) {
      throw new AnswerCardRegistryError("invalid_answer_card_catalog");
    }
    this.catalog = Object.freeze({
      schemaVersion: 1,
      domains: Object.freeze(parsed.data.domains),
      cards: Object.freeze(parsed.data.cards),
      families: Object.freeze(parsed.data.families),
    });
    this.catalogHash = createHash("sha256")
      .update(stableJson(this.catalog), "utf8")
      .digest("hex");

    const snapshots = uniqueMap(
      this.catalog.domains,
      (snapshot) => snapshot.domain,
      "duplicate_catalog_domain",
    );
    if (
      snapshots.size !== knowledgeDomainSchema.options.length ||
      knowledgeDomainSchema.options.some((domain) => !snapshots.has(domain))
    ) {
      throw new AnswerCardRegistryError("catalog_domains_incomplete");
    }
    this.snapshotByDomain = snapshots;

    const cards = uniqueMap(
      this.catalog.cards,
      (card) => card.cardId,
      "duplicate_answer_card_id",
    );
    this.cardById = cards;
    const exactCards = new Map<string, AnswerCard>();
    const activeCards = this.catalog.cards.filter(isCardActive);
    this.activeCardCount = activeCards.length;
    for (const card of activeCards) {
      for (const question of [card.canonicalQuestion, ...card.aliases]) {
        const key = normalizeQuestion(question);
        if (key === "") {
          throw new AnswerCardRegistryError("empty_answer_card_question");
        }
        const existing = exactCards.get(key);
        if (existing !== undefined && existing.cardId !== card.cardId) {
          throw new AnswerCardRegistryError("duplicate_exact_answer_card_question");
        }
        exactCards.set(key, card);
      }
    }
    this.exactCardByQuestion = exactCards;

    const families = uniqueMap(
      this.catalog.families,
      (family) => family.familyId,
      "duplicate_question_family_id",
    );
    for (const family of families.values()) {
      if (!isReviewStatusActive(family.reviewStatus)) continue;
      const bindingKeys = new Set<string>();
      for (const binding of family.bindings) {
        const card = cards.get(binding.cardId);
        const key = binding.obligationId;
        if (
          card === undefined ||
          card.domain !== binding.domain ||
          !isCardActive(card) ||
          !card.obligations.some((obligation) =>
            obligation.id === binding.cardObligationId &&
            obligation.domains.includes(binding.domain))
        ) {
          throw new AnswerCardRegistryError("question_family_binding_invalid");
        }
        if (bindingKeys.has(key)) {
          throw new AnswerCardRegistryError("duplicate_question_family_binding");
        }
        bindingKeys.add(key);
      }
    }
    this.activeFamilies = Object.freeze(
      [...families.values()].filter((family) => isReviewStatusActive(family.reviewStatus)),
    );
  }

  exactCard(question: string): AnswerCard | undefined {
    return this.exactCardByQuestion.get(normalizeQuestion(question));
  }

  assertHasActiveCards(): void {
    if (this.activeCardCount === 0) {
      throw new AnswerCardRegistryError("answer_card_catalog_has_no_active_cards");
    }
  }

  familyCandidates(
    question: string,
    currentDomain: KnowledgeDomain,
    limit = 5,
  ): readonly QuestionFamily[] {
    const applicable = this.activeFamilies
      .filter((family) => family.bindings.some((binding) =>
        binding.domain === currentDomain))
      .filter((family) => family.bindings
        .filter((binding) => binding.required)
        .every((binding) => this.familyCardApplicable(binding.cardId, question)));
    const surfaceCandidates = applicable.map((family) => ({
      family,
      score: familySurfaceSimilarity(question, family),
    }))
      .filter((candidate) => candidate.score >= 0.12)
      .sort((left, right) =>
        right.score - left.score || left.family.familyId.localeCompare(right.family.familyId));
    const selected = surfaceCandidates.slice(0, limit).map((candidate) => candidate.family);
    if (selected.length >= limit) return selected;

    const selectedIds = new Set(selected.map((family) => family.familyId));
    const conceptCandidates = applicable.map((family) => ({
      family,
      score: familyConceptSimilarity(question, family, this.cardById),
    }))
      .filter((candidate) =>
        candidate.score >= 0.12 && !selectedIds.has(candidate.family.familyId))
      .sort((left, right) =>
        right.score - left.score || left.family.familyId.localeCompare(right.family.familyId));
    for (const candidate of conceptCandidates) {
      selected.push(candidate.family);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  deterministicFamilyCandidate(
    question: string,
    currentDomain: KnowledgeDomain,
  ): QuestionFamily | undefined {
    const ranked = this.activeFamilies
      .filter((family) => family.bindings.some((binding) =>
        binding.domain === currentDomain))
      .filter((family) => family.bindings
        .filter((binding) => binding.required)
        .every((binding) => this.familyCardApplicable(binding.cardId, question)))
      .map((family) => ({
        family,
        score: familySurfaceSimilarity(question, family),
      }))
      .sort((left, right) =>
        right.score - left.score || left.family.familyId.localeCompare(right.family.familyId));
    const best = ranked[0];
    if (best === undefined || best.score < 0.55) return undefined;
    if (best.family.bindings.filter((binding) => binding.required).length > 2) {
      return undefined;
    }
    const runnerUp = ranked[1];
    if (runnerUp !== undefined && best.score - runnerUp.score < 0.25) {
      return undefined;
    }
    return best.family;
  }

  trustedSurfaceFamilyCandidate(
    question: string,
    currentDomain: KnowledgeDomain,
  ): QuestionFamily | undefined {
    const ranked = this.activeFamilies
      .filter((family) => family.bindings.some((binding) =>
        binding.domain === currentDomain))
      .filter((family) => family.bindings
        .filter((binding) => binding.required)
        .every((binding) => this.familyCardApplicable(binding.cardId, question)))
      .map((family) => ({
        family,
        score: familySurfaceSimilarity(question, family),
      }))
      .sort((left, right) =>
        right.score - left.score || left.family.familyId.localeCompare(right.family.familyId));
    const best = ranked[0];
    if (best === undefined || best.score < 0.6) return undefined;
    const runnerUp = ranked[1];
    if (runnerUp !== undefined && best.score - runnerUp.score < 0.15) {
      return undefined;
    }
    return best.family;
  }

  card(cardId: string): AnswerCard | undefined {
    return this.cardById.get(cardId);
  }

  contextualCard(
    cardIdHashes: readonly string[],
    domain: KnowledgeDomain,
    question: string,
  ): AnswerCard | undefined {
    const hashes = new Set(cardIdHashes);
    const matches = this.catalog.cards.filter((card) =>
      card.domain === domain &&
      isCardActive(card) &&
      hashes.has(hashAnswerCardIdentifier(card.cardId)) &&
      this.exactCardApplicable(card.cardId, question));
    return matches.length === 1 ? matches[0] : undefined;
  }

  cardApplicable(cardId: string, question: string): boolean {
    const card = this.cardById.get(cardId);
    if (card === undefined) return false;
    const normalized = normalizeQuestion(question);
    const matchesAny = (values: readonly string[]) => values.length === 0 ||
      values.some((value) => normalized.includes(normalizeQuestion(value)));
    return matchesAny(card.applicability.products) &&
      (
        card.applicability.versions.includes("*") ||
        matchesAny(card.applicability.versions)
      ) &&
      matchesAny(card.applicability.scenarios) &&
      !card.applicability.excludeWhen.some((condition) =>
        normalized.includes(normalizeQuestion(condition)));
  }

  exactCardApplicable(cardId: string, question: string): boolean {
    const card = this.cardById.get(cardId);
    if (card === undefined) return false;
    const normalized = normalizeQuestion(question);
    return !card.applicability.excludeWhen.some((condition) =>
      normalized.includes(normalizeQuestion(condition)));
  }

  familyCardApplicable(cardId: string, question: string): boolean {
    return this.exactCardApplicable(cardId, question);
  }

  expectedRevision(domain: KnowledgeDomain): string {
    return this.snapshotByDomain.get(domain)!.revision;
  }

  snapshotCurrent(domain: KnowledgeDomain, revision: string): boolean {
    return this.expectedRevision(domain) === revision;
  }
}

export function loadAnswerCardRegistry(catalogPath: string): AnswerCardRegistry {
  const normalized = path.normalize(catalogPath);
  if (!path.isAbsolute(normalized) || path.extname(normalized).toLowerCase() !== ".json") {
    throw new AnswerCardRegistryError("answer_card_catalog_path_invalid");
  }
  let source: unknown;
  try {
    source = JSON.parse(readFileSync(normalized, "utf8"));
  } catch {
    throw new AnswerCardRegistryError("answer_card_catalog_unreadable");
  }
  return new AnswerCardRegistry(source);
}

export interface ActiveAnswerCardCatalogSource {
  readonly key: string;
  readonly catalogPath: string;
}

export function resolveActiveAnswerCardCatalog(
  catalogPath: string,
  snapshotRoot?: string,
): ActiveAnswerCardCatalogSource {
  const basePath = validatedCatalogPath(catalogPath);
  if (snapshotRoot === undefined) return { key: `base:${basePath}`, catalogPath: basePath };
  const normalizedRoot = path.resolve(snapshotRoot);
  let pointer: unknown;
  try {
    pointer = JSON.parse(readFileSync(path.join(normalizedRoot, "active.json"), "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return { key: `base:${basePath}`, catalogPath: basePath };
    throw new AnswerCardRegistryError("answer_card_snapshot_pointer_unreadable");
  }
  const releaseId = typeof pointer === "object" && pointer !== null &&
    typeof (pointer as { releaseId?: unknown }).releaseId === "string"
    ? (pointer as { releaseId: string }).releaseId
    : "";
  if (!/^KR-\d{4}-\d{2}-[A-Z0-9-]{3,40}$/u.test(releaseId)) {
    throw new AnswerCardRegistryError("answer_card_snapshot_pointer_invalid");
  }
  const activePath = path.resolve(normalizedRoot, "releases", releaseId, "answer-card-catalog.json");
  const relative = path.relative(normalizedRoot, activePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AnswerCardRegistryError("answer_card_snapshot_path_escape");
  }
  return { key: `snapshot:${releaseId}`, catalogPath: activePath };
}

export function hashAnswerCardIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier, "utf8").digest("hex");
}

export function normalizeQuestion(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function isCardActive(card: AnswerCard): boolean {
  return isReviewStatusActive(card.reviewStatus);
}

function isReviewStatusActive(status: string): boolean {
  return status === "approved" || status === "release_ready" || status === "released";
}

function familyConceptSimilarity(
  question: string,
  family: QuestionFamily,
  cards: ReadonlyMap<string, AnswerCard>,
): number {
  const governedConcepts = family.bindings.flatMap((binding) => {
    const card = cards.get(binding.cardId);
    const obligation = card?.obligations.find((candidate) =>
      candidate.id === binding.cardObligationId);
    return obligation === undefined
      ? []
      : [obligation.label, ...obligation.requiredConcepts];
  });
  return Math.max(0, ...governedConcepts.map((candidate) =>
    ngramSimilarity(question, candidate)));
}

function familySurfaceSimilarity(question: string, family: QuestionFamily): number {
  return Math.max(...[
    family.canonicalQuestion,
    family.title,
    ...family.aliases,
  ].map((candidate) => ngramSimilarity(question, candidate)));
}

function ngramSimilarity(left: string, right: string): number {
  const leftGrams = characterNgrams(normalizeQuestion(left));
  const rightGrams = characterNgrams(normalizeQuestion(right));
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  const intersection = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  return intersection / Math.min(leftGrams.size, rightGrams.size);
}

function characterNgrams(value: string): Set<string> {
  if ([...value].length < 2) return new Set(value === "" ? [] : [value]);
  const characters = [...value];
  return new Set(characters.slice(0, -1).map((character, index) =>
    `${character}${characters[index + 1]}`));
}

function uniqueMap<T, K extends string>(
  values: readonly T[],
  key: (value: T) => K,
  errorCode: string,
): Map<K, T> {
  const result = new Map<K, T>();
  for (const value of values) {
    const itemKey = key(value);
    if (result.has(itemKey)) throw new AnswerCardRegistryError(errorCode);
    result.set(itemKey, value);
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatedCatalogPath(catalogPath:string):string {
  const normalized=path.normalize(catalogPath);
  if(!path.isAbsolute(normalized)||path.extname(normalized).toLowerCase()!==".json"){
    throw new AnswerCardRegistryError("answer_card_catalog_path_invalid");
  }
  return normalized;
}

function isMissingFile(error:unknown):boolean {
  return typeof error==="object"&&error!==null&&"code" in error&&(error as{code?:unknown}).code==="ENOENT";
}
