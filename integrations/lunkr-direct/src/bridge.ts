import { randomUUID } from "node:crypto";
import {
  normalizeAnswerText,
  presentAnswer,
  presentLongAnswerNotice,
} from "./answer-presenter.js";
import type {
  BridgeAnswerCardActivationSummary,
  BridgeAnswerReviewSubmission,
  BridgeReviewReference,
} from "./answer-review-submission.js";
import type { LunkrDirectConfig } from "./config.js";
import { buildAnswerOutline, ConversationStore } from "./conversation-store.js";
import type { BridgeConversationDependencies } from "./conversation-persistence.js";
export type { BridgeConversationDependencies } from "./conversation-persistence.js";
import type { LunkrDirectMessage } from "./contracts.js";
import { MessageDedupe } from "./dedupe.js";
import {
  FeedbackReceiptStore,
  pseudonymizeFeedbackUser,
  type BridgeFeedbackSubmission,
  type FeedbackAnswerCardSummary,
} from "./feedback-receipt-store.js";
import {
  PeerScheduler,
  type AdmissionNotice,
  type QuestionStart,
} from "./peer-scheduler.js";

const FAILURE_TEXT = "知识问答服务暂时不可用，请稍后重试。";

const HELP_TEXT = [
  "我是 PSEAgent 企业知识助手。",
  "直接发送文字即可提问；我会检索并核对相关资料后回答。",
  "发送 /new 可取消当前题和排队题，并清空连续对话上下文。",
  "发送 /status 可查看正在处理和排队的问题。",
  "回答后发送 /q 1-4 可快捷反馈；不确定时可用 /q 4 请求人工复查。",
  "当前暂不支持群聊、图片、文件或语音。",
].join("\n");

const PROCESSING_COMMAND_GUIDE = [
  "",
  "",
  "处理期间可以：",
  "/status  查看问题状态",
  "/new     取消当前及排队问题，开始新会话",
  "         独立问题建议先用 /new，可清除上下文并提高回答准确率",
  "/help    查看全部使用说明",
].join("\n");

const FEEDBACK_MENU = [
  "—",
  "这次回答怎么样？回复一条命令就可以：",
  "",
  "/q 1  有帮助",
  "/q 2  有错误",
  "/q 3  没讲全",
  "/q 4  我不确定，请人工复查",
  "",
  "愿意补充时，直接写在命令后面，例如：",
  "/q 3 没提到客户端专用密码",
].join("\n");

export type BridgeCoverage = "complete" | "partial" | "none";
export type BridgeDeliveryMode =
  | "text"
  | "combined_attachment"
  | "standalone_post"
  | "segmented_text";

export type BridgeAnswerProgressStage =
  | "understanding"
  | "planning"
  | "retrieving"
  | "reviewing_evidence"
  | "composing"
  | "verifying"
  | "preparing_delivery";

export interface BridgeAnswerProgress {
  readonly stage: BridgeAnswerProgressStage;
  readonly requirementCount?: number;
  readonly retrievalCompletedCount?: number;
  readonly evidenceReadCount?: number;
  readonly coveredRequirementCount?: number;
  readonly coverageRequirementCount?: number;
}

export type BridgeHistoricalGateReason =
  | "eligible"
  | "question_not_explicit_coremail"
  | "formal_verification_incomplete"
  | "formal_support_present"
  | "structural_fallback";
export type BridgeHistoricalRejectionReason =
  | "topic_mismatch"
  | "low_confidence"
  | "no_reliable_source";

export interface BridgeAnswerMetadata {
  readonly requestId?: string | undefined;
  readonly scope?: string | undefined;
  readonly status?: string | undefined;
  readonly retryable: boolean;
  readonly stopReason?: string | undefined;
  readonly referenceCount: number;
  readonly historicalAttempted: boolean;
  readonly historicalUsed: boolean;
  readonly historicalNoticeShown?: boolean | undefined;
  readonly historicalRejectedReason?: BridgeHistoricalRejectionReason | undefined;
  readonly draftCoverage?: readonly BridgeCoverage[] | undefined;
  readonly verifiedCoverage?: readonly BridgeCoverage[] | undefined;
  readonly retainedDirectSegmentCount?: number | undefined;
  readonly retainedSynthesizedSegmentCount?: number | undefined;
  readonly removedSegmentCount?: number | undefined;
  readonly historicalGateReason?: BridgeHistoricalGateReason | undefined;
  readonly answerCardMatch?: FeedbackAnswerCardSummary | undefined;
  readonly answerCardActivation?: BridgeAnswerCardActivationSummary | undefined;
  readonly references?: readonly BridgeReviewReference[] | undefined;
  readonly resolvedQuestion?: string | undefined;
  readonly contextUsed?: boolean | undefined;
  readonly inheritedSubjects?: readonly string[] | undefined;
}

