import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { KnowledgeOpsStore } from "./store.js";
import type {
  ApprovalRecord, AuditEvent, CardRevision, DashboardSummary, OpsJob, OpsJobType,
  RegressionCaseRecord, RegressionRun, ReleaseRecord, ReviewRecord, StoredFeedbackCase,
} from "./types.js";

export class PostgresKnowledgeOpsStore implements KnowledgeOpsStore {
  constructor(readonly pool: Pool) {}

  static connect(connectionString: string): PostgresKnowledgeOpsStore {
    if (connectionString.trim() === "") throw new Error("database_url_required");
    return new PostgresKnowledgeOpsStore(new Pool({ connectionString, max: 10 }));
  }

  async migrate(): Promise<void> {
    for (const fileName of ["001_initial.sql", "002_feedback_correction.sql"]) {
      const migration = await readFile(fileURLToPath(
        new URL(`../migrations/${fileName}`, import.meta.url),
      ), "utf8");
      await this.pool.query(migration);
    }
  }
  async ping(): Promise<boolean> {
    try { await this.pool.query("SELECT 1"); return true; } catch { return false; }
  }
  async close(): Promise<void> { await this.pool.end(); }

  async insertFeedback(v: StoredFeedbackCase): Promise<StoredFeedbackCase> {
    const row = await one(this.pool, `INSERT INTO feedback_cases
      (case_id,request_id,pseudonymous_user_id,classification,status,encrypted_payload,answer_status,scope,reference_count,source,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *`,
      [v.caseId,v.requestId,v.pseudonymousUserId,v.classification,v.status,v.encryptedPayload,v.answerStatus,v.scope ?? null,v.referenceCount,v.source,v.createdAt,v.updatedAt]);
    return map<StoredFeedbackCase>(row);
  }
  async listFeedback() { return rows<StoredFeedbackCase>(await this.pool.query("SELECT * FROM feedback_cases ORDER BY created_at DESC")); }
  async getFeedback(id: string) { return optional<StoredFeedbackCase>(await this.pool.query("SELECT * FROM feedback_cases WHERE case_id=$1",[id])); }
  async updateFeedbackStatus(id: string,status: StoredFeedbackCase["status"]) { return optional<StoredFeedbackCase>(await this.pool.query("UPDATE feedback_cases SET status=$2,updated_at=now() WHERE case_id=$1 RETURNING *",[id,status])); }

