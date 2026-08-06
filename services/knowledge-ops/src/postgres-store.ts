import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { KnowledgeOpsStore } from "./store.js";
import type {
  ApprovalRecord, AuditEvent, CatalogCardRevisionInput, CatalogCardSyncResult, CardRevision, ConversationContextView, ConversationEndReason, ConversationSession, ConversationTurn, ConversationTurnInput, DashboardSummary, OpsJob, OpsJobType,
  IssueCase, IssueCaseSummary, IssueListQuery, IssueOccurrence, IssuePage, IssueRecordInput, IssueStatus,
  KnowledgeRepairDraft, RepairBatch, RepairBatchView, RepairPublication, RepairValidationRun, RegressionCaseRecord, RegressionRun, ReleaseRecord, ReviewRecord, StoredFeedbackCase,
  StoredAnswerReviewCase,
} from "./types.js";

export class PostgresKnowledgeOpsStore implements KnowledgeOpsStore {
  constructor(readonly pool: Pool) {}

  static connect(connectionString: string): PostgresKnowledgeOpsStore {
    if (connectionString.trim() === "") throw new Error("database_url_required");
    return new PostgresKnowledgeOpsStore(new Pool({ connectionString, max: 20 }));
  }

  async migrate(): Promise<void> {
    const client=await this.pool.connect(),lockKey="pseagent:knowledge-ops:migrations";
    try{
      await client.query("SELECT pg_advisory_lock(hashtext($1))",[lockKey]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = new Set(
        (await client.query("SELECT version FROM schema_migrations")).rows
          .map((row) => String(row.version)),
      );
      for (const fileName of [
        "001_initial.sql",
        "002_feedback_correction.sql",
        "003_feedback_identity_review_request.sql",
        "004_answer_reviews.sql",
        "005_issue_center.sql",
        "006_single_admin_workflow.sql",
        "007_knowledge_repair_workflow.sql",
        "008_repair_batches.sql",
        "009_conversation_context.sql",
      ]) {
        if (applied.has(fileName)) continue;
        const migration = await readFile(fileURLToPath(
          new URL(`../migrations/${fileName}`, import.meta.url),
        ), "utf8");
        await client.query(migration);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [fileName],
        );
      }
    }finally{
      await client.query("SELECT pg_advisory_unlock(hashtext($1))",[lockKey]).catch(()=>undefined);
      client.release();
    }
  }
  async ping(): Promise<boolean> {
    try { await this.pool.query("SELECT 1"); return true; } catch { return false; }
  }
  async close(): Promise<void> { await this.pool.end(); }