export interface BridgeQuestionEvent {
  readonly type:
    | "received"
    | "queued"
    | "started"
    | "answered"
    | "failed"
    | "cancelled";
  readonly peerUid: string;
  readonly questionId?: number | undefined;
  readonly sessionEpoch?: number | undefined;
  readonly resetReason?: "manual" | "idle" | undefined;
  readonly pendingCount: number;
  readonly activePeerCount: number;
  readonly scope?: string | undefined;
  readonly status?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly elapsedMs?: number | undefined;
  readonly referenceCount?: number | undefined;
  readonly historicalAttempted?: boolean | undefined;
  readonly historicalUsed?: boolean | undefined;
  readonly historicalNoticeShown?: boolean | undefined;
  readonly historicalRejectedReason?: BridgeHistoricalRejectionReason | undefined;
  readonly draftCoverage?: readonly BridgeCoverage[] | undefined;
  readonly verifiedCoverage?: readonly BridgeCoverage[] | undefined;
  readonly retainedDirectSegmentCount?: number | undefined;
  readonly retainedSynthesizedSegmentCount?: number | undefined;
  readonly removedSegmentCount?: number | undefined;
  readonly historicalGateReason?: BridgeHistoricalGateReason | undefined;
  readonly deliveryMode?: BridgeDeliveryMode | undefined;
  readonly answerReviewQueued?: boolean | undefined;
}

export interface LunkrBridgeDependencies<Result> {
  readonly answer: (
    question: string,
    conversationContext?: string,
    signal?: AbortSignal,
    progressObserver?: (progress: BridgeAnswerProgress) => void,
  ) => Promise<Result>;
  readonly formatAnswer: (result: Result) => string;
  /** @deprecated Answer bodies are intentionally excluded from conversation context. */
  readonly formatContextAnswer?: ((result: Result) => string) | undefined;
  readonly describeResult: (result: Result) => BridgeAnswerMetadata;
  readonly sendText: (peerUid: string, text: string) => Promise<void>;
  readonly sendPost: (
    peerUid: string,
    title: string,
    content: string,
  ) => Promise<void>;
  readonly sendTextFile: (
    peerUid: string,
    title: string,
    content: string,
    caption: string,
  ) => Promise<void>;
  readonly onEvent?: ((event: BridgeQuestionEvent) => void) | undefined;
  readonly feedback?: BridgeFeedbackDependencies | undefined;
  readonly answerReview?: BridgeAnswerReviewDependencies | undefined;
  readonly conversation?: BridgeConversationDependencies | undefined;
}

export interface BridgeFeedbackDependencies {
  readonly pseudonymizationKey: string;
  readonly submit: (submission: BridgeFeedbackSubmission) => Promise<void>;
}

export interface BridgeAnswerReviewDependencies {
  readonly pseudonymizationKey: string;
  readonly submit: (submission: BridgeAnswerReviewSubmission) => Promise<void>;
}

export class LunkrPseBridge<Result> {
  private readonly conversations: ConversationStore;
  private readonly dedupe: MessageDedupe;
  private readonly scheduler: PeerScheduler;
  private readonly feedbackReceipts: FeedbackReceiptStore;
  private readonly lastAcceptedQuestionAt = new Map<string, number>();
  private readonly forceNewSessionPeers = new Set<string>();
  private readonly activeProgress = new Map<string, ActiveQuestionProgress>();

  constructor(
    private readonly config: LunkrDirectConfig,
    private readonly dependencies: LunkrBridgeDependencies<Result>,
    private readonly now: () => number = Date.now,
  ) {
    this.conversations = new ConversationStore(
      config.contextMaxTurns,
      config.contextMaxChars,
    );
    this.dedupe = new MessageDedupe(
      config.messageDedupeTtlMs,
      config.messageDedupeMax,
      now,
    );
    this.scheduler = new PeerScheduler(
      config.maxActivePeers,
      config.maxPendingPerPeer,
    );
    this.feedbackReceipts = new FeedbackReceiptStore(
      config.feedbackReceiptTtlMs,
      config.feedbackReceiptMax,
      now,
    );
  }

  handle(message: LunkrDirectMessage): Promise<void> {
    if (!this.dedupe.accept(message.id)) return Promise.resolve();
    if (message.command === "new") return this.resetPeer(message.peerUid);
    if (message.command === "help") {
      return this.sendWithRetry(message.peerUid, HELP_TEXT);
    }
    if (message.command === "status") return this.sendStatus(message.peerUid);
    if (message.command === "feedback") return this.handleFeedback(message);
    if (message.hasAttachments) {
      return this.sendWithRetry(message.peerUid, "当前仅支持文字私聊。");
    }
    if (message.text.trim() === "") return Promise.resolve();
    return this.acceptQuestion(message);
  }

