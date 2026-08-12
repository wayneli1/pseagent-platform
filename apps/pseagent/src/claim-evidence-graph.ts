import type { Reference } from "./contracts.js";
import type { AtomicObligationContract } from "./atomic-obligation.js";
import type {
  DeterministicRetrievalResult,
  RetrievedEvidence,
} from "./deterministic-retrieval.js";
import type { BoundClaim, ClaimDraft } from "./structured-claim.js";

export function bindClaimsToEvidence(input: {
  readonly claims: readonly ClaimDraft[];
  readonly contract: AtomicObligationContract;
  readonly retrievals: readonly DeterministicRetrievalResult[];
}): { readonly retained: readonly BoundClaim[]; readonly rejected: readonly string[] } {
  const obligations = new Map(input.contract.obligations.map((item) => [item.id, item]));
  const evidenceByKey = new Map<string, {
    readonly evidence: RetrievedEvidence;
    readonly reference: Reference;
  }>();
  for (const retrieval of input.retrievals) {
    const referenceByCitation = new Map(retrieval.references.map((reference) =>
      [reference.index, reference] as const));
    for (const evidence of retrieval.evidence) {
      const reference = referenceByCitation.get(evidence.citation);
      if (
        reference === undefined ||
        reference.project !== evidence.domain ||
        reference.path !== evidence.path
      ) {
        continue;
      }
      evidenceByKey.set(evidenceKey(
        evidence.domain,
        evidence.citation,
        evidence.obligationId,
      ), {
        evidence,
        reference,
      });
    }
  }

  const retained: BoundClaim[] = [];
  const rejected: string[] = [];
  const seenClaimIds = new Set<string>();
  for (const claim of input.claims) {
    const reject = (reason: string) => rejected.push(`${claim.claimId}:${reason}`);
    if (seenClaimIds.has(claim.claimId)) {
      reject("claim_id_duplicate");
      continue;
    }
    seenClaimIds.add(claim.claimId);
    const obligation = obligations.get(claim.obligationId);
    if (obligation === undefined) {
      reject("claim_obligation_unknown");
      continue;
    }
    if (!obligation.domains.includes(claim.domain)) {
      reject("claim_domain_mismatch");
      continue;
    }
    if (claim.kind === "gap") {
      if (claim.citationIndexes.length > 0 || claim.coveredAspectIds.length > 0) {
        reject("gap_claim_must_be_uncited");
        continue;
      }
      retained.push({
        ...claim,
        support: "gap",
        evidenceIdentities: [],
      });
      continue;
    }
    if (
      claim.citationIndexes.length === 0 ||
      new Set(claim.citationIndexes).size !== claim.citationIndexes.length
    ) {
      reject("claim_citation_required");
      continue;
    }
    const bound = claim.citationIndexes.map((citation) =>
      evidenceByKey.get(evidenceKey(claim.domain, citation, claim.obligationId)));
    if (bound.some((item) => item === undefined)) {
      reject("claim_evidence_unread");
      continue;
    }
    const local = bound.filter((item): item is NonNullable<typeof item> =>
      item !== undefined);
    if (local.some(({ evidence }) => evidence.obligationId !== claim.obligationId)) {
      reject("claim_evidence_binding_mismatch");
      continue;
    }
    if (
      obligation.evidencePolicy === "direct" &&
      local.some(({ evidence }) => evidence.sourceBoundary !== "formal")
    ) {
      reject("claim_direct_source_required");
      continue;
    }
    const availableAspects = new Set(local.flatMap(({ evidence }) => evidence.aspectIds));
    if (
      claim.coveredAspectIds.length === 0 ||
      new Set(claim.coveredAspectIds).size !== claim.coveredAspectIds.length ||
      claim.coveredAspectIds.some((aspectId) => !availableAspects.has(aspectId))
    ) {
      reject("claim_aspect_mismatch");
      continue;
    }
    retained.push({
      ...claim,
      support: obligation.evidencePolicy === "direct" ? "direct" : "synthesized",
      evidenceIdentities: stableUnique(local.map(({ reference }) => reference.contentHash)),
    });
  }
  return {
    retained: Object.freeze(retained),
    rejected: Object.freeze(rejected),
  };
}

export function mergeBoundDomainClaims(input: {
  readonly domains: readonly {
    readonly claims: readonly BoundClaim[];
    readonly references: readonly Reference[];
  }[];
}): { readonly claims: readonly BoundClaim[]; readonly references: readonly Reference[] } {
  const references: Reference[] = [];
  const globalIndexByIdentity = new Map<string, number>();
  const claims: BoundClaim[] = [];
  for (const domain of input.domains) {
    const localToGlobal = new Map<number, number>();
    for (const reference of domain.references) {
      const identity = referenceIdentity(reference);
      let globalIndex = globalIndexByIdentity.get(identity);
      if (globalIndex === undefined) {
        globalIndex = references.length + 1;
        references.push({ ...reference, index: globalIndex });
        globalIndexByIdentity.set(identity, globalIndex);
      }
      localToGlobal.set(reference.index, globalIndex);
    }
    for (const claim of domain.claims) {
      const citationIndexes = claim.citationIndexes.map((citation) => {
        const mapped = localToGlobal.get(citation);
        if (mapped === undefined) throw new Error("claim_reference_mapping_missing");
        return mapped;
      });
      claims.push({
        ...claim,
        claimId: `CL${claims.length + 1}`,
        citationIndexes: stableUnique(citationIndexes),
      });
    }
  }
  return {
    claims: Object.freeze(claims),
    references: Object.freeze(references),
  };
}

function evidenceKey(domain: string, citation: number, obligationId: string): string {
  return `${domain}\u0000${citation}\u0000${obligationId}`;
}

function referenceIdentity(reference: Reference): string {
  return [
    reference.project,
    reference.revision,
    reference.path,
    reference.contentHash,
  ].join("\u0000");
}

function stableUnique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
