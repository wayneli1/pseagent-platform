import type {
  FeedbackClassification,
  GovernanceReviewStatus,
  KnowledgeDomain,
} from "@pseagent/knowledge-governance-contracts";

export type OpsRole =
  | "viewer"
  | "operator"
  | "professional_editor"
  | "professional_reviewer"
  | "general_editor"
  | "general_reviewer"
  | "release_manager"
  | "admin"
  | "service";

export interface OpsActor {
  readonly actorId: string;
  readonly roles: readonly OpsRole[];
}

export interface EncryptedPayload {
  readonly algorithm: "aes-256-gcm";
  readonly keyVersion: number;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export interface FeedbackIntake {
  readonly caseId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
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
  readonly answerCardMatch?: Record<string, unknown>;
}

export interface StoredFeedbackCase {
  readonly caseId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly classification: FeedbackClassification;
  readonly status: "new" | "triaged" | "in_review" | "resolved" | "rejected";
  readonly encryptedPayload: EncryptedPayload;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly referenceCount: number;
  readonly source: "lunkr_direct";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FeedbackCaseView extends Omit<StoredFeedbackCase, "encryptedPayload"> {
  readonly question: string;
  readonly answer: string;
  readonly comment: string;
  readonly proposedAnswer?: string;
  readonly questionId: number;
  readonly answeredAt: string;
  readonly answerCardMatch?: Record<string, unknown>;
}

export interface CardRevision {
  readonly revisionId: string;
  readonly cardId: string;
  readonly domain: KnowledgeDomain;
  readonly revision: number;
  readonly status: GovernanceReviewStatus;
  readonly content: Record<string, unknown>;
  readonly createdBy: string;
  readonly baseGitRevision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewRecord {
  readonly reviewId: string;
  readonly revisionId: string;
  readonly reviewerId: string;
  readonly decision: "approved" | "changes_requested" | "rejected";
  readonly comment: string;
  readonly createdAt: string;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly revisionId: string;
  readonly cardId: string;
  readonly domain: KnowledgeDomain;
  readonly reviewerId: string;
  readonly createdAt: string;
}

export interface RegressionCaseRecord {
  readonly caseId: string;
  readonly domain: KnowledgeDomain;
  readonly question: string;
  readonly expectedCardId?: string;
  readonly requiredObligationIds: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly kind: "canonical" | "alias" | "typo" | "follow_up" | "negative" | "stale";
  readonly enabled: boolean;
}

export interface RegressionRun {
  readonly runId: string;
  readonly status: "queued" | "running" | "passed" | "failed";
  readonly totalCases: number;
  readonly passedCases: number;
  readonly report?: Record<string, unknown>;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export type OpsJobType =
  | "compile_catalog"
  | "regression_run"
  | "publish_release"
  | "rollback_release"
  | "git_writeback";

export interface OpsJob {
  readonly jobId: string;
  readonly type: OpsJobType;
  readonly payload: Record<string, unknown>;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly attempts: number;
  readonly availableAt: string;
  readonly lockedBy?: string;
  readonly lockedAt?: string;
  readonly result?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReleaseRecord {
  readonly releaseId: string;
  readonly professionalRevision: string;
  readonly generalRevision: string;
  readonly answerContractRevision: string;
  readonly cardCatalogHash: string;
  readonly regressionRunId: string;
  readonly manifest: Record<string, unknown>;
  readonly status: "pending" | "active" | "superseded" | "failed" | "rolled_back";
  readonly createdBy: string;
  readonly approvedBy: readonly string[];
  readonly createdAt: string;
  readonly activatedAt?: string;
}

export interface AuditEvent {
  readonly auditId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

export interface DashboardSummary {
  readonly feedback: Record<StoredFeedbackCase["status"], number>;
  readonly cardsByStatus: Partial<Record<GovernanceReviewStatus, number>>;
  readonly jobs: Record<OpsJob["status"], number>;
  readonly activeReleaseId?: string;
}