  async createCardRevision(v: CardRevision) {
    const row = await one(this.pool, `INSERT INTO card_revisions
      (revision_id,card_id,domain,revision,status,content,created_by,base_git_revision,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [v.revisionId,v.cardId,v.domain,v.revision,v.status,v.content,v.createdBy,v.baseGitRevision,v.createdAt,v.updatedAt]);
    return map<CardRevision>(row);
  }
  async listCardRevisions() { return rows<CardRevision>(await this.pool.query("SELECT * FROM card_revisions ORDER BY updated_at DESC")); }
  async getCardRevision(id: string) { return optional<CardRevision>(await this.pool.query("SELECT * FROM card_revisions WHERE revision_id=$1",[id])); }
  async updateCardRevisionStatus(id: string,status: CardRevision["status"]) { return optional<CardRevision>(await this.pool.query("UPDATE card_revisions SET status=$2,updated_at=now() WHERE revision_id=$1 RETURNING *",[id,status])); }
  async addReview(v: ReviewRecord) {
    return map<ReviewRecord>(await one(this.pool, `INSERT INTO reviews
      (review_id,revision_id,reviewer_id,decision,comment,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [v.reviewId,v.revisionId,v.reviewerId,v.decision,v.comment,v.createdAt]));
  }
  async listReviews(id: string) { return rows<ReviewRecord>(await this.pool.query("SELECT * FROM reviews WHERE revision_id=$1 ORDER BY created_at DESC",[id])); }
  async addApproval(v:ApprovalRecord){return map<ApprovalRecord>(await one(this.pool,`INSERT INTO approvals
    (approval_id,revision_id,card_id,domain,reviewer_id,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[v.approvalId,v.revisionId,v.cardId,v.domain,v.reviewerId,v.createdAt]));}
  async listApprovals(id:string){return rows<ApprovalRecord>(await this.pool.query("SELECT * FROM approvals WHERE revision_id=$1 ORDER BY created_at DESC",[id]));}

  async upsertRegressionCase(v: RegressionCaseRecord) {
    return map<RegressionCaseRecord>(await one(this.pool, `INSERT INTO regression_cases
      (case_id,domain,question,expected_card_id,required_obligation_ids,forbidden_claims,kind,enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(case_id) DO UPDATE SET domain=EXCLUDED.domain,question=EXCLUDED.question,
      expected_card_id=EXCLUDED.expected_card_id,required_obligation_ids=EXCLUDED.required_obligation_ids,
      forbidden_claims=EXCLUDED.forbidden_claims,kind=EXCLUDED.kind,enabled=EXCLUDED.enabled RETURNING *`,
      [v.caseId,v.domain,v.question,v.expectedCardId ?? null,v.requiredObligationIds,v.forbiddenClaims,v.kind,v.enabled]));
  }
  async listRegressionCases() { return rows<RegressionCaseRecord>(await this.pool.query("SELECT * FROM regression_cases ORDER BY case_id")); }
  async createRegressionRun(v: RegressionRun) {
    return map<RegressionRun>(await one(this.pool, `INSERT INTO regression_runs
      (run_id,status,total_cases,passed_cases,report,created_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [v.runId,v.status,v.totalCases,v.passedCases,v.report ?? null,v.createdAt,v.completedAt ?? null]));
  }
  async getRegressionRun(id: string) { return optional<RegressionRun>(await this.pool.query("SELECT * FROM regression_runs WHERE run_id=$1",[id])); }
  async listRegressionRuns() { return rows<RegressionRun>(await this.pool.query("SELECT * FROM regression_runs ORDER BY created_at DESC")); }
  async updateRegressionRun(v: RegressionRun) { return map<RegressionRun>(await one(this.pool,"UPDATE regression_runs SET status=$2,total_cases=$3,passed_cases=$4,report=$5,completed_at=$6 WHERE run_id=$1 RETURNING *",[v.runId,v.status,v.totalCases,v.passedCases,v.report ?? null,v.completedAt ?? null])); }

  async enqueueJob(type: OpsJobType,payload: Record<string,unknown>,availableAt=new Date().toISOString()) {
    return map<OpsJob>(await one(this.pool, `INSERT INTO ops_jobs
      (job_id,type,payload,status,attempts,available_at,created_at,updated_at) VALUES ($1,$2,$3,'queued',0,$4,now(),now()) RETURNING *`,[randomUUID(),type,payload,availableAt]));
  }
  async claimJob(workerId: string): Promise<OpsJob|undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`WITH candidate AS (
        SELECT job_id FROM ops_jobs WHERE status='queued' AND available_at<=now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ops_jobs j SET status='running',attempts=j.attempts+1,locked_by=$1,locked_at=now(),updated_at=now()
        FROM candidate WHERE j.job_id=candidate.job_id RETURNING j.*`,[workerId]);
      await client.query("COMMIT");
      return result.rows[0] === undefined ? undefined : map<OpsJob>(result.rows[0]);
    } catch (error) { await safeRollback(client); throw error; } finally { client.release(); }
  }
  async completeJob(id: string,result: Record<string,unknown>) { await this.pool.query("UPDATE ops_jobs SET status='completed',result=$2,updated_at=now() WHERE job_id=$1",[id,result]); }
  async failJob(id: string,errorCode: string) { await this.pool.query("UPDATE ops_jobs SET status='failed',error_code=$2,updated_at=now() WHERE job_id=$1",[id,errorCode]); }
  async listJobs() { return rows<OpsJob>(await this.pool.query("SELECT * FROM ops_jobs ORDER BY created_at DESC")); }

  async createRelease(v: ReleaseRecord) {
    return map<ReleaseRecord>(await one(this.pool, `INSERT INTO releases
      (release_id,professional_revision,general_revision,answer_contract_revision,card_catalog_hash,regression_run_id,manifest,status,created_by,approved_by,created_at,activated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [v.releaseId,v.professionalRevision,v.generalRevision,v.answerContractRevision,v.cardCatalogHash,v.regressionRunId,v.manifest,v.status,v.createdBy,v.approvedBy,v.createdAt,v.activatedAt ?? null]));
  }
  async listReleases() { return rows<ReleaseRecord>(await this.pool.query("SELECT * FROM releases ORDER BY created_at DESC")); }
  async activateRelease(id: string) { return this.changeActiveRelease(id,"superseded"); }
  async rollbackRelease(id: string) { return this.changeActiveRelease(id,"rolled_back"); }
  async appendAudit(v: AuditEvent) {
    return map<AuditEvent>(await one(this.pool, `INSERT INTO audit_events
      (audit_id,actor_id,action,resource_type,resource_id,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [v.auditId,v.actorId,v.action,v.resourceType,v.resourceId,v.metadata,v.createdAt]));
  }
  async listAudit() { return rows<AuditEvent>(await this.pool.query("SELECT * FROM audit_events ORDER BY created_at DESC")); }
  async dashboard(): Promise<DashboardSummary> {
    const [feedback,cards,jobs,release] = await Promise.all([
      this.pool.query("SELECT status,count(*)::int AS count FROM feedback_cases GROUP BY status"),
      this.pool.query("SELECT status,count(*)::int AS count FROM card_revisions GROUP BY status"),
      this.pool.query("SELECT status,count(*)::int AS count FROM ops_jobs GROUP BY status"),
      this.pool.query("SELECT release_id FROM releases WHERE status='active' LIMIT 1"),
    ]);
    const feedbackCounts = { new:0,triaged:0,in_review:0,resolved:0,rejected:0 };
    for (const row of feedback.rows) feedbackCounts[row.status as keyof typeof feedbackCounts] = row.count as number;
    const jobCounts = { queued:0,running:0,completed:0,failed:0 };
    for (const row of jobs.rows) jobCounts[row.status as keyof typeof jobCounts] = row.count as number;
    const cardsByStatus: DashboardSummary["cardsByStatus"] = {};
    for (const row of cards.rows) cardsByStatus[row.status as keyof typeof cardsByStatus] = row.count as number;
    const activeReleaseId = release.rows[0]?.release_id as string|undefined;
    return { feedback:feedbackCounts,cardsByStatus,jobs:jobCounts,...(activeReleaseId?{activeReleaseId}:{}) };
  }
  private async changeActiveRelease(id: string,previousStatus:"superseded"|"rolled_back") {
    const client=await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("UPDATE releases SET status=$1 WHERE status='active'",[previousStatus]);
      const result=await client.query("UPDATE releases SET status='active',activated_at=now() WHERE release_id=$1 RETURNING *",[id]);
      await client.query("COMMIT"); return result.rows[0]===undefined?undefined:map<ReleaseRecord>(result.rows[0]);
    } catch(error){await safeRollback(client);throw error;} finally{client.release();}
  }
}

async function safeRollback(client: PoolClient) { try { await client.query("ROLLBACK"); } catch { /* preserve original error */ } }
async function one(client:{query:(sql:string,values?:unknown[])=>Promise<{rows:QueryResultRow[]}>},sql:string,values:unknown[]) { const result=await client.query(sql,values); if(!result.rows[0]) throw new Error("database_write_failed"); return result.rows[0]; }
function rows<T>(result:{rows:QueryResultRow[]}):T[]{return result.rows.map((row)=>map<T>(row));}
function optional<T>(result:{rows:QueryResultRow[]}):T|undefined{return result.rows[0]===undefined?undefined:map<T>(result.rows[0]);}
function map<T>(row:QueryResultRow):T { const output:Record<string,unknown>={}; for(const [key,value] of Object.entries(row)) output[key.replace(/_([a-z])/gu,(_,letter:string)=>letter.toUpperCase())]=value instanceof Date?value.toISOString():value; return output as T; }