  private acceptQuestion(message: LunkrDirectMessage): Promise<void> {
    const receivedAt = this.now();
    this.expireIdleSession(message.peerUid, receivedAt);
    const deadlineAt = receivedAt + this.config.questionBudgetMs;
    let pendingAtAdmission = 0;
    const receipt = this.scheduler.submit(message.peerUid, {
      accept: async (admission) => {
        pendingAtAdmission = admission.ahead;
        await this.sendAdmissionReply(message.peerUid, admission);
        this.emitAdmission(message.peerUid, admission);
      },
      work: (start) => this.processQuestion(
        message,
        start,
        deadlineAt,
        receivedAt,
        pendingAtAdmission,
      ),
    });
    if (receipt.questionId !== undefined) {
      this.lastAcceptedQuestionAt.set(message.peerUid, receivedAt);
    }
    const questionId = receipt.questionId;
    if (questionId === undefined) return receipt.completion;
    return receipt.completion.finally(() => {
      this.clearProgress(message.peerUid, receipt.epoch, questionId);
    });
  }

  private async sendAdmissionReply(
    peerUid: string,
    admission: AdmissionNotice,
  ): Promise<void> {
    let text: string;
    switch (admission.kind) {
      case "started":
        text = `问题 #${admission.questionId} 已收到，正在检索并核对相关资料。${PROCESSING_COMMAND_GUIDE}`;
        break;
      case "peer_queued":
        text =
          `已收到问题 #${admission.questionId}，前面还有 ${admission.ahead} 个问题，已加入队列。${PROCESSING_COMMAND_GUIDE}`;
        break;
      case "global_queued":
        text =
          `已收到问题 #${admission.questionId}，当前服务繁忙，已进入等待队列。${PROCESSING_COMMAND_GUIDE}`;
        break;
      case "peer_full":
        text = "当前已有较多问题等待处理，请稍后再发送。";
        break;
    }
    await this.sendWithRetry(peerUid, text);
  }

  private async sendStatus(peerUid: string): Promise<void> {
    const statuses = this.scheduler.status(peerUid);
    if (statuses.length === 0) {
      await this.sendWithRetry(
        peerUid,
        "当前没有正在处理或排队的问题。直接发送文字即可提问。",
      );
      return;
    }
    const now = this.now();
    const lines = statuses.map((status) => {
      if (status.state === "processing") {
        const progress = this.activeProgress.get(peerUid);
        if (progress?.questionId !== status.questionId) {
          return `问题 #${status.questionId}：处理中`;
        }
        return formatProcessingStatus(progress, now);
      }
      if (status.waitingForCapacity) {
        return `问题 #${status.questionId}：排队中，正在等待可用处理位`;
      }
      return `问题 #${status.questionId}：排队中，前面还有 ${status.ahead} 个问题`;
    });
    await this.sendWithRetry(
      peerUid,
      ["当前问题状态：", ...lines].join("\n"),
    );
  }

  private emitAdmission(peerUid: string, admission: AdmissionNotice): void {
    this.emit({
      type: admission.kind === "started" ? "received" : "queued",
      peerUid,
      questionId: admission.questionId,
      sessionEpoch: admission.epoch,
      pendingCount: admission.ahead,
      activePeerCount: this.scheduler.activePeerCount,
    });
  }

  private async processQuestion(
    message: LunkrDirectMessage,
    start: QuestionStart,
    deadlineAt: number,
    receivedAt: number,
    pendingAtAdmission: number,
  ): Promise<void> {
    this.beginProgress(start);
    if (start.startedFromQueue) {
      if (!this.isCurrent(start)) return;
      await this.sendWithRetry(
        message.peerUid,
        `问题 #${start.questionId} 已开始处理。`,
      );
      if (!this.isCurrent(start)) return;
      this.emit({
        type: "started",
        peerUid: message.peerUid,
        questionId: start.questionId,
        sessionEpoch: start.epoch,
        pendingCount: Math.max(0, pendingAtAdmission - 1),
        activePeerCount: this.scheduler.activePeerCount,
      });
    }

    if (!this.isCurrent(start)) return;
    const question = message.text.trim();
    const context = await this.conversationContext(message.peerUid, question);
    let result: Result | undefined;
    let metadata: BridgeAnswerMetadata | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const remainingMs = deadlineAt - this.now();
      if (remainingMs <= 0) break;
      const signal = AbortSignal.any([
        start.signal,
        AbortSignal.timeout(Math.max(1, remainingMs)),
      ]);
      try {
        result = await this.dependencies.answer(
          question,
          context,
          signal,
          (progress) => this.updateProgress(start, progress),
        );
      } catch {
        if (!this.isCurrent(start)) return;
        await this.sendFailure(
          message.peerUid,
          start.questionId,
          start.epoch,
          "answer_error",
          receivedAt,
          metadata,
        );
        return;
      }
      if (!this.isCurrent(start)) return;
      metadata = this.dependencies.describeResult(result);
      if (
        metadata.status !== "temporarily_unavailable" ||
        !metadata.retryable ||
        attempt === 2
      ) {
        break;
      }
    }

