import { createHmac, randomUUID } from "node:crypto";
import type { FeedbackClassification } from "@pseagent/knowledge-governance-contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PSEUDONYMOUS_ID_PATTERN = /^[a-f0-9]{64}$/u;

export interface FeedbackReceipt {
  readonly questionId: number;
  readonly requestId: string;
  readonly question: string;
  readonly answer: string;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly referenceCount: number;
  readonly answeredAt: string;
  readonly answerCardMatch?: FeedbackAnswerCardSummary;
  readonly userDisplayName?: string;
}

export interface FeedbackAnswerCardSummary {
  readonly matchType: "exact" | "family" | "partial" | "none";
  readonly confidence: "deterministic" | "high" | "none";
  readonly candidateCount: number;
  readonly obligationCount: number;
  readonly cardIdHashes: readonly string[];
  readonly catalogHash: string;
}

export interface BridgeFeedbackSubmission {
  readonly caseId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly userDisplayName?: string;
  readonly questionId: number;
  readonly classification: FeedbackClassification;
  readonly comment: string;
  readonly proposedAnswer?: string;
  readonly question: string;
  readonly answer: string;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly referenceCount: number;
  readonly answeredAt: string;
  readonly submittedAt: string;
  readonly source: "lunkr_direct";
  readonly answerCardMatch?: FeedbackAnswerCardSummary;
  readonly audit: {
    readonly event: "feedback_submitted";
    readonly occurredAt: string;
  };
}

type StoredReceipt = {
  readonly peerUid: string;
  readonly receipt: FeedbackReceipt;
  readonly expiresAt: number;
  state: "available" | "in_flight" | "submitted";
  claimToken?: string;
  caseId?: string;
};

export type FeedbackClaimResult =
  | { readonly kind: "missing" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "claimed"; readonly claim: FeedbackReceiptClaim };

export class FeedbackReceiptClaim {
  private settled = false;

  constructor(
    readonly receipt: FeedbackReceipt,
    readonly caseId: string,
    private readonly settleClaim: (success: boolean) => void,
  ) {}

  settle(success: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.settleClaim(success);
  }
}

export class FeedbackReceiptStore {
  private readonly receipts = new Map<string, StoredReceipt>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxReceipts = 2_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("feedback_receipt_ttl_invalid");
    }
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) {
      throw new Error("feedback_receipt_limit_invalid");
    }
  }

  remember(peerUid: string, receipt: FeedbackReceipt): boolean {
    if (
      peerUid.trim() === "" ||
      !Number.isSafeInteger(receipt.questionId) ||
      receipt.questionId <= 0 ||
      !UUID_PATTERN.test(receipt.requestId) ||
      receipt.question.trim() === "" ||
      receipt.answer.trim() === "" ||
      !Number.isSafeInteger(receipt.referenceCount) ||
      receipt.referenceCount < 0 ||
      !Number.isFinite(Date.parse(receipt.answeredAt))
    ) {
      return false;
    }
    this.removeExpired();
    const key = receiptKey(peerUid, receipt.questionId);
    this.receipts.set(key, {
      peerUid,
      receipt: Object.freeze({ ...receipt }),
      expiresAt: this.now() + this.ttlMs,
      state: "available",
    });
    this.evictOverflow();
    return true;
  }

  claim(peerUid: string, questionId: number): FeedbackClaimResult {
    this.removeExpired();
    const key = receiptKey(peerUid, questionId);
    const stored = this.receipts.get(key);
    if (stored === undefined) return { kind: "missing" };
    if (stored.state !== "available") return { kind: "duplicate" };
    const claimToken = randomUUID();
    const caseId = stored.caseId ?? randomUUID();
    stored.state = "in_flight";
    stored.claimToken = claimToken;
    stored.caseId = caseId;
    return {
      kind: "claimed",
      claim: new FeedbackReceiptClaim(stored.receipt, caseId, (success) => {
        const current = this.receipts.get(key);
        if (
          current === undefined ||
          current.state !== "in_flight" ||
          current.claimToken !== claimToken
        ) {
          return;
        }
        delete current.claimToken;
        current.state = success ? "submitted" : "available";
      }),
    };
  }

  latestQuestionId(peerUid: string): number | undefined {
    this.removeExpired();
    let latest: StoredReceipt | undefined;
    for (const stored of this.receipts.values()) {
      if (stored.peerUid !== peerUid) continue;
      if (
        latest === undefined ||
        stored.expiresAt > latest.expiresAt ||
        (stored.expiresAt === latest.expiresAt &&
          stored.receipt.questionId > latest.receipt.questionId)
      ) {
        latest = stored;
      }
    }
    return latest?.receipt.questionId;
  }

  clearPeer(peerUid: string): void {
    for (const [key, stored] of this.receipts) {
      if (stored.peerUid === peerUid) this.receipts.delete(key);
    }
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [key, stored] of this.receipts) {
      if (stored.expiresAt <= now) this.receipts.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.receipts.size > this.maxReceipts) {
      const oldest = [...this.receipts.entries()].sort((left, right) =>
        left[1].expiresAt - right[1].expiresAt)[0];
      if (oldest === undefined) return;
      this.receipts.delete(oldest[0]);
    }
  }
}

export function pseudonymizeFeedbackUser(
  peerUid: string,
  secret: string,
): string {
  if (peerUid.trim() === "" || secret.length < 32) {
    throw new Error("feedback_pseudonymization_input_invalid");
  }
  const digest = createHmac("sha256", secret)
    .update(peerUid.normalize("NFKC"), "utf8")
    .digest("hex");
  if (!PSEUDONYMOUS_ID_PATTERN.test(digest)) {
    throw new Error("feedback_pseudonymization_failed");
  }
  return digest;
}

function receiptKey(peerUid: string, questionId: number): string {
  return `${peerUid}\u0000${questionId}`;
}
