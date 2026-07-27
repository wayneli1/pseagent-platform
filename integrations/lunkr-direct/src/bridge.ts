import type { LunkrDirectConfig } from "./config.js";
import type { LunkrDirectMessage } from "./contracts.js";
import { ConversationStore } from "./conversation-store.js";
import { MessageDedupe } from "./dedupe.js";
import { PeerQueue } from "./peer-queue.js";

const HELP_TEXT = [
  "我是 PSEAgent 论客私聊机器人。",
  "直接发送文字即可提问，不需要 /bot。",
  "发送 /new 可清空当前私聊的连续对话上下文。",
  "当前暂不支持群聊、图片、文件或语音。",
].join("\n");

export interface BridgeAnswerResult {
  readonly answer: string;
  readonly [key: string]: unknown;
}

export interface LunkrBridgeDependencies<Result extends BridgeAnswerResult> {
  readonly answer: (
    question: string,
    conversationContext?: string,
  ) => Promise<Result>;
  readonly formatAnswer: (result: Result) => string;
  readonly sendText: (peerUid: string, text: string) => Promise<void>;
}

export class LunkrPseBridge<Result extends BridgeAnswerResult> {
  private readonly conversations: ConversationStore;
  private readonly dedupe: MessageDedupe;
  private readonly queue = new PeerQueue();

  constructor(
    private readonly config: LunkrDirectConfig,
    private readonly dependencies: LunkrBridgeDependencies<Result>,
  ) {
    this.conversations = new ConversationStore(
      config.contextMaxTurns,
      config.contextMaxChars,
    );
    this.dedupe = new MessageDedupe(
      config.messageDedupeTtlMs,
      config.messageDedupeMax,
    );
  }

  handle(message: LunkrDirectMessage): Promise<void> {
    if (!this.dedupe.accept(message.id)) return Promise.resolve();
    return this.queue.enqueue(message.peerUid, () => this.process(message));
  }

  private async process(message: LunkrDirectMessage): Promise<void> {
    if (message.hasAttachments) {
      await this.sendWithRetry(message.peerUid, "当前仅支持文字私聊。");
      return;
    }
    const question = message.text.trim();
    if (question === "/new") {
      this.conversations.clear(message.peerUid);
      await this.sendWithRetry(message.peerUid, "当前私聊的上下文已清空。");
      return;
    }
    if (question === "/help") {
      await this.sendWithRetry(message.peerUid, HELP_TEXT);
      return;
    }
    if (question === "") return;
    const context = this.conversations.context(message.peerUid);
    let result: Result;
    try {
      result = await this.dependencies.answer(question, context);
    } catch {
      await this.sendWithRetry(
        message.peerUid,
        "问答服务暂时不可用，请稍后重试。",
      );
      return;
    }
    const answer = this.dependencies.formatAnswer(result).trim();
    if (answer === "") {
      await this.sendWithRetry(
        message.peerUid,
        "问答服务暂时不可用，请稍后重试。",
      );
      return;
    }
    await this.sendWithRetry(message.peerUid, answer);
    this.conversations.append(message.peerUid, { question, answer });
  }

  private async sendWithRetry(peerUid: string, text: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.dependencies.sendText(peerUid, text);
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
