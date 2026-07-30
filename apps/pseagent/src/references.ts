import type { FinalAction, KnowledgeRequirement, Reference } from "./contracts.js";
import type { KnowledgePage, ProjectKey } from "./knowledge-session.js";

export interface ReadEvidence {
  readonly project: ProjectKey;
  readonly revision: string;
  readonly page: KnowledgePage;
}

export type FinalValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export class ReferenceValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReferenceValidationError";
  }
}

export class ReferenceRegistry {
  private readonly entries: Reference[] = [];
  private readonly indexes = new Map<string, number>();

  constructor(
    private readonly project: ProjectKey,
    private readonly revision: string,
  ) {}

  register(read: ReadEvidence): Reference {
    if (read.project !== this.project || read.revision !== this.revision) {
      throw new ReferenceValidationError("snapshot_mismatch");
    }
    const page = read.page;
    if (
      page.project !== this.project ||
      !page.path.startsWith("wiki/") ||
      !page.path.endsWith(".md") ||
      page.path.includes("\\") ||
      page.path.split("/").includes("..")
    ) {
      throw new ReferenceValidationError("page_identity_mismatch");
    }
    if (!/^[a-f0-9]{64}$/u.test(page.contentHash)) {
      throw new ReferenceValidationError("content_hash_mismatch");
    }
    const key = [this.project, this.revision, page.path, page.contentHash].join("\u0000");
    const existing = this.indexes.get(key);
    if (existing !== undefined) return this.entries[existing - 1]!;
    const reference: Reference = {
      index: this.entries.length + 1,
      project: this.project,
      title: page.title,
      path: page.path,
      revision: this.revision,
      contentHash: page.contentHash,
    };
    this.entries.push(reference);
    this.indexes.set(key, reference.index);
    return reference;
  }

  list(): readonly Reference[] {
    return this.entries;
  }

  resolve(indices: readonly number[]): Reference[] {
    return indices.map((index) => this.entries[index - 1]).filter((entry): entry is Reference => entry !== undefined);
  }

  validateFinal(
    action: FinalAction,
    requirements: readonly KnowledgeRequirement[],
    evidenceByRequirement: ReadonlyMap<string, ReadonlySet<number>>,
  ): FinalValidation {
    if (action.requirements.length !== requirements.length) {
      return { ok: false, reason: "requirement_coverage_mismatch" };
    }
    for (let index = 0; index < requirements.length; index += 1) {
      if (action.requirements[index]?.id !== requirements[index]?.id) {
        return { ok: false, reason: "requirement_coverage_mismatch" };
      }
    }
    const requirementIds = action.requirements.map((item) => item.id);
    if (new Set(requirementIds).size !== requirementIds.length) {
      return { ok: false, reason: "duplicate_requirement_coverage" };
    }
    for (const item of action.requirements) {
      const invalidRelatedContext = (item.relatedContext ?? []).find(
        (related) => related.citations.length < 1 || related.citations.length > 4,
      );
      if (invalidRelatedContext !== undefined) {
        return { ok: false, reason: "related_citation_count" };
      }
    }
    const requirementCitations = stableUnique(action.requirements.flatMap(
      (item) => [
        ...item.citations,
        ...(item.relatedContext ?? []).flatMap((related) => related.citations),
      ],
    ));
    if (!sameNumbers(requirementCitations, action.citations)) {
      return { ok: false, reason: "requirement_citation_union_mismatch" };
    }
    if (action.citations.some((index) => this.entries[index - 1] === undefined)) {
      return { ok: false, reason: "unknown_citation" };
    }
    for (const item of action.requirements) {
      if (stableUnique([...item.citations]).length !== item.citations.length) {
        return { ok: false, reason: "duplicate_requirement_citation" };
      }
      const evidence = evidenceByRequirement.get(item.id) ?? new Set<number>();
      const unsupportedCitation = item.citations.find((citation) => !evidence.has(citation));
      if (unsupportedCitation !== undefined) {
        return {
          ok: false,
          reason: `citation_not_read_for_requirement:${item.id}:${unsupportedCitation}`,
        };
      }
      const answerCitations = stableUnique(
        [...item.answer.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
      );
      if (!sameNumberSet(answerCitations, item.citations)) {
        return { ok: false, reason: "requirement_citation_metadata_mismatch" };
      }
      if (item.relatedContext !== undefined && item.coverage !== "none") {
        return { ok: false, reason: "related_context_requires_none_coverage" };
      }
      for (const related of item.relatedContext ?? []) {
        if (stableUnique([...related.citations]).length !== related.citations.length) {
          return { ok: false, reason: "duplicate_related_citation" };
        }
        const unsupportedRelatedCitation = related.citations.find(
          (citation) => !evidence.has(citation),
        );
        if (unsupportedRelatedCitation !== undefined) {
          return {
            ok: false,
            reason: `citation_not_read_for_requirement:${item.id}:${unsupportedRelatedCitation}`,
          };
        }
        const relatedCitations = stableUnique(
          [...related.statement.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])),
        );
        if (!sameNumberSet(relatedCitations, related.citations)) {
          return { ok: false, reason: "related_citation_metadata_mismatch" };
        }
      }
      if (item.coverage === "complete" || item.coverage === "partial") {
        if (item.citations.length === 0) {
          return { ok: false, reason: "covered_requirement_without_citation" };
        }
        if (delegatesConclusionToCitation(item.answer)) {
          return { ok: false, reason: "requirement_answer_delegates_to_citation" };
        }
      } else if (item.citations.length > 0) {
        return { ok: false, reason: "none_requirement_with_citation" };
      }
    }
    return { ok: true };
  }
}

function stableUnique(values: number[]): number[] {
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

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function delegatesConclusionToCitation(answer: string): boolean {
  return /(?:见|如|参考|详见).{0,12}\[\d+\].{0,12}(?:所列|所示|资料|内容|说明)/u.test(answer);
}
