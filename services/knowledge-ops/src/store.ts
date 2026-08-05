import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  ApprovalRecord,
  CardRevision,
  DashboardSummary,
  OpsJob,
  OpsJobType,
  RegressionCaseRecord,
  RegressionRun,
  ReleaseRecord,
  ReviewRecord,
  StoredFeedbackCase,
} from "./types.js";

export interface KnowledgeOpsStore {
  insertFeedback(value: StoredFeedbackCase): Promise<StoredFeedbackCase>;
  listFeedback(): Promise<readonly StoredFeedbackCase[]>;
  getFeedback(caseId: string): Promise<StoredFeedbackCase | undefined>;
  updateFeedbackStatus(caseId: string, status: StoredFeedbackCase["status"]): Promise<StoredFeedbackCase | undefined>;
  createCardRevision(value: CardRevision): Promise<CardRevision>;
  listCardRevisions(): Promise<readonly CardRevision[]>;
  getCardRevision(revisionId: string): Promise<CardRevision | undefined>;
  updateCardRevisionStatus(revisionId: string, status: CardRevision["status"]): Promise<CardRevision | undefined>;
  addReview(value: ReviewRecord): Promise<ReviewRecord>;
  listReviews(revisionId: string): Promise<readonly ReviewRecord[]>;
  addApproval(value: ApprovalRecord): Promise<ApprovalRecord>;
  listApprovals(revisionId: string): Promise<readonly ApprovalRecord[]>;
  upsertRegressionCase(value: RegressionCaseRecord): Promise<RegressionCaseRecord>;
  listRegressionCases(): Promise<readonly RegressionCaseRecord[]>;
  createRegressionRun(value: RegressionRun): Promise<RegressionRun>;
  getRegressionRun(runId: string): Promise<RegressionRun | undefined>;
  listRegressionRuns(): Promise<readonly RegressionRun[]>;
  updateRegressionRun(value: RegressionRun): Promise<RegressionRun>;
  enqueueJob(type: OpsJobType, payload: Record<string, unknown>, availableAt?: string): Promise<OpsJob>;
  claimJob(workerId: string): Promise<OpsJob | undefined>;
  completeJob(jobId: string, result: Record<string, unknown>): Promise<void>;
  failJob(jobId: string, errorCode: string): Promise<void>;
  listJobs(): Promise<readonly OpsJob[]>;
  createRelease(value: ReleaseRecord): Promise<ReleaseRecord>;
  listReleases(): Promise<readonly ReleaseRecord[]>;
  activateRelease(releaseId: string): Promise<ReleaseRecord | undefined>;
  rollbackRelease(releaseId: string): Promise<ReleaseRecord | undefined>;
  appendAudit(value: AuditEvent): Promise<AuditEvent>;
  listAudit(): Promise<readonly AuditEvent[]>;
  dashboard(): Promise<DashboardSummary>;
}

export class InMemoryKnowledgeOpsStore implements KnowledgeOpsStore {
  private readonly feedback = new Map<string, StoredFeedbackCase>();
  private readonly revisions = new Map<string, CardRevision>();
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly regressionCases = new Map<string, RegressionCaseRecord>();
  private readonly regressionRuns = new Map<string, RegressionRun>();
  private readonly jobs = new Map<string, OpsJob>();
  private readonly releases = new Map<string, ReleaseRecord>();
  private readonly audit: AuditEvent[] = [];