    if (!this.isCurrent(start)) return;
    if (
      result === undefined ||
      metadata === undefined ||
      metadata.status === "temporarily_unavailable"
    ) {
      await this.sendFailure(
        message.peerUid,
        start.questionId,
        start.epoch,
        metadata?.stopReason ?? "question_budget_exhausted",
        receivedAt,
        metadata,
      );
      return;
    }

    const answer = this.dependencies.formatAnswer(result).trim();
    if (answer === "") {
      await this.sendFailure(
        message.peerUid,
        start.questionId,
        start.epoch,
        "empty_answer",
        receivedAt,
        metadata,
      );
      return;
    }

    const normalizedAnswer = normalizeAnswerText(answer);
    let deliveryMode: BridgeDeliveryMode = "text";
    const chunks = presentAnswer(
      start.questionId,
      normalizedAnswer,
      this.config.messageMaxChars,
    );
    if (chunks.length > 1) {
      if (!this.isCurrent(start)) return;
      const title = `问题#${start.questionId}-完整回答.txt`;
      const caption = presentLongAnswerNotice(
        start.questionId,
        question,
        normalizedAnswer,
      );
      try {
        await this.dependencies.sendTextFile(
          message.peerUid,
          title,
          normalizedAnswer,
          caption,
        );
        deliveryMode = "combined_attachment";
      } catch {
        if (!this.isCurrent(start)) return;
        try {
          await this.sendPostWithRetry(
            message.peerUid,
            title,
            normalizedAnswer,
          );
          deliveryMode = "standalone_post";
        } catch {
          if (!this.isCurrent(start)) return;
          await this.sendBestEffort(
            message.peerUid,
            `问题 #${start.questionId} 的附件发送失败，下面改为分段发送完整回答。`,
          );
          if (!this.isCurrent(start)) return;
          await this.sendAnswerChunks(message.peerUid, start, chunks);
          deliveryMode = "segmented_text";
        }
      }
      if (!this.isCurrent(start)) return;
    } else {
      await this.sendAnswerChunks(message.peerUid, start, chunks);
    }
    if (
      (metadata.status === "answered" || metadata.status === "partially_answered")
    ) {
      const resolvedQuestion=metadata.resolvedQuestion?.trim()||question,answerOutline=buildAnswerOutline(normalizedAnswer);
      this.conversations.append(message.peerUid, {
        question:resolvedQuestion,
        ...(answerOutline===undefined?{}:{answerOutline}),
        ...(metadata.scope===undefined?{}:{scope:metadata.scope}),
        ...(metadata.answerCardMatch?.cardIdHashes === undefined
          ? {}
          : { answerCardIdHashes: metadata.answerCardMatch.cardIdHashes }),
      });
      await this.persistConversationTurn({message,questionId:start.questionId,question,resolvedQuestion,answerOutline,metadata});
    }
    const feedbackReady = this.feedbackReceipts.remember(message.peerUid, {
      questionId: start.questionId,
      requestId: metadata.requestId ?? "",
      question,
      answer: normalizedAnswer,
      answerStatus: metadata.status ?? "unknown",
      ...(metadata.scope === undefined ? {} : { scope: metadata.scope }),
      referenceCount: metadata.referenceCount,
      answeredAt: new Date(this.now()).toISOString(),
      ...(metadata.answerCardMatch === undefined
        ? {}
        : { answerCardMatch: metadata.answerCardMatch }),
      ...(message.userDisplayName === undefined
        ? {}
        : { userDisplayName: message.userDisplayName }),
    });
    if (feedbackReady && this.dependencies.feedback !== undefined) {
      await this.sendBestEffort(message.peerUid, FEEDBACK_MENU);
    }
    const answerReviewQueued=await this.submitAnswerReview({
      message,
      questionId:start.questionId,
      question,
      answer:normalizedAnswer,
      metadata,
    });
    this.emit({
      type: "answered",
      peerUid: message.peerUid,
      questionId: start.questionId,
      sessionEpoch: start.epoch,
      pendingCount: 0,
      activePeerCount: this.scheduler.activePeerCount,
      scope: metadata.scope,
      status: metadata.status,
      stopReason: metadata.stopReason,
      elapsedMs: Math.max(0, this.now() - receivedAt),
      referenceCount: metadata.referenceCount,
      historicalAttempted: metadata.historicalAttempted,
      historicalUsed: metadata.historicalUsed,
      deliveryMode,
      ...(answerReviewQueued===undefined?{}:{answerReviewQueued}),
      ...historicalNoticeMetadata(metadata),
      ...layeredEvidenceMetadata(metadata),
    });
  }

  private async submitAnswerReview(input:{
    readonly message:LunkrDirectMessage;
    readonly questionId:number;
    readonly question:string;
    readonly answer:string;
    readonly metadata:BridgeAnswerMetadata;
  }):Promise<boolean|undefined>{
    const dependency=this.dependencies.answerReview;
    if(dependency===undefined||!(["professional","general"] as const).includes(input.metadata.scope as "professional"|"general"))return undefined;
    const submittedAt=new Date(this.now()).toISOString();
    try{
      await dependency.submit({
        reviewId:randomUUID(),requestId:input.metadata.requestId??"",
        pseudonymousUserId:pseudonymizeFeedbackUser(input.message.peerUid,dependency.pseudonymizationKey),
        ...(input.message.userDisplayName===undefined?{}:{userDisplayName:input.message.userDisplayName}),
        questionId:input.questionId,question:input.question,answer:input.answer,
        answerStatus:input.metadata.status??"unknown",...(input.metadata.scope===undefined?{}:{scope:input.metadata.scope}),
        references:input.metadata.references??[],answeredAt:submittedAt,submittedAt,source:"lunkr_direct",
        ...(input.metadata.answerCardMatch===undefined?{}:{answerCardMatch:input.metadata.answerCardMatch}),
        ...(input.metadata.answerCardActivation===undefined?{}:{answerCardActivation:input.metadata.answerCardActivation}),
      });
      return true;
    }catch{return false;}
  }

  private async sendFailure(
    peerUid: string,
    questionId: number,
    sessionEpoch: number,
    stopReason: string,
    receivedAt: number,
    metadata?: BridgeAnswerMetadata,
  ): Promise<void> {
    await this.sendWithRetry(
      peerUid,
      `问题 #${questionId} 处理失败：${FAILURE_TEXT}`,
    );
    this.emit({
      type: "failed",
      peerUid,
      questionId,
      sessionEpoch,
      pendingCount: 0,
      activePeerCount: this.scheduler.activePeerCount,
      scope: metadata?.scope,
      status: metadata?.status ?? "temporarily_unavailable",
      stopReason,
      elapsedMs: Math.max(0, this.now() - receivedAt),
      referenceCount: metadata?.referenceCount ?? 0,
      ...(metadata === undefined
        ? {}
        : {
            historicalAttempted: metadata.historicalAttempted,
            historicalUsed: metadata.historicalUsed,
            ...historicalNoticeMetadata(metadata),
          }),
      ...layeredEvidenceMetadata(metadata),
    });
  }

  private async resetPeer(peerUid: string): Promise<void> {
    this.resetPeerState(peerUid, "manual");
    this.forceNewSessionPeers.add(peerUid);
    await this.endPersistentConversation(peerUid,"manual");
    await this.sendWithRetry(
      peerUid,
      "已开始新会话，之前处理中和排队的问题已取消。",
    );
  }

  private async conversationContext(peerUid:string,currentQuestion:string):Promise<string|undefined>{
    const dependency=this.dependencies.conversation;
    if(dependency!==undefined&&!this.conversations.has(peerUid)&&!this.forceNewSessionPeers.has(peerUid)){
      try{
        const user=pseudonymizeFeedbackUser(peerUid,dependency.pseudonymizationKey),stored=await dependency.load(user,this.config.contextMaxTurns);
        this.conversations.replace(peerUid,stored.recentTurns.map((turn)=>({question:turn.resolvedQuestion,...(turn.answerOutline===undefined?{}:{answerOutline:turn.answerOutline}),...(turn.scope===undefined?{}:{scope:turn.scope}),...(turn.answerCardMatch?.cardIdHashes===undefined?{}:{answerCardIdHashes:turn.answerCardMatch.cardIdHashes})})));
      }catch{/* persisted context is an availability enhancement; memory remains the safe fallback */}
    }
    return this.conversations.context(peerUid,currentQuestion);
  }

  private async persistConversationTurn(input:{readonly message:LunkrDirectMessage;readonly questionId:number;readonly question:string;readonly resolvedQuestion:string;readonly answerOutline:string|undefined;readonly metadata:BridgeAnswerMetadata;}):Promise<void>{
    const dependency=this.dependencies.conversation,requestId=input.metadata.requestId;if(dependency===undefined||requestId===undefined||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId))return;
    const answeredAt=new Date(this.now()).toISOString(),forceNewSession=this.forceNewSessionPeers.has(input.message.peerUid);
    try{await dependency.append({turnId:randomUUID(),requestId,pseudonymousUserId:pseudonymizeFeedbackUser(input.message.peerUid,dependency.pseudonymizationKey),questionId:input.questionId,rawQuestion:input.question,resolvedQuestion:input.resolvedQuestion,contextUsed:input.metadata.contextUsed===true,inheritedSubjects:input.metadata.inheritedSubjects??[],...(input.answerOutline===undefined?{}:{answerOutline:input.answerOutline}),answerStatus:input.metadata.status??"unknown",...(input.metadata.scope===undefined?{}:{scope:input.metadata.scope}),...(input.metadata.answerCardMatch===undefined?{}:{answerCardMatch:{...input.metadata.answerCardMatch}}),answeredAt,expiresAt:new Date(this.now()+this.config.sessionIdleMs).toISOString(),source:"lunkr_direct",...(forceNewSession?{forceNewSession:true}:{})});if(forceNewSession)this.forceNewSessionPeers.delete(input.message.peerUid);}catch{/* answer delivery and in-memory continuity must survive an ops outage */}
  }

  private async endPersistentConversation(peerUid:string,reason:"manual"|"idle"):Promise<void>{const dependency=this.dependencies.conversation;if(dependency===undefined)return;try{await dependency.end(pseudonymizeFeedbackUser(peerUid,dependency.pseudonymizationKey),reason,new Date(this.now()).toISOString());}catch{/* the next successful append carries forceNewSession */}}

  private async handleFeedback(message: LunkrDirectMessage): Promise<void> {
    if (message.feedback === undefined) {
      await this.sendWithRetry(
        message.peerUid,
        "反馈格式无效。请发送 /q 1、/q 2、/q 3 或 /q 4；愿意补充时可直接写在后面，例如：/q 3 没提到客户端专用密码。",
      );
      return;
    }
    const feedback = this.dependencies.feedback;
    if (feedback === undefined) {
      await this.sendWithRetry(
        message.peerUid,
        "反馈服务暂时不可用，本次未保存任何内容。",
      );
      return;
    }
    const questionId = message.feedback.questionId ??
      this.feedbackReceipts.latestQuestionId(message.peerUid);
    if (questionId === undefined) {
      await this.sendWithRetry(
        message.peerUid,
        "暂时没有可评价的回答。请先提问，收到回答后再发送 /q 1-4。",
      );
      return;
    }
    const claimResult = this.feedbackReceipts.claim(message.peerUid, questionId);
    if (claimResult.kind === "missing") {
      await this.sendWithRetry(
        message.peerUid,
        `未找到问题 #${questionId} 的可反馈回答，可能已过期或会话已重置。`,
      );
      return;
    }
    if (claimResult.kind === "duplicate") {
      await this.sendWithRetry(
        message.peerUid,
        `问题 #${questionId} 已提交过反馈，请勿重复提交。`,
      );
      return;
    }
    const { claim } = claimResult;
    const submittedAt = new Date(this.now()).toISOString();
    try {
      const pseudonymousUserId = pseudonymizeFeedbackUser(
        message.peerUid,
        feedback.pseudonymizationKey,
      );
      await feedback.submit({
        caseId: claim.caseId,
        requestId: claim.receipt.requestId,
        pseudonymousUserId,
        ...(claim.receipt.userDisplayName === undefined
          ? {}
          : { userDisplayName: claim.receipt.userDisplayName }),
        questionId: claim.receipt.questionId,
        classification: message.feedback.classification,
        comment: message.feedback.comment,
        ...(message.feedback.proposedAnswer === undefined
          ? {}
          : { proposedAnswer: message.feedback.proposedAnswer }),
        question: claim.receipt.question,
        answer: claim.receipt.answer,
        answerStatus: claim.receipt.answerStatus,
        ...(claim.receipt.scope === undefined
          ? {}
          : { scope: claim.receipt.scope }),
        referenceCount: claim.receipt.referenceCount,
        answeredAt: claim.receipt.answeredAt,
        submittedAt,
        source: "lunkr_direct",
        ...(claim.receipt.answerCardMatch === undefined
          ? {}
          : { answerCardMatch: claim.receipt.answerCardMatch }),
        audit: {
          event: "feedback_submitted",
          occurredAt: submittedAt,
        },
      });
    } catch {
      claim.settle(false);
      await this.sendWithRetry(
        message.peerUid,
        "反馈服务暂时不可用，本次未保存，可稍后重试。",
      );
      return;
    }
    claim.settle(true);
    await this.sendBestEffort(
      message.peerUid,
      message.feedback.classification === "review_requested"
        ? `已将问题 #${questionId} 标记为需要人工复查。我们会核对正式知识依据，不需要你补写正确答案。`
        : message.feedback.classification === "correction"
          ? `已保存你为问题 #${questionId} 提交的候选答案。运营人员审核前，它不会直接影响线上回答。`
        : `已记录问题 #${questionId} 的反馈，感谢你的帮助。`,
    );
  }

  private resetPeerState(
    peerUid: string,
    resetReason: "manual" | "idle",
  ): void {
    const reset = this.scheduler.reset(peerUid);
    this.conversations.clear(peerUid);
    this.feedbackReceipts.clearPeer(peerUid);
    this.lastAcceptedQuestionAt.delete(peerUid);
    this.activeProgress.delete(peerUid);
    this.emit({
      type: "cancelled",
      peerUid,
      sessionEpoch: reset.epoch,
      resetReason,
      pendingCount: reset.pendingCancelled,
      activePeerCount: this.scheduler.activePeerCount,
    });
  }

  private expireIdleSession(peerUid: string, now: number): void {
    const lastAcceptedAt = this.lastAcceptedQuestionAt.get(peerUid);
    if (
      lastAcceptedAt === undefined ||
      now - lastAcceptedAt < this.config.sessionIdleMs
    ) {
      return;
    }
    this.resetPeerState(peerUid, "idle");
  }

  private isCurrent(start: QuestionStart): boolean {
    return (
      !start.signal.aborted &&
      this.scheduler.isCurrent(start.peerUid, start.epoch)
    );
  }

  private beginProgress(start: QuestionStart): void {
    const timestamp = this.now();
    this.activeProgress.set(start.peerUid, {
      questionId: start.questionId,
      epoch: start.epoch,
      startedAt: timestamp,
      lastUpdatedAt: timestamp,
      stage: "understanding",
    });
  }

  private updateProgress(
    start: QuestionStart,
    progress: BridgeAnswerProgress,
  ): void {
    if (!this.isCurrent(start) || !isProgressStage(progress.stage)) return;
    const current = this.activeProgress.get(start.peerUid);
    if (
      current === undefined ||
      current.questionId !== start.questionId ||
      current.epoch !== start.epoch
    ) {
      return;
    }
    this.activeProgress.set(start.peerUid, {
      questionId: current.questionId,
      epoch: current.epoch,
      startedAt: current.startedAt,
      lastUpdatedAt: this.now(),
      stage: progress.stage,
      ...safeOptionalCount("requirementCount", progress.requirementCount),
      ...safeOptionalCount(
        "retrievalCompletedCount",
        progress.retrievalCompletedCount,
      ),
      ...safeOptionalCount("evidenceReadCount", progress.evidenceReadCount),
      ...safeOptionalCount(
        "coveredRequirementCount",
        progress.coveredRequirementCount,
      ),
      ...safeOptionalCount(
        "coverageRequirementCount",
        progress.coverageRequirementCount,
      ),
    });
  }

  private clearProgress(
    peerUid: string,
    epoch: number,
    questionId: number,
  ): void {
    const current = this.activeProgress.get(peerUid);
    if (current?.epoch === epoch && current.questionId === questionId) {
      this.activeProgress.delete(peerUid);
    }
  }

  private emit(event: BridgeQuestionEvent): void {
    try {
      this.dependencies.onEvent?.(event);
    } catch {
      // Runtime observation must not affect message delivery.
    }
  }

  private async sendWithRetry(peerUid: string, text: string): Promise<void> {
    await this.retrySend(() => this.dependencies.sendText(peerUid, text));
  }

  private async sendBestEffort(peerUid: string, text: string): Promise<void> {
    try {
      await this.sendWithRetry(peerUid, text);
    } catch {
      // The optional notice must never prevent delivery of the complete answer.
    }
  }

  private async sendPostWithRetry(
    peerUid: string,
    title: string,
    content: string,
  ): Promise<void> {
    await this.retrySend(() =>
      this.dependencies.sendPost(peerUid, title, content));
  }

  private async sendAnswerChunks(
    peerUid: string,
    start: QuestionStart,
    chunks: readonly string[],
  ): Promise<void> {
    for (const chunk of chunks) {
      if (!this.isCurrent(start)) return;
      await this.sendWithRetry(peerUid, chunk);
      if (!this.isCurrent(start)) return;
    }
  }

  private async retrySend(operation: () => Promise<void>): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 200));
        }
      }
    }
    throw lastError;
  }
}