  async getConversationContext(pseudonymousUserId:string,at:string,maxTurns:number):Promise<ConversationContextView>{
    const session=optional<ConversationSession>(await this.pool.query(`SELECT * FROM conversation_sessions
      WHERE pseudonymous_user_id=$1 AND ended_at IS NULL AND expires_at>$2 ORDER BY started_at DESC LIMIT 1`,[pseudonymousUserId,at]));
    if(session===undefined)return{recentTurns:[]};return{session,recentTurns:await this.listConversationTurns(session.sessionId,maxTurns)};
  }
  async appendConversationTurn(v:ConversationTurnInput):Promise<ConversationTurn>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`conversation:${v.pseudonymousUserId}`]);
      const duplicate=optional<ConversationTurn>(await client.query("SELECT * FROM conversation_turns WHERE request_id=$1",[v.requestId]));if(duplicate!==undefined){await client.query("COMMIT");return duplicate;}
      if(v.forceNewSession===true)await client.query(`UPDATE conversation_sessions SET ended_at=$2,end_reason='manual'
        WHERE pseudonymous_user_id=$1 AND ended_at IS NULL`,[v.pseudonymousUserId,v.answeredAt]);
      await client.query(`UPDATE conversation_sessions SET ended_at=$2,end_reason='idle'
        WHERE pseudonymous_user_id=$1 AND ended_at IS NULL AND expires_at<=$2`,[v.pseudonymousUserId,v.answeredAt]);
      let session=optional<ConversationSession>(await client.query(`SELECT * FROM conversation_sessions
        WHERE pseudonymous_user_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,[v.pseudonymousUserId]));
      if(session===undefined){session=map<ConversationSession>(await one(client,`INSERT INTO conversation_sessions
        (session_id,pseudonymous_user_id,source,started_at,last_activity_at,expires_at) VALUES ($1,$2,$3,$4,$4,$5) RETURNING *`,[randomUUID(),v.pseudonymousUserId,v.source,v.answeredAt,v.expiresAt]));}
      const latest=optional<ConversationTurn>(await client.query("SELECT * FROM conversation_turns WHERE session_id=$1 ORDER BY turn_index DESC LIMIT 1 FOR UPDATE",[session.sessionId]));
      const parent=v.contextUsed?latest:undefined,turnIndex=(latest?.turnIndex??0)+1;
      const turn=map<ConversationTurn>(await one(client,`INSERT INTO conversation_turns
        (turn_id,session_id,turn_index,request_id,question_id,parent_turn_id,parent_request_id,raw_question,resolved_question,context_used,inherited_subjects,answer_outline,answer_status,scope,answer_card_match,answered_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,[v.turnId,session.sessionId,turnIndex,v.requestId,v.questionId,parent?.turnId??null,parent?.requestId??null,v.rawQuestion,v.resolvedQuestion,v.contextUsed,JSON.stringify(v.inheritedSubjects),v.answerOutline??null,v.answerStatus,v.scope??null,v.answerCardMatch??null,v.answeredAt]));
      await client.query("UPDATE conversation_sessions SET last_activity_at=$2,expires_at=$3 WHERE session_id=$1",[session.sessionId,v.answeredAt,v.expiresAt]);await client.query("COMMIT");return turn;
    }catch(error){await safeRollback(client);throw error;}finally{client.release();}
  }
  async endConversation(pseudonymousUserId:string,reason:ConversationEndReason,endedAt:string){return optional<ConversationSession>(await this.pool.query(`UPDATE conversation_sessions SET ended_at=$3,end_reason=$2
    WHERE session_id=(SELECT session_id FROM conversation_sessions WHERE pseudonymous_user_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1) RETURNING *`,[pseudonymousUserId,reason,endedAt]));}
  async getConversationTurnByRequestId(requestId:string){return optional<ConversationTurn>(await this.pool.query("SELECT * FROM conversation_turns WHERE request_id=$1",[requestId]));}
  async listConversationTurns(sessionId:string,limit:number){const result=await this.pool.query(`SELECT * FROM (SELECT * FROM conversation_turns WHERE session_id=$1 ORDER BY turn_index DESC LIMIT $2) recent ORDER BY turn_index`,[sessionId,limit]);return rows<ConversationTurn>(result);}
  async getConversationSession(sessionId:string){return optional<ConversationSession>(await this.pool.query("SELECT * FROM conversation_sessions WHERE session_id=$1",[sessionId]));}

  async insertAnswerReviewAndEnqueue(v:StoredAnswerReviewCase):Promise<{readonly review:StoredAnswerReviewCase;readonly enqueued:boolean}>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const inserted=await client.query(`INSERT INTO answer_review_cases
        (review_id,request_id,pseudonymous_user_id,processing_status,verdict,workflow_status,encrypted_payload,answer_status,scope,reference_count,source,model,score,defect_count,error_code,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (request_id) DO NOTHING RETURNING *`,
        [v.reviewId,v.requestId,v.pseudonymousUserId,v.processingStatus,v.verdict,v.workflowStatus,v.encryptedPayload,v.answerStatus,v.scope??null,v.referenceCount,v.source,v.model,v.score??null,v.defectCount,v.errorCode??null,v.createdAt,v.updatedAt]);
      if(inserted.rows[0]===undefined){const existing=await client.query("SELECT * FROM answer_review_cases WHERE request_id=$1",[v.requestId]);await client.query("COMMIT");if(existing.rows[0]===undefined)throw new Error("database_write_failed");return{review:map<StoredAnswerReviewCase>(existing.rows[0]),enqueued:false};}
      await client.query(`INSERT INTO ops_jobs
        (job_id,type,payload,status,attempts,available_at,created_at,updated_at)
        VALUES ($1,'answer_review',$2,'queued',0,now(),now(),now())`,[randomUUID(),{reviewId:v.reviewId}]);
      await client.query("COMMIT");return{review:map<StoredAnswerReviewCase>(inserted.rows[0]),enqueued:true};
    }catch(error){await safeRollback(client);throw error;}finally{client.release();}
  }
  async listAnswerReviews(){return rows<StoredAnswerReviewCase>(await this.pool.query("SELECT * FROM answer_review_cases ORDER BY created_at DESC"));}
  async getAnswerReview(id:string){return optional<StoredAnswerReviewCase>(await this.pool.query("SELECT * FROM answer_review_cases WHERE review_id=$1",[id]));}
  async getAnswerReviewByRequestId(requestId:string){return optional<StoredAnswerReviewCase>(await this.pool.query("SELECT * FROM answer_review_cases WHERE request_id=$1",[requestId]));}
  async updateAnswerReviewWorkflow(id:string,workflowStatus:StoredAnswerReviewCase["workflowStatus"]){return optional<StoredAnswerReviewCase>(await this.pool.query("UPDATE answer_review_cases SET workflow_status=$2,updated_at=now() WHERE review_id=$1 RETURNING *",[id,workflowStatus]));}
  async updateAnswerReviewMachine(id:string,patch:Partial<Pick<StoredAnswerReviewCase,"processingStatus"|"verdict"|"workflowStatus"|"encryptedPayload"|"score"|"defectCount"|"errorCode">>){
    const current=await this.getAnswerReview(id);if(current===undefined)return undefined;
    return optional<StoredAnswerReviewCase>(await this.pool.query(`UPDATE answer_review_cases SET
      processing_status=$2,verdict=$3,workflow_status=$4,encrypted_payload=$5,score=$6,defect_count=$7,error_code=$8,updated_at=now()
      WHERE review_id=$1 RETURNING *`,[id,patch.processingStatus??current.processingStatus,patch.verdict??current.verdict,patch.workflowStatus??current.workflowStatus,patch.encryptedPayload??current.encryptedPayload,patch.score??current.score??null,patch.defectCount??current.defectCount,patch.errorCode??current.errorCode??null]));
  }

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
  async getFeedbackByRequestId(requestId:string){return optional<StoredFeedbackCase>(await this.pool.query("SELECT * FROM feedback_cases WHERE request_id=$1",[requestId]));}
  async updateFeedback(id: string,patch: Pick<Partial<StoredFeedbackCase>,"status"|"classification">) {
    const current=await this.getFeedback(id);if(current===undefined)return undefined;
    return optional<StoredFeedbackCase>(await this.pool.query(
      "UPDATE feedback_cases SET status=$2,classification=$3,updated_at=now() WHERE case_id=$1 RETURNING *",
      [id,patch.status??current.status,patch.classification??current.classification],
    ));
  }

  async recordIssue(v:IssueRecordInput):Promise<IssueCaseSummary>{
    const client=await this.pool.connect();let issueId:string|undefined;
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`issue-request:${v.occurrence.requestId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`issue-fingerprint:${v.fingerprint}`]);
      const recorded=await client.query("SELECT issue_id FROM issue_occurrences WHERE source_type=$1 AND source_id=$2",[v.occurrence.sourceType,v.occurrence.sourceId]);
      if(recorded.rows[0]!==undefined){issueId=String(recorded.rows[0].issue_id);await client.query("COMMIT");}
      else{
      const linked=await client.query(`SELECT c.* FROM issue_cases c JOIN issue_occurrences o ON o.issue_id=c.issue_id
        WHERE o.request_id=$1 ORDER BY c.created_at LIMIT 1 FOR UPDATE OF c`,[v.occurrence.requestId]);
      const matching=linked.rows[0]===undefined?await client.query("SELECT * FROM issue_cases WHERE fingerprint=$1 FOR UPDATE",[v.fingerprint]):linked;
      if(matching.rows[0]===undefined){
        issueId=randomUUID();
        await client.query(`INSERT INTO issue_cases
          (issue_id,fingerprint,title,priority,status,category,scope,answer_card_key,sla_due_at,first_seen_at,last_seen_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$9,now(),now())`,
          [issueId,v.fingerprint,v.title,v.priority,v.category,v.scope??null,v.answerCardKey??null,slaDeadline(v.occurredAt,v.priority),v.occurredAt]);
      }else{
        const existing=map<IssueCase>(matching.rows[0]);issueId=existing.issueId;const escalated=isHigherPriority(v.priority,existing.priority);
        await client.query(`UPDATE issue_cases SET
          priority=$2,title=$3,category=$4,scope=COALESCE(scope,$5),answer_card_key=COALESCE(answer_card_key,$6),
          status=CASE WHEN status IN ('resolved','dismissed') THEN 'open' ELSE status END,
          sla_due_at=$7,last_seen_at=GREATEST(last_seen_at,$8),updated_at=now() WHERE issue_id=$1`,
          [issueId,escalated?v.priority:existing.priority,escalated?v.title:existing.title,escalated?v.category:existing.category,v.scope??null,v.answerCardKey??null,escalated?slaDeadline(v.occurredAt,v.priority):existing.slaDueAt,v.occurredAt]);
      }
      await client.query(`INSERT INTO issue_occurrences
        (occurrence_id,issue_id,source_type,source_id,request_id,pseudonymous_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_type,source_id) DO NOTHING`,
        [randomUUID(),issueId,v.occurrence.sourceType,v.occurrence.sourceId,v.occurrence.requestId,v.occurrence.pseudonymousUserId,v.occurredAt]);
      await client.query("COMMIT");
      }
    }catch(error){await safeRollback(client);throw error;}finally{client.release();}
    const result=issueId===undefined?undefined:await this.getIssue(issueId);if(result===undefined)throw new Error("database_write_failed");return result;
  }
  async listIssues(query:IssueListQuery):Promise<IssuePage>{
    const values=[query.status??null,query.priority??null,query.actionableOnly??false,query.limit,query.offset];
    const where="WHERE ($1::text IS NULL OR c.status=$1) AND ($2::text IS NULL OR c.priority=$2) AND (NOT $3::boolean OR c.status NOT IN ('resolved','dismissed'))";
    const [items,total]=await Promise.all([
      this.pool.query(`SELECT c.*,COUNT(DISTINCT o.request_id)::int AS occurrence_count,COUNT(DISTINCT o.pseudonymous_user_id)::int AS affected_user_count
        FROM issue_cases c LEFT JOIN issue_occurrences o ON o.issue_id=c.issue_id ${where}
        GROUP BY c.issue_id ORDER BY CASE c.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,c.last_seen_at DESC LIMIT $4 OFFSET $5`,values),
      this.pool.query(`SELECT COUNT(*)::int AS count FROM issue_cases c ${where}`,[values[0],values[1],values[2]]),
    ]);
    return{items:rows<IssueCaseSummary>(items),total:Number(total.rows[0]?.count??0)};
  }
  async getIssue(id:string):Promise<IssueCaseSummary|undefined>{return optional<IssueCaseSummary>(await this.pool.query(`SELECT c.*,COUNT(DISTINCT o.request_id)::int AS occurrence_count,COUNT(DISTINCT o.pseudonymous_user_id)::int AS affected_user_count
    FROM issue_cases c LEFT JOIN issue_occurrences o ON o.issue_id=c.issue_id WHERE c.issue_id=$1 GROUP BY c.issue_id`,[id]));}
  async listIssueOccurrences(id:string){return rows<IssueOccurrence>(await this.pool.query("SELECT * FROM issue_occurrences WHERE issue_id=$1 ORDER BY created_at DESC",[id]));}
  async updateIssue(id:string,status:IssueStatus){const current=await this.getIssue(id);if(current===undefined)return undefined;await this.pool.query("UPDATE issue_cases SET status=$2,updated_at=now() WHERE issue_id=$1",[id,status]);return this.getIssue(id);}

  async createRepairDraft(v:KnowledgeRepairDraft){return map<KnowledgeRepairDraft>(await one(this.pool,`INSERT INTO knowledge_repair_drafts
    (draft_id,issue_id,status,target_kind,target_domain,target_path,base_git_revision,model,encrypted_payload,created_by,error_code,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [v.draftId,v.issueId,v.status,v.targetKind??null,v.targetDomain??null,v.targetPath??null,v.baseGitRevision??null,v.model,v.encryptedPayload,v.createdBy,v.errorCode??null,v.createdAt,v.updatedAt]));}
  async getRepairDraft(id:string){return optional<KnowledgeRepairDraft>(await this.pool.query("SELECT * FROM knowledge_repair_drafts WHERE draft_id=$1",[id]));}
  async listRepairDrafts(issueId:string){return rows<KnowledgeRepairDraft>(await this.pool.query("SELECT * FROM knowledge_repair_drafts WHERE issue_id=$1 ORDER BY created_at DESC",[issueId]));}
  async listRepairDraftsByStatus(status:KnowledgeRepairDraft["status"]){return rows<KnowledgeRepairDraft>(await this.pool.query("SELECT * FROM knowledge_repair_drafts WHERE status=$1 ORDER BY created_at DESC",[status]));}
  async updateRepairDraft(id:string,patch:Partial<Pick<KnowledgeRepairDraft,"status"|"targetKind"|"targetDomain"|"targetPath"|"baseGitRevision"|"encryptedPayload"|"errorCode">>){const current=await this.getRepairDraft(id);if(current===undefined)return undefined;return optional<KnowledgeRepairDraft>(await this.pool.query(`UPDATE knowledge_repair_drafts SET
    status=$2,target_kind=$3,target_domain=$4,target_path=$5,base_git_revision=$6,encrypted_payload=$7,error_code=$8,updated_at=now()
    WHERE draft_id=$1 RETURNING *`,[id,patch.status??current.status,patch.targetKind??current.targetKind??null,patch.targetDomain??current.targetDomain??null,patch.targetPath??current.targetPath??null,patch.baseGitRevision??current.baseGitRevision??null,patch.encryptedPayload??current.encryptedPayload,patch.errorCode??current.errorCode??null]));}
  async createRepairValidation(v:RepairValidationRun){return map<RepairValidationRun>(await one(this.pool,`INSERT INTO repair_validation_runs
    (validation_id,draft_id,issue_id,status,total_cases,passed_cases,model,encrypted_payload,error_code,created_at,completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[v.validationId,v.draftId,v.issueId,v.status,v.totalCases,v.passedCases,v.model,v.encryptedPayload,v.errorCode??null,v.createdAt,v.completedAt??null]));}
  async getRepairValidation(id:string){return optional<RepairValidationRun>(await this.pool.query("SELECT * FROM repair_validation_runs WHERE validation_id=$1",[id]));}
  async listRepairValidations(draftId:string){return rows<RepairValidationRun>(await this.pool.query("SELECT * FROM repair_validation_runs WHERE draft_id=$1 ORDER BY created_at DESC",[draftId]));}
  async updateRepairValidation(id:string,patch:Partial<Pick<RepairValidationRun,"status"|"totalCases"|"passedCases"|"encryptedPayload"|"errorCode"|"completedAt">>){const current=await this.getRepairValidation(id);if(current===undefined)return undefined;return optional<RepairValidationRun>(await this.pool.query(`UPDATE repair_validation_runs SET
    status=$2,total_cases=$3,passed_cases=$4,encrypted_payload=$5,error_code=$6,completed_at=$7 WHERE validation_id=$1 RETURNING *`,[id,patch.status??current.status,patch.totalCases??current.totalCases,patch.passedCases??current.passedCases,patch.encryptedPayload??current.encryptedPayload,patch.errorCode??current.errorCode??null,patch.completedAt??current.completedAt??null]));}
  async createRepairPublication(v:RepairPublication){return map<RepairPublication>(await one(this.pool,`INSERT INTO repair_publications
    (publication_id,batch_id,draft_id,issue_id,status,target_domain,target_path,base_git_revision,remote_sync_status,remote_name,remote_branch,resulting_git_revision,catalog_hash,snapshot_release_id,previous_release_id,created_by,error_code,created_at,published_at,rolled_back_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[v.publicationId,v.batchId??null,v.draftId,v.issueId,v.status,v.targetDomain,v.targetPath,v.baseGitRevision,v.remoteSyncStatus,v.remoteName??null,v.remoteBranch??null,v.resultingGitRevision??null,v.catalogHash??null,v.snapshotReleaseId??null,v.previousReleaseId??null,v.createdBy,v.errorCode??null,v.createdAt,v.publishedAt??null,v.rolledBackAt??null]));}
  async getRepairPublication(id:string){return optional<RepairPublication>(await this.pool.query("SELECT * FROM repair_publications WHERE publication_id=$1",[id]));}
  async listRepairPublications(draftId:string){return rows<RepairPublication>(await this.pool.query("SELECT * FROM repair_publications WHERE draft_id=$1 ORDER BY created_at DESC",[draftId]));}
  async updateRepairPublication(id:string,patch:Partial<Pick<RepairPublication,"status"|"remoteSyncStatus"|"remoteName"|"remoteBranch"|"resultingGitRevision"|"catalogHash"|"snapshotReleaseId"|"previousReleaseId"|"errorCode"|"publishedAt"|"rolledBackAt">>){const current=await this.getRepairPublication(id);if(current===undefined)return undefined;return optional<RepairPublication>(await this.pool.query(`UPDATE repair_publications SET
    status=$2,remote_sync_status=$3,remote_name=$4,remote_branch=$5,resulting_git_revision=$6,catalog_hash=$7,snapshot_release_id=$8,previous_release_id=$9,error_code=$10,published_at=$11,rolled_back_at=$12 WHERE publication_id=$1 RETURNING *`,[id,patch.status??current.status,patch.remoteSyncStatus??current.remoteSyncStatus,patch.remoteName??current.remoteName??null,patch.remoteBranch??current.remoteBranch??null,patch.resultingGitRevision??current.resultingGitRevision??null,patch.catalogHash??current.catalogHash??null,patch.snapshotReleaseId??current.snapshotReleaseId??null,patch.previousReleaseId??current.previousReleaseId??null,patch.errorCode??current.errorCode??null,patch.publishedAt??current.publishedAt??null,patch.rolledBackAt??current.rolledBackAt??null]));}
  async createRepairBatch(v:RepairBatch,publications:readonly RepairPublication[]):Promise<RepairBatchView>{
    if(publications.length!==v.itemCount||publications.length===0)throw new Error("repair_batch_item_count_invalid");
    const client=await this.pool.connect();const createdPublications:RepairPublication[]=[];
    try{
      await client.query("BEGIN");
      const draftIds=publications.map((item)=>item.draftId),locked=await client.query("SELECT draft_id,status FROM knowledge_repair_drafts WHERE draft_id=ANY($1::uuid[]) FOR UPDATE",[draftIds]);
      if(locked.rows.length!==draftIds.length)throw new Error("repair_batch_source_not_found");
      if(locked.rows.some((row)=>row.status!=="ready_to_publish"))throw new Error("repair_draft_not_ready_for_batch");
      const batch=map<RepairBatch>(await one(client,`INSERT INTO repair_batches
        (batch_id,status,item_count,domains,catalog_hash,snapshot_release_id,previous_release_id,created_by,error_code,created_at,published_at,rolled_back_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[v.batchId,v.status,v.itemCount,JSON.stringify(v.domains),v.catalogHash??null,v.snapshotReleaseId??null,v.previousReleaseId??null,v.createdBy,v.errorCode??null,v.createdAt,v.publishedAt??null,v.rolledBackAt??null]));
      for(const publication of publications)createdPublications.push(map<RepairPublication>(await one(client,`INSERT INTO repair_publications
        (publication_id,batch_id,draft_id,issue_id,status,target_domain,target_path,base_git_revision,remote_sync_status,remote_name,remote_branch,resulting_git_revision,catalog_hash,snapshot_release_id,previous_release_id,created_by,error_code,created_at,published_at,rolled_back_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,[publication.publicationId,v.batchId,publication.draftId,publication.issueId,publication.status,publication.targetDomain,publication.targetPath,publication.baseGitRevision,publication.remoteSyncStatus,publication.remoteName??null,publication.remoteBranch??null,publication.resultingGitRevision??null,publication.catalogHash??null,publication.snapshotReleaseId??null,publication.previousReleaseId??null,publication.createdBy,publication.errorCode??null,publication.createdAt,publication.publishedAt??null,publication.rolledBackAt??null])));
      await client.query("UPDATE knowledge_repair_drafts SET status='publishing',updated_at=now() WHERE draft_id=ANY($1::uuid[])",[draftIds]);
      await client.query("UPDATE issue_cases SET status='validating',updated_at=now() WHERE issue_id=ANY($1::uuid[])",[publications.map((item)=>item.issueId)]);
      await client.query("COMMIT");return{...batch,publications:createdPublications};
    }catch(error){await safeRollback(client);throw error;}finally{client.release();}
  }
  async getRepairBatch(id:string):Promise<RepairBatchView|undefined>{const batch=optional<RepairBatch>(await this.pool.query("SELECT * FROM repair_batches WHERE batch_id=$1",[id]));return batch===undefined?undefined:{...batch,publications:await this.listRepairPublicationsByBatch(id)};}
  async listRepairBatches(){return rows<RepairBatch>(await this.pool.query("SELECT * FROM repair_batches ORDER BY created_at DESC"));}
  async updateRepairBatch(id:string,patch:Partial<Pick<RepairBatch,"status"|"catalogHash"|"snapshotReleaseId"|"previousReleaseId"|"errorCode"|"publishedAt"|"rolledBackAt">>){const current=optional<RepairBatch>(await this.pool.query("SELECT * FROM repair_batches WHERE batch_id=$1",[id]));if(current===undefined)return undefined;return optional<RepairBatch>(await this.pool.query(`UPDATE repair_batches SET
    status=$2,catalog_hash=$3,snapshot_release_id=$4,previous_release_id=$5,error_code=$6,published_at=$7,rolled_back_at=$8 WHERE batch_id=$1 RETURNING *`,[id,patch.status??current.status,patch.catalogHash??current.catalogHash??null,patch.snapshotReleaseId??current.snapshotReleaseId??null,patch.previousReleaseId??current.previousReleaseId??null,patch.errorCode??current.errorCode??null,patch.publishedAt??current.publishedAt??null,patch.rolledBackAt??current.rolledBackAt??null]));}
  async listRepairPublicationsByBatch(id:string){return rows<RepairPublication>(await this.pool.query("SELECT * FROM repair_publications WHERE batch_id=$1 ORDER BY created_at",[id]));}

  async createCardRevision(v: CardRevision) {
    const row = await one(this.pool, `INSERT INTO card_revisions
      (revision_id,card_id,domain,revision,status,content,created_by,base_git_revision,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [v.revisionId,v.cardId,v.domain,v.revision,v.status,v.content,v.createdBy,v.baseGitRevision,v.createdAt,v.updatedAt]);
    return map<CardRevision>(row);
  }
  async syncCatalogCardRevision(v: CatalogCardRevisionInput): Promise<CatalogCardSyncResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [v.cardId]);
      const current = await client.query(
        "SELECT * FROM card_revisions WHERE card_id=$1 ORDER BY revision DESC FOR UPDATE",
        [v.cardId],
      );
      const existing = current.rows.map((row) => map<CardRevision>(row)).find((revision) =>
        revision.createdBy === "catalog-sync" &&
        revision.status === v.status &&
        revision.baseGitRevision === v.baseGitRevision &&
        stableJson(revision.content) === stableJson(v.content),
      );
      if (existing !== undefined) {
        await client.query("COMMIT");
        return { revision: existing, created: false };
      }
      const revision = Math.max(0, ...current.rows.map((row) => Number(row.revision))) + 1;
      const inserted = await client.query(`INSERT INTO card_revisions
        (revision_id,card_id,domain,revision,status,content,created_by,base_git_revision,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'catalog-sync',$7,now(),now()) RETURNING *`,
        [randomUUID(),v.cardId,v.domain,revision,v.status,v.content,v.baseGitRevision]);
      await client.query("COMMIT");
      if (inserted.rows[0] === undefined) throw new Error("database_write_failed");
      return { revision: map<CardRevision>(inserted.rows[0]), created: true };
    } catch (error) { await safeRollback(client); throw error; } finally { client.release(); }
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
      [v.caseId,v.domain,v.question,v.expectedCardId ?? null,JSON.stringify(v.requiredObligationIds),JSON.stringify(v.forbiddenClaims),v.kind,v.enabled]));
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
  async claimJob(workerId: string,types?:readonly OpsJobType[]): Promise<OpsJob|undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`WITH candidate AS (
        SELECT job_id FROM ops_jobs WHERE status='queued' AND available_at<=now()
          AND ($2::text[] IS NULL OR type=ANY($2::text[]))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE ops_jobs j SET status='running',attempts=j.attempts+1,locked_by=$1,locked_at=now(),updated_at=now()
        FROM candidate WHERE j.job_id=candidate.job_id RETURNING j.*`,[workerId,types===undefined?null:[...types]]);
      await client.query("COMMIT");
      return result.rows[0] === undefined ? undefined : map<OpsJob>(result.rows[0]);
    } catch (error) { await safeRollback(client); throw error; } finally { client.release(); }
  }
  async withResourceLock<T>(key:string,operation:()=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();let locked=false;
    try{await client.query("SELECT pg_advisory_lock(hashtext($1))",[key]);locked=true;return await operation();}
    finally{try{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext($1))",[key]);}finally{client.release();}}
  }
  async completeJob(id: string,result: Record<string,unknown>) { await this.pool.query("UPDATE ops_jobs SET status='completed',result=$2,updated_at=now() WHERE job_id=$1",[id,result]); }
  async failJob(id: string,errorCode: string) { await this.pool.query("UPDATE ops_jobs SET status='failed',error_code=$2,updated_at=now() WHERE job_id=$1",[id,errorCode]); }
  async listJobs() { return rows<OpsJob>(await this.pool.query("SELECT * FROM ops_jobs ORDER BY created_at DESC")); }

  async createRelease(v: ReleaseRecord) {
    return map<ReleaseRecord>(await one(this.pool, `INSERT INTO releases
      (release_id,professional_revision,general_revision,answer_contract_revision,card_catalog_hash,regression_run_id,manifest,status,created_by,approved_by,created_at,activated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [v.releaseId,v.professionalRevision,v.generalRevision,v.answerContractRevision,v.cardCatalogHash,v.regressionRunId,v.manifest,v.status,v.createdBy,JSON.stringify(v.approvedBy),v.createdAt,v.activatedAt ?? null]));
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
    const [issueRows,feedback,reviews,cards,jobs,release,readyDrafts,batches] = await Promise.all([
      this.pool.query(`SELECT priority,count(*)::int AS count,
        count(*) FILTER (WHERE sla_due_at<now())::int AS overdue,
        count(*) FILTER (WHERE status='validating')::int AS validating
        FROM issue_cases WHERE status NOT IN ('resolved','dismissed') GROUP BY priority`),
      this.pool.query("SELECT status,count(*)::int AS count FROM feedback_cases GROUP BY status"),
      this.pool.query("SELECT processing_status,verdict,workflow_status,count(*)::int AS count FROM answer_review_cases GROUP BY processing_status,verdict,workflow_status"),
      this.pool.query("SELECT status,count(*)::int AS count FROM card_revisions GROUP BY status"),
      this.pool.query("SELECT status,count(*)::int AS count FROM ops_jobs GROUP BY status"),
      this.pool.query("SELECT release_id FROM releases WHERE status='active' LIMIT 1"),
      this.pool.query("SELECT count(*)::int AS count FROM knowledge_repair_drafts WHERE status='ready_to_publish'"),
      this.pool.query("SELECT status,count(*)::int AS count FROM repair_batches WHERE status<>'rolled_back' GROUP BY status"),
    ]);
    const byPriority={p0:0,p1:0,p2:0,p3:0};let actionable=0,overdue=0,validating=0;
    for(const row of issueRows.rows){const priority=row.priority as keyof typeof byPriority,count=Number(row.count);byPriority[priority]=count;actionable+=count;overdue+=Number(row.overdue);validating+=Number(row.validating);}
    const feedbackCounts = { new:0,triaged:0,in_review:0,resolved:0,rejected:0 };
    for (const row of feedback.rows) feedbackCounts[row.status as keyof typeof feedbackCounts] = row.count as number;
    const jobCounts = { queued:0,running:0,completed:0,failed:0 };
    for (const row of jobs.rows) jobCounts[row.status as keyof typeof jobCounts] = row.count as number;
    const cardsByStatus: DashboardSummary["cardsByStatus"] = {};
    for (const row of cards.rows) cardsByStatus[row.status as keyof typeof cardsByStatus] = row.count as number;
    const activeReleaseId = release.rows[0]?.release_id as string|undefined;
    const answerReviews={pendingHuman:0,passed:0,errored:0,total:0};
    for(const row of reviews.rows){const count=row.count as number;answerReviews.total+=count;if(row.verdict==="pass")answerReviews.passed+=count;if(row.processing_status==="errored")answerReviews.errored+=count;if(row.workflow_status==="open"&&(row.verdict==="needs_review"||row.verdict==="fail"||row.processing_status==="errored"))answerReviews.pendingHuman+=count;}
    const repairBatches={queued:0,publishing:0,published:0,failed:0};for(const row of batches.rows)repairBatches[row.status as keyof typeof repairBatches]=Number(row.count);
    return { issues:{actionable,urgent:byPriority.p0+byPriority.p1,overdue,validating,readyToPublish:Number(readyDrafts.rows[0]?.count??0),byPriority},repairBatches,feedback:feedbackCounts,answerReviews,cardsByStatus,jobs:jobCounts,...(activeReleaseId?{activeReleaseId}:{}) };
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
function map<T>(row:QueryResultRow):T { const output:Record<string,unknown>={}; for(const [key,value] of Object.entries(row)){if(value===null)continue;output[key.replace(/_([a-z])/gu,(_,letter:string)=>letter.toUpperCase())]=value instanceof Date?value.toISOString():value;} return output as T; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const ISSUE_PRIORITY_ORDER={p0:0,p1:1,p2:2,p3:3} as const;
function isHigherPriority(candidate:IssueCase["priority"],current:IssueCase["priority"]):boolean{return ISSUE_PRIORITY_ORDER[candidate]<ISSUE_PRIORITY_ORDER[current];}
function slaDeadline(occurredAt:string,priority:IssueCase["priority"]):string{const hours={p0:2,p1:8,p2:24,p3:72}[priority];return new Date(new Date(occurredAt).valueOf()+hours*60*60_000).toISOString();}
