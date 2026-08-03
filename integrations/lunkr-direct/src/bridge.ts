import { normalizeAnswerText, presentAnswer } from "./answer-presenter.js";
import type { LunkrDirectConfig } from "./config.js";
import { ConversationStore } from "./conversation-store.js";
import type { LunkrDirectMessage } from "./contracts.js";
import { MessageDedupe } from "./dedupe.js";
import {
  PeerScheduler,
  type AdmissionNotice,
  type QuestionStart,
} from "./peer-scheduler.js";

const FAILURE_TEXT = "知识问答服务暂时不可用，请稍后重试。";

const HELP_TEXT = [
  "我是 PSEAgent 论客私聊机器人。",
  "直接发送文字即可提问，不需要 /bot。",
  "发送 /new 可取消当前题和排队题，并清空连续对话上下文。",
  "当前暂不支持群聊、图片、文件或语音。",
].join("\n");

export type BridgeCoverage = "complete" | "partial" | "none";

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
}

export interface LunkrBridgeDependencies<Result> {
  readonly answer: (
    question: string,
    conversationContext?: string,
    signal?: AbortSignal,
  ) => Promise<Result>;
  readonly formatAnswer: (result: Result) => string;
  readonly formatContextAnswer?: ((result: Result) => string) | undefined;
  readonly describeResult: (result: Result) => BridgeAnswerMetadata;
  readonly sendText: (peerUid: string, text: string) => Promise<void>;
  readonly sendPost: (
    peerUid: string,
    title: string,
    content: string,
  ) => Promise<void>;
  readonly onEvent?: ((event: BridgeQuestionEvent) => void) | undefined;
}

export class LunkrPseBridge<Result> {
  private readonly conversations: ConversationStore;
  private readonly dedupe: MessageDedupe;
  private readonly scheduler: PeerScheduler;
  private readonly lastAcceptedQuestionAt = new Map<string, number>();

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
  }

  handle(message: LunkrDirectMessage): Promise<void> {
    if (!this.dedupe.accept(message.id)) return Promise.resolve();
    if (message.command === "new") return this.resetPeer(message.peerUid);
    if (message.command === "help") {
      return this.sendWithRetry(message.peerUid, HELP_TEXT);
    }
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
    return receipt.completion;
  }

  private async sendAdmissionReply(
    peerUid: string,
    admission: AdmissionNotice,
  ): Promise<void> {
    let text: string;
    switch (admission.kind) {
      case "started":
        text = `已收到问题 #${admission.questionId}，正在处理。`;
        break;
      case "peer_queued":
        text =
          `已收到问题 #${admission.questionId}，前面还有 ${admission.ahead} 个问题，已加入队列。`;
        break;
      case "global_queued":
        text =
          `已收到问题 #${admission.questionId}，当前服务繁忙，已进入等待队列。`;
        break;
      case "peer_full":
        text = "当前已有较多问题等待处理，请稍后再发送。";
        break;
    }
    await this.sendWithRetry(peerUid, text);
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
    const context = this.conversations.context(message.peerUid);
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
        result = await this.dependencies.answer(question, context, signal);
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
    const chunks = presentAnswer(
      start.questionId,
      normalizedAnswer,
      this.config.messageMaxChars,
    );
    if (chunks.length > 1) {
      if (!this.isCurrent(start)) return;
      try {
        await this.sendPostWithRetry(
          message.peerUid,
          `PSEAgent 问题 #${start.questionId} 的完整回答.txt`,
          normalizedAnswer,
        );
      } catch {
        if (!this.isCurrent(start)) return;
        await this.sendAnswerChunks(message.peerUid, start, chunks);
      }
      if (!this.isCurrent(start)) return;
    } else {
      await this.sendAnswerChunks(message.peerUid, start, chunks);
    }
    const contextAnswer = (
      this.dependencies.formatContextAnswer?.(result) ?? answer
    ).trim();
    if (contextAnswer !== "") {
      this.conversations.append(message.peerUid, {
        question,
        answer: contextAnswer,
      });
    }
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
      ...historicalNoticeMetadata(metadata),
      ...layeredEvidenceMetadata(metadata),
    });
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
    await this.sendWithRetry(
      peerUid,
      "已开始新会话，之前处理中和排队的问题已取消。",
    );
  }

  private resetPeerState(
    peerUid: string,
    resetReason: "manual" | "idle",
  ): void {
    const reset = this.scheduler.reset(peerUid);
    this.conversations.clear(peerUid);
    this.lastAcceptedQuestionAt.delete(peerUid);
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
