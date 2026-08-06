import type {
  AnswerReviewProcessingStatus,
  AnswerReviewResult,
  AnswerReviewVerdict,
  AnswerReviewWorkflowStatus,
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
  readonly userDisplayName?: string;
  readonly question: string;
  readonly answer: string;
  readonly comment: string;
  readonly proposedAnswer?: string;
  readonly questionId: number;
  readonly answeredAt: string;
  readonly answerCardMatch?: Record<string, unknown>;
}

export interface FeedbackCaseListView extends Omit<StoredFeedbackCase, "encryptedPayload"> {
  readonly userDisplayName?: string;
}

export interface AnswerReviewReference {
  readonly index: number;
  readonly project: KnowledgeDomain;
  readonly title: string;
  readonly path: string;
  readonly revision: string;
  readonly contentHash: string;
}

export interface AnswerReviewIntake {
  readonly reviewId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly userDisplayName?: string;
  readonly questionId: number;
  readonly question: string;
  readonly answer: string;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly references: readonly AnswerReviewReference[];
  readonly answeredAt: string;
  readonly submittedAt: string;
  readonly source: "lunkr_direct";
  readonly answerCardMatch?: Record<string, unknown>;
  readonly answerCardActivation?: Record<string, unknown>;
}

export interface AnswerReviewEncryptedPayload {
  readonly userDisplayName?: string;
  readonly questionId: number;
  readonly question: string;
  readonly answer: string;
  readonly references: readonly AnswerReviewReference[];
  readonly answeredAt: string;
  readonly answerCardMatch?: Record<string, unknown>;
  readonly answerCardActivation?: Record<string, unknown>;
  readonly result?: AnswerReviewResult;
}