  async insertFeedback(value: StoredFeedbackCase) {
    const duplicate = [...this.feedback.values()].find((item) => item.requestId === value.requestId);
    if (duplicate !== undefined) return copy(duplicate);
    this.feedback.set(value.caseId, copy(value)); return copy(value);
  }
  async listFeedback() { return newest([...this.feedback.values()].map(copy)); }
  async getFeedback(id: string) { return maybeCopy(this.feedback.get(id)); }
  async updateFeedbackStatus(id: string, status: StoredFeedbackCase["status"]) {
    const old = this.feedback.get(id); if (!old) return undefined;
    const next = { ...old, status, updatedAt: now() }; this.feedback.set(id, next); return copy(next);
  }
  async createCardRevision(value: CardRevision) { this.revisions.set(value.revisionId, copy(value)); return copy(value); }
  async listCardRevisions() { return newest([...this.revisions.values()].map(copy)); }
  async getCardRevision(id: string) { return maybeCopy(this.revisions.get(id)); }
  async updateCardRevisionStatus(id: string, status: CardRevision["status"]) {
    const old = this.revisions.get(id); if (!old) return undefined;
    const next = { ...old, status, updatedAt: now() }; this.revisions.set(id, next); return copy(next);
  }
  async addReview(value: ReviewRecord) {
    const key = `${value.revisionId}:${value.reviewerId}`;
    if (this.reviews.has(key)) throw new Error("review_already_exists");
    this.reviews.set(key, copy(value)); return copy(value);
  }
  async listReviews(id: string) { return newest([...this.reviews.values()].filter((x) => x.revisionId === id).map(copy)); }
  async addApproval(value: ApprovalRecord) { const key=`${value.revisionId}:${value.reviewerId}`;if(this.approvals.has(key))throw new Error("approval_already_exists");this.approvals.set(key,copy(value));return copy(value); }
  async listApprovals(id:string){return newest([...this.approvals.values()].filter(x=>x.revisionId===id).map(copy));}
  async upsertRegressionCase(value: RegressionCaseRecord) { this.regressionCases.set(value.caseId, copy(value)); return copy(value); }
  async listRegressionCases() { return [...this.regressionCases.values()].map(copy).sort((a,b) => a.caseId.localeCompare(b.caseId)); }
  async createRegressionRun(value: RegressionRun) { this.regressionRuns.set(value.runId, copy(value)); return copy(value); }
  async getRegressionRun(id: string) { return maybeCopy(this.regressionRuns.get(id)); }
  async listRegressionRuns() { return newest([...this.regressionRuns.values()].map(copy)); }
  async updateRegressionRun(value: RegressionRun) { this.regressionRuns.set(value.runId, copy(value)); return copy(value); }
  async enqueueJob(type: OpsJobType, payload: Record<string, unknown>, availableAt = now()) {
    const timestamp = now();
    const job: OpsJob = { jobId: randomUUID(), type, payload: copy(payload), status: "queued", attempts: 0, availableAt, createdAt: timestamp, updatedAt: timestamp };
    this.jobs.set(job.jobId, job); return copy(job);
  }
  async claimJob(workerId: string) {
    const job = [...this.jobs.values()].filter((x) => x.status === "queued" && x.availableAt <= now()).sort((a,b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return undefined;
    const timestamp = now();
    const claimed: OpsJob = { ...job, status: "running", attempts: job.attempts + 1, lockedBy: workerId, lockedAt: timestamp, updatedAt: timestamp };
    this.jobs.set(job.jobId, claimed); return copy(claimed);
  }
  async completeJob(id: string, result: Record<string, unknown>) { this.finishJob(id, { status: "completed", result: copy(result) }); }
  async failJob(id: string, errorCode: string) { this.finishJob(id, { status: "failed", errorCode }); }
  async listJobs() { return newest([...this.jobs.values()].map(copy)); }
  async createRelease(value: ReleaseRecord) { this.releases.set(value.releaseId, copy(value)); return copy(value); }
  async listReleases() { return newest([...this.releases.values()].map(copy)); }
  async activateRelease(id: string) {
    const target = this.releases.get(id); if (!target) return undefined;
    for (const [key, release] of this.releases) if (release.status === "active") this.releases.set(key, { ...release, status: "superseded" });
    const active = { ...target, status: "active" as const, activatedAt: now() }; this.releases.set(id, active); return copy(active);
  }
  async rollbackRelease(id: string) {
    const target = this.releases.get(id); if (!target) return undefined;
    for (const [key, release] of this.releases) if (release.status === "active") this.releases.set(key, { ...release, status: "rolled_back" });
    const active = { ...target, status: "active" as const, activatedAt: now() }; this.releases.set(id, active); return copy(active);
  }
  async appendAudit(value: AuditEvent) { this.audit.push(copy(value)); return copy(value); }
  async listAudit() { return newest(this.audit.map(copy)); }
  async dashboard(): Promise<DashboardSummary> {
    const feedback = { new: 0, triaged: 0, in_review: 0, resolved: 0, rejected: 0 };
    for (const item of this.feedback.values()) feedback[item.status]++;
    const jobs = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const item of this.jobs.values()) jobs[item.status]++;
    const cardsByStatus: DashboardSummary["cardsByStatus"] = {};
    for (const item of this.revisions.values()) cardsByStatus[item.status] = (cardsByStatus[item.status] ?? 0) + 1;
    const activeReleaseId = [...this.releases.values()].find((x) => x.status === "active")?.releaseId;
    return { feedback, cardsByStatus, jobs, ...(activeReleaseId ? { activeReleaseId } : {}) };
  }
  private finishJob(id: string, patch: Partial<OpsJob>) {
    const old = this.jobs.get(id); if (!old) throw new Error("job_not_found");
    this.jobs.set(id, { ...old, ...patch, updatedAt: now() });
  }
}

function now(): string { return new Date().toISOString(); }
function copy<T>(value: T): T { return structuredClone(value); }
function maybeCopy<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : copy(value); }
function newest<T extends { createdAt: string }>(values: T[]): T[] { return values.sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