interface ActiveQuestionProgress extends BridgeAnswerProgress {
  readonly questionId: number;
  readonly epoch: number;
  readonly startedAt: number;
  readonly lastUpdatedAt: number;
}

const PROGRESS_STAGE_LABELS: Readonly<Record<BridgeAnswerProgressStage, string>> = {
  understanding: "理解问题",
  planning: "拆解问题",
  retrieving: "检索资料",
  reviewing_evidence: "核对证据",
  composing: "组织回答",
  verifying: "核验答案",
  preparing_delivery: "准备发送",
};

function formatProcessingStatus(
  progress: ActiveQuestionProgress,
  now: number,
): string {
  const lines = [
    `问题 #${progress.questionId}：处理中 · 已用时 ${formatElapsed(now - progress.startedAt)}`,
    `当前阶段：${PROGRESS_STAGE_LABELS[progress.stage]}`,
  ];
  const facts: string[] = [];
  if (progress.requirementCount !== undefined) {
    facts.push(`需求拆解：${progress.requirementCount} 项`);
  }
  if (progress.retrievalCompletedCount !== undefined) {
    facts.push(`资料检索：已完成 ${progress.retrievalCompletedCount} 项`);
  }
  if (progress.evidenceReadCount !== undefined) {
    facts.push(`证据读取：${progress.evidenceReadCount} 份`);
  }
  if (
    progress.coveredRequirementCount !== undefined &&
    progress.coverageRequirementCount !== undefined
  ) {
    facts.push(
      `覆盖核验：${progress.coveredRequirementCount}/${progress.coverageRequirementCount} 项完成`,
    );
  }
  if (facts.length > 0) lines.push("", ...facts);
  lines.push(`最后更新：${formatShanghaiClock(progress.lastUpdatedAt)}`);
  return lines.join("\n");
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}秒`;
  if (remainingSeconds === 0) return `${minutes}分`;
  return `${minutes}分${remainingSeconds}秒`;
}

function formatShanghaiClock(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
}

function isProgressStage(value: unknown): value is BridgeAnswerProgressStage {
  return typeof value === "string" &&
    Object.hasOwn(PROGRESS_STAGE_LABELS, value);
}

function safeOptionalCount<Key extends keyof BridgeAnswerProgress>(
  key: Key,
  value: BridgeAnswerProgress[Key],
): Partial<Pick<BridgeAnswerProgress, Key>> {
  return Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 1_000_000_000
    ? { [key]: value } as Partial<Pick<BridgeAnswerProgress, Key>>
    : {};
}

function historicalNoticeMetadata(
  metadata: BridgeAnswerMetadata | undefined,
): Pick<
  BridgeQuestionEvent,
  "historicalNoticeShown" | "historicalRejectedReason"
> {
  if (
    metadata?.historicalNoticeShown !== true ||
    metadata.historicalRejectedReason === undefined
  ) {
    return {};
  }
  return {
    historicalNoticeShown: true,
    historicalRejectedReason: metadata.historicalRejectedReason,
  };
}

function layeredEvidenceMetadata(
  metadata: BridgeAnswerMetadata | undefined,
): Pick<
  BridgeQuestionEvent,
  | "draftCoverage"
  | "verifiedCoverage"
  | "retainedDirectSegmentCount"
  | "retainedSynthesizedSegmentCount"
  | "removedSegmentCount"
  | "historicalGateReason"
> {
  if (metadata === undefined) return {};
  return {
    ...(metadata.draftCoverage === undefined
      ? {}
      : { draftCoverage: metadata.draftCoverage }),
    ...(metadata.verifiedCoverage === undefined
      ? {}
      : { verifiedCoverage: metadata.verifiedCoverage }),
    ...(metadata.retainedDirectSegmentCount === undefined
      ? {}
      : {
          retainedDirectSegmentCount:
            metadata.retainedDirectSegmentCount,
        }),
    ...(metadata.retainedSynthesizedSegmentCount === undefined
      ? {}
      : {
          retainedSynthesizedSegmentCount:
            metadata.retainedSynthesizedSegmentCount,
        }),
    ...(metadata.removedSegmentCount === undefined
      ? {}
      : { removedSegmentCount: metadata.removedSegmentCount }),
    ...(metadata.historicalGateReason === undefined
      ? {}
      : { historicalGateReason: metadata.historicalGateReason }),
  };
}