export interface StoredAnswerReviewCase {
  readonly reviewId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly processingStatus: AnswerReviewProcessingStatus;
  readonly verdict: AnswerReviewVerdict;
  readonly workflowStatus: AnswerReviewWorkflowStatus;
  readonly encryptedPayload: EncryptedPayload;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly referenceCount: number;
  readonly source: "lunkr_direct";
  readonly model: "deepseek_v4_flash";
  readonly score?: number;
  readonly defectCount: number;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AnswerReviewCaseListView extends Omit<StoredAnswerReviewCase, "encryptedPayload"> {
  readonly userDisplayName?: string;
  readonly questionPreview: string;
}

export interface AnswerReviewCaseView extends Omit<StoredAnswerReviewCase, "encryptedPayload"> {
  readonly userDisplayName?: AnswerReviewEncryptedPayload["userDisplayName"];
  readonly questionId: AnswerReviewEncryptedPayload["questionId"];
  readonly question: AnswerReviewEncryptedPayload["question"];
  readonly answer: AnswerReviewEncryptedPayload["answer"];
  readonly references: AnswerReviewEncryptedPayload["references"];
  readonly answeredAt: AnswerReviewEncryptedPayload["answeredAt"];
  readonly answerCardMatch?: AnswerReviewEncryptedPayload["answerCardMatch"];
  readonly answerCardActivation?: AnswerReviewEncryptedPayload["answerCardActivation"];
  readonly result?: AnswerReviewEncryptedPayload["result"];
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

export interface CatalogCardRevisionInput {
  readonly cardId: string;
  readonly domain: KnowledgeDomain;
  readonly status: GovernanceReviewStatus;
  readonly content: Record<string, unknown>;
  readonly baseGitRevision: string;
}

export interface CatalogCardSyncResult {
  readonly revision: CardRevision;
  readonly created: boolean;
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
  | "answer_review"
  | "compile_catalog"
  | "regression_run"
  | "publish_release"
  | "rollback_release"
  | "git_writeback"
  | "generate_repair_draft"
  | "validate_repair_draft"
  | "publish_repair"
  | "publish_repair_batch"
  | "rollback_repair"
  | "rollback_repair_batch";

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

export type IssuePriority = "p0" | "p1" | "p2" | "p3";
export type IssueStatus = "open" | "in_progress" | "validating" | "resolved" | "dismissed";
export type IssueCategory =
  | "knowledge_gap" | "retrieval_gap" | "planning_gap" | "coverage_gap" | "logic_gap" | "citation_gap" | "expression_gap"
  | "user_incorrect" | "user_missing" | "review_requested" | "evidence" | "correction" | "judgement_conflict" | "review_error";
export type IssueSourceType = "answer_review" | "feedback";

export interface IssueCase {
  readonly issueId: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly priority: IssuePriority;
  readonly status: IssueStatus;
  readonly category: IssueCategory;
  readonly scope?: string;
  readonly answerCardKey?: string;
  readonly slaDueAt: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueOccurrence {
  readonly occurrenceId: string;
  readonly issueId: string;
  readonly sourceType: IssueSourceType;
  readonly sourceId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly createdAt: string;
}

export interface IssueCaseSummary extends IssueCase {
  readonly occurrenceCount: number;
  readonly affectedUserCount: number;
}

export interface IssueRecordInput {
  readonly fingerprint: string;
  readonly title: string;
  readonly priority: IssuePriority;
  readonly category: IssueCategory;
  readonly scope?: string;
  readonly answerCardKey?: string;
  readonly occurredAt: string;
  readonly occurrence: Omit<IssueOccurrence,"occurrenceId"|"issueId"|"createdAt">;
}

export interface IssueListQuery {
  readonly status?: IssueStatus;
  readonly priority?: IssuePriority;
  readonly actionableOnly?: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface IssuePage {
  readonly items: readonly IssueCaseSummary[];
  readonly total: number;
}

export type RepairTargetKind = "answer_card" | "knowledge_page" | "retrieval_rule" | "system_fix";
export type RepairDraftStatus =
  | "generating" | "draft_ready" | "validating" | "validation_failed"
  | "ready_to_publish" | "publishing" | "published" | "failed";
export type RepairValidationStatus = "queued" | "running" | "passed" | "failed";
export type RepairPublicationStatus = "pending" | "publishing" | "published" | "failed" | "rolled_back";
export type RepairBatchStatus = "queued" | "publishing" | "published" | "failed" | "rolled_back";
export type RepairRemoteSyncStatus = "not_requested" | "pending" | "pushing" | "synced" | "failed" | "compensated";
export type RepairRegressionKind = "canonical" | "alias" | "colloquial" | "follow_up" | "negative";

export interface RepairObligation {
  readonly id: string;
  readonly label: string;
  readonly evidencePolicy: "direct" | "synthesis" | "customer_input";
  readonly requiredConcepts: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly preferredEvidencePaths: readonly string[];
}

export interface RepairDraftProposal {
  readonly rootCause: IssueCategory;
  readonly targetKind: RepairTargetKind;
  readonly targetDomain?: KnowledgeDomain;
  readonly targetPath?: string;
  readonly cardId?: string;
  readonly title: string;
  readonly canonicalQuestion: string;
  readonly aliases: readonly string[];
  readonly answerTemplate: string;
  readonly obligations: readonly RepairObligation[];
  readonly regressionQuestions: readonly { readonly kind: RepairRegressionKind; readonly question: string }[];
  readonly generationSummary: string;
  readonly publishable: boolean;
  readonly blockingReason?: string;
}

export interface KnowledgeRepairDraft {
  readonly draftId: string;
  readonly issueId: string;
  readonly status: RepairDraftStatus;
  readonly targetKind?: RepairTargetKind;
  readonly targetDomain?: KnowledgeDomain;
  readonly targetPath?: string;
  readonly baseGitRevision?: string;
  readonly model: "deepseek_v4_flash";
  readonly encryptedPayload: EncryptedPayload;
  readonly createdBy: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KnowledgeRepairDraftSummary extends Omit<KnowledgeRepairDraft,"encryptedPayload"> {}
export interface RepairEvidenceSummary {
  readonly loadedCount: number;
  readonly revalidatedReferenceCount: number;
  readonly issues: readonly string[];
}
export interface KnowledgeRepairDraftView extends KnowledgeRepairDraftSummary {
  readonly proposal?: RepairDraftProposal;
  readonly evidenceSummary?: RepairEvidenceSummary;
}

export interface RepairValidationRun {
  readonly validationId: string;
  readonly draftId: string;
  readonly issueId: string;
  readonly status: RepairValidationStatus;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly model: "deepseek_v4_flash";
  readonly encryptedPayload: EncryptedPayload;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface RepairValidationRunView extends Omit<RepairValidationRun,"encryptedPayload"> {
  readonly result?: Record<string,unknown>;
}

export interface RepairPublication {
  readonly publicationId: string;
  readonly batchId?: string;
  readonly draftId: string;
  readonly issueId: string;
  readonly status: RepairPublicationStatus;
  readonly targetDomain: KnowledgeDomain;
  readonly targetPath: string;
  readonly baseGitRevision: string;
  readonly remoteSyncStatus: RepairRemoteSyncStatus;
  readonly remoteName?: string;
  readonly remoteBranch?: string;
  readonly resultingGitRevision?: string;
  readonly catalogHash?: string;
  readonly snapshotReleaseId?: string;
  readonly previousReleaseId?: string;
  readonly createdBy: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly rolledBackAt?: string;
}

export interface RepairBatch {
  readonly batchId: string;
  readonly status: RepairBatchStatus;
  readonly itemCount: number;
  readonly domains: readonly KnowledgeDomain[];
  readonly catalogHash?: string;
  readonly snapshotReleaseId?: string;
  readonly previousReleaseId?: string;
  readonly createdBy: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly publishedAt?: string;
  readonly rolledBackAt?: string;
}

export interface RepairBatchView extends RepairBatch {
  readonly publications: readonly RepairPublication[];
}

export interface DashboardSummary {
  readonly issues: {
    readonly actionable: number;
    readonly urgent: number;
    readonly overdue: number;
    readonly validating: number;
    readonly readyToPublish: number;
    readonly byPriority: Record<IssuePriority,number>;
  };
  readonly repairBatches: {
    readonly queued: number;
    readonly publishing: number;
    readonly published: number;
    readonly failed: number;
  };
  readonly feedback: Record<StoredFeedbackCase["status"], number>;
  readonly answerReviews: {
    readonly pendingHuman: number;
    readonly passed: number;
    readonly errored: number;
    readonly total: number;
  };
  readonly cardsByStatus: Partial<Record<GovernanceReviewStatus, number>>;
  readonly jobs: Record<OpsJob["status"], number>;
  readonly activeReleaseId?: string;
}
