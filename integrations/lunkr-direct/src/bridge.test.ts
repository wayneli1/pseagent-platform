import { describe, expect, it, vi } from "vitest";
import type { LunkrDirectConfig } from "./config.js";
import type { DirectCommand, LunkrDirectMessage } from "./contracts.js";
import {
  LunkrPseBridge,
  type BridgeAnswerProgress,
  type BridgeAnswerReviewDependencies,
  type BridgeConversationDependencies,
  type BridgeFeedbackDependencies,
  type BridgeQuestionEvent,
} from "./bridge.js";
import type { BridgeAnswerReviewSubmission, BridgeReviewReference } from "./answer-review-submission.js";
import type { BridgeFeedbackSubmission } from "./feedback-receipt-store.js";

const config: LunkrDirectConfig = {
  baseUrl: "https://lunkr.example.test",
  apiPath: "/lunkr/s/json",
  sessionPath: "unused",
  passwordPath: "unused",
  connectTimeoutMs: 1_000,
  reconnectMaxMs: 1_000,
  messageDedupeTtlMs: 60_000,
  messageDedupeMax: 100,
  contextMaxTurns: 6,
  contextMaxChars: 12_000,
  messageMaxChars: 1_000,
  questionBudgetMs: 300_000,
  maxActivePeers: 4,
  maxPendingPerPeer: 5,
  sessionIdleMs: 10 * 60_000,
  feedbackReceiptTtlMs: 30 * 60_000,
  feedbackReceiptMax: 2_000,
};

type TestResult = {
  readonly requestId?: string;
  readonly answer: string;
  readonly status: "answered" | "temporarily_unavailable" | "not_covered";
  readonly scope?: "normal" | "professional" | "general";
  readonly retryable?: boolean;
  readonly stopReason?: string;
  readonly historicalAttempted?: boolean;
  readonly historicalUsed?: boolean;
  readonly historicalNoticeShown?: boolean;
  readonly historicalRejectedReason?:
    | "topic_mismatch"
    | "low_confidence"
    | "no_reliable_source";
  readonly referenceCount?: number;
  readonly draftCoverage?: readonly ("complete" | "partial" | "none")[];
  readonly verifiedCoverage?: readonly ("complete" | "partial" | "none")[];
  readonly retainedDirectSegmentCount?: number;
  readonly retainedSynthesizedSegmentCount?: number;
  readonly removedSegmentCount?: number;
  readonly historicalGateReason?:
    | "eligible"
    | "question_not_explicit_coremail"
    | "formal_verification_incomplete"
    | "formal_support_present"
    | "structural_fallback";
  readonly references?: readonly BridgeReviewReference[];
  readonly resolvedQuestion?: string;
  readonly contextUsed?: boolean;
  readonly inheritedSubjects?: readonly string[];
};

type Answer = (
  question: string,
  conversationContext?: string,
  signal?: AbortSignal,
  progressObserver?: (progress: BridgeAnswerProgress) => void,
) => Promise<TestResult>;

describe("LunkrPseBridge", () => {
  it("sends an immediate numbered acknowledgment and stores structured bounded turn context", async () => {
    const answer = vi.fn<Answer>(async (question, context, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return answered(`${question}:${context ?? "empty"}`);
    });
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("m1", "#a#U", "第一问"));
    await bridge.handle(message("m2", "#a#U", "第二问"));

    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[0]?.[1]).toBeUndefined();
    expect(answer.mock.calls[1]?.[1]).toContain("第一问");
    expect(answer.mock.calls[1]?.[1]).toContain('"version":3');
    expect(answer.mock.calls[1]?.[1]).toContain('"answerOutline":"第一问:empty"');
    expect(answer.mock.calls[1]?.[1]).not.toContain("已收到问题");
    expect(sentTexts(sendText)).toEqual([
      startedNotice(1),
      "问题 #1 的回答：\n\n第一问:empty",
      startedNotice(2),
      expect.stringContaining("问题 #2 的回答：\n\n第二问:"),
    ]);
  });

  it("shows a hidden-history notice without storing a not-covered answer", async () => {
    const formalAnswer = "当前知识库暂未覆盖该问题，暂时无法给出可靠答案。";
    const historicalNotice =
      "补充说明：已检索 Coremail MCP 历史资料，但检索内容与当前问题不匹配，因此未展示。";
    const answer = vi.fn<Answer>(async () => ({
      answer: formalAnswer,
      status: "not_covered",
      retryable: false,
      stopReason: "final",
    }));
    const sendText = vi.fn(async () => undefined);
    const sendPost = vi.fn(async () => undefined);
    const bridge = new LunkrPseBridge(config, {
      answer,
      formatAnswer: (result) => `${result.answer}\n\n${historicalNotice}`,
      formatContextAnswer: (result) => result.answer,
      describeResult: (result) => ({
        status: result.status,
        retryable: result.retryable ?? false,
        stopReason: result.stopReason,
        referenceCount: 0,
        historicalAttempted: false,
        historicalUsed: false,
      }),
      sendText,
      sendTextFile: async () => undefined,
      sendPost,
    });

    await bridge.handle(message("m1", "#a#U", "未知能力"));
    await bridge.handle(message("m2", "#a#U", "继续说明"));

    expect(sentTexts(sendText)[1]).toContain(historicalNotice);
    expect(answer.mock.calls[1]?.[1]).toBeUndefined();
  });

  it("answers an immediate normalized repeat without prior context", async () => {
    const answer = vi.fn<Answer>(async (question, context) =>
      answered(`${question}:${context ?? "empty"}`));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("m1", "#a#U", "Coremail 优势有哪些？"));
    await bridge.handle(message("m2", "#a#U", " coremail优势有哪些 "));
    await bridge.handle(message("m3", "#a#U", "继续说明"));

    expect(answer.mock.calls[0]?.[1]).toBeUndefined();
    expect(answer.mock.calls[1]?.[1]).toBeUndefined();
    expect(answer.mock.calls[2]?.[1]).toContain("coremail优势有哪些");
  });

  it("deduplicates before allocating an id or sending an acknowledgment", async () => {
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });
    const duplicate = message("same", "#a#U", "问题");

    await Promise.all([bridge.handle(duplicate), bridge.handle(duplicate)]);

    expect(answer).toHaveBeenCalledOnce();
    expect(sentTexts(sendText)).toEqual([
      startedNotice(1),
      "问题 #1 的回答：\n\n回答",
    ]);
  });

  it("queues one peer in FIFO order and announces when queued work starts", async () => {
    const first = deferred<TestResult>();
    const answer = vi.fn<Answer>(async (question) =>
      question === "A1" ? first.promise : answered(question));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    const a1 = bridge.handle(message("a1", "#a#U", "A1"));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    const a2 = bridge.handle(message("a2", "#a#U", "A2"));
    await vi.waitFor(() => expect(sentTexts(sendText)).toContain(
      withProcessingGuide("已收到问题 #2，前面还有 1 个问题，已加入队列。"),
    ));
    expect(answer).toHaveBeenCalledOnce();

    first.resolve(answered("A1"));
    await Promise.all([a1, a2]);

    const texts = sentTexts(sendText);
    expect(texts).toContain("问题 #2 已开始处理。");
    expect(texts).toContain("问题 #2 的回答：\n\nA2");
    expect(texts.indexOf("问题 #1 的回答：\n\nA1"))
      .toBeLessThan(texts.indexOf("问题 #2 已开始处理。"));
  });

  it("runs four peers and gives a fifth peer a global busy acknowledgment", async () => {
    const gates = new Map(
      ["A", "B", "C", "D"].map((question) =>
        [question, deferred<TestResult>()] as const),
    );
    const answer = vi.fn<Answer>(async (question) =>
      gates.get(question)?.promise ?? answered(question));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    const running = ["A", "B", "C", "D"].map((question, index) =>
      bridge.handle(message(`m${index}`, `#${question}#U`, question)));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(4));
    const fifth = bridge.handle(message("m5", "#E#U", "E"));
    await vi.waitFor(() => expect(sentTexts(sendText)).toContain(
      withProcessingGuide("已收到问题 #1，当前服务繁忙，已进入等待队列。"),
    ));
    expect(answer).toHaveBeenCalledTimes(4);

    gates.get("A")!.resolve(answered("A"));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(5));
    expect(sentTexts(sendText)).toContain("问题 #1 已开始处理。");
    for (const question of ["B", "C", "D"]) {
      gates.get(question)!.resolve(answered(question));
    }
    await Promise.all([...running, fifth]);
  });

  it("rejects a sixth pending question without consuming an id", async () => {
    const first = deferred<TestResult>();
    const answer = vi.fn<Answer>(async (question) =>
      question === "Q1" ? first.promise : answered(question));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });
    const handles = [bridge.handle(message("q1", "#a#U", "Q1"))];
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    for (let index = 2; index <= 7; index += 1) {
      handles.push(bridge.handle(message(`q${index}`, "#a#U", `Q${index}`)));
    }

    await vi.waitFor(() => expect(sentTexts(sendText)).toContain(
      "当前已有较多问题等待处理，请稍后再发送。",
    ));
    expect(answer).toHaveBeenCalledTimes(1);

    first.resolve(answered("Q1"));
    await Promise.all(handles);
    expect(answer).toHaveBeenCalledTimes(6);
    expect(answer.mock.calls.some((call) => call[0] === "Q7")).toBe(false);
  });

  it("handles commands and attachments without consuming a question id", async () => {
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("help", "#a#U", "/help", "help"));
    await bridge.handle(message("new", "#a#U", "/new", "new"));
    await bridge.handle({ ...message("file", "#a#U", ""), hasAttachments: true });
    await bridge.handle(message("question", "#a#U", "问题"));

    expect(answer).toHaveBeenCalledOnce();
    expect(sentTexts(sendText)).toContain("当前仅支持文字私聊。");
    expect(sentTexts(sendText)).toContain(
      "已开始新会话，之前处理中和排队的问题已取消。",
    );
    expect(sentTexts(sendText)).toContain(
      startedNotice(1),
    );
  });

  it("reports reliable processing and queue status without allocating a question id", async () => {
    const first = deferred<TestResult>();
    let now = Date.UTC(2026, 7, 6, 5, 50, 52);
    const answer = vi.fn<Answer>(async (question, _context, _signal, progress) => {
      if (question !== "第一问") return answered("第二问回答");
      progress?.({
        stage: "reviewing_evidence",
        requirementCount: 4,
        retrievalCompletedCount: 4,
        evidenceReadCount: 7,
        coveredRequirementCount: 3,
        coverageRequirementCount: 4,
      });
      return first.promise;
    });
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText, now: () => now });

    await bridge.handle(message("empty-status", "#a#U", "/status", "status"));
    expect(sentTexts(sendText).at(-1)).toBe(
      "当前没有正在处理或排队的问题。直接发送文字即可提问。",
    );

    const active = bridge.handle(message("q1", "#a#U", "第一问"));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    const queued = bridge.handle(message("q2", "#a#U", "第二问"));
    await vi.waitFor(() => expect(sentTexts(sendText)).toContain(
      withProcessingGuide("已收到问题 #2，前面还有 1 个问题，已加入队列。"),
    ));
    now += 86_000;
    await bridge.handle(message("status", "#a#U", "/status", "status"));
    expect(sentTexts(sendText).at(-1)).toBe([
      "当前问题状态：",
      "问题 #1：处理中 · 已用时 1分26秒",
      "当前阶段：核对证据",
      "",
      "需求拆解：4 项",
      "资料检索：已完成 4 项",
      "证据读取：7 份",
      "覆盖核验：3/4 项完成",
      "最后更新：13:50:52",
      "问题 #2：排队中，前面还有 1 个问题",
    ].join("\n"));

    first.resolve(answered("第一问回答"));
    await Promise.all([active, queued]);
    await bridge.handle(message("done-status", "#a#U", "/status", "status"));
    expect(sentTexts(sendText).at(-1)).toBe(
      "当前没有正在处理或排队的问题。直接发送文字即可提问。",
    );
  });

  it("drops cancelled progress and ignores stale callbacks after a new session", async () => {
    const gate = deferred<TestResult>();
    let report: ((progress: BridgeAnswerProgress) => void) | undefined;
    const answer = vi.fn<Answer>(async (_question, _context, _signal, progress) => {
      report = progress;
      return gate.promise;
    });
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    const pending = bridge.handle(message("progress-old", "#a#U", "旧问题"));
    await vi.waitFor(() => expect(report).toBeTypeOf("function"));
    await bridge.handle(message("progress-new", "#a#U", "/new", "new"));
    report?.({ stage: "verifying", requirementCount: 99 });
    await bridge.handle(message("progress-status", "#a#U", "/status", "status"));

    expect(sentTexts(sendText).at(-1)).toBe(
      "当前没有正在处理或排队的问题。直接发送文字即可提问。",
    );
    await pending;
  });

  it("persists original question and answer only after explicit pseudonymous feedback", async () => {
    const submissions: BridgeFeedbackSubmission[] = [];
    const answer = vi.fn<Answer>(async () => answered("完整回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer,
      sendText,
      feedback: feedbackDependencies(async (submission) => {
        submissions.push(submission);
      }),
    });

    await bridge.handle({
      ...message("q1", "#private-user#U", "原始问题"),
      userDisplayName: "Wayne 黎政良",
    });
    expect(submissions).toEqual([]);
    await bridge.handle(feedbackMessage(
      "f1",
      "#private-user#U",
      1,
      "incorrect",
      "遗漏了实施边界",
    ));
    await bridge.handle(message("q2", "#private-user#U", "第二问"));

    expect(answer).toHaveBeenCalledTimes(2);
    expect(sentTexts(sendText)).toContain(
      startedNotice(2),
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      requestId: "019fcd9f-cfb9-7c62-93a9-39b84c7e00f9",
      questionId: 1,
      classification: "incorrect",
      comment: "遗漏了实施边界",
      question: "原始问题",
      answer: "完整回答",
      source: "lunkr_direct",
      audit: { event: "feedback_submitted" },
      userDisplayName: "Wayne 黎政良",
    });
    expect(submissions[0]?.pseudonymousUserId).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(submissions[0])).not.toContain("private-user");
  });

  it("submits every delivered knowledge answer for independent review without user feedback",async()=>{
    const submissions:BridgeAnswerReviewSubmission[]=[];const events:BridgeQuestionEvent[]=[];const sendText=vi.fn(async()=>undefined);
    const reference={index:1,project:"coremail-professional" as const,title:"正式页面",path:"wiki/concepts/正式页面.md",revision:"a".repeat(40),contentHash:"b".repeat(64)};
    const bridge=createBridge({sendText,onEvent:(event)=>events.push(event),answer:async()=>({...answered("完整回答"),scope:"professional",references:[reference]}),answerReview:{pseudonymizationKey:"r".repeat(32),submit:async(submission)=>{submissions.push(submission);}}});
    await bridge.handle({...message("auto-review","#private-user#U","原始问题"),userDisplayName:"Wayne 黎政良"});
    expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({question:"原始问题",answer:"完整回答",scope:"professional",userDisplayName:"Wayne 黎政良",references:[reference],source:"lunkr_direct"});expect(submissions[0]?.pseudonymousUserId).toMatch(/^[a-f0-9]{64}$/u);expect(events.at(-1)?.answerReviewQueued).toBe(true);
  });

  it("keeps a delivered answer available when automatic review intake fails",async()=>{const events:BridgeQuestionEvent[]=[];const sendText=vi.fn(async()=>undefined);const bridge=createBridge({sendText,onEvent:(event)=>events.push(event),answer:async()=>({...answered("仍然交付"),scope:"general"}),answerReview:{pseudonymizationKey:"r".repeat(32),submit:async()=>{throw new Error("offline");}}});await bridge.handle(message("review-failure","#a#U","问题"));expect(sentTexts(sendText).some((text)=>text.includes("仍然交付"))).toBe(true);expect(events.at(-1)?.answerReviewQueued).toBe(false);});

  it("accepts quick feedback and lets a user request review without writing an answer", async () => {
    const submissions: BridgeFeedbackSubmission[] = [];
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer: async (question) => answered(`${question}的回答`),
      sendText,
      feedback: feedbackDependencies(async (submission) => {
        submissions.push(submission);
      }),
    });

    await bridge.handle(message("q1", "#a#U", "第一问"));
    expect(sentTexts(sendText).at(-1)).toContain("/q 1  有帮助");
    await bridge.handle(quickFeedbackMessage(
      "f1",
      "#a#U",
      "incorrect",
      "版本判断错误",
    ));
    await bridge.handle(message("q2", "#a#U", "第二问"));
    await bridge.handle(quickFeedbackMessage(
      "f2",
      "#a#U",
      "review_requested",
      "",
    ));

    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toMatchObject({
      questionId: 1,
      classification: "incorrect",
      comment: "版本判断错误",
    });
    expect(submissions[1]).toMatchObject({
      questionId: 2,
      classification: "review_requested",
      comment: "",
    });
    expect(sentTexts(sendText).at(-1)).toContain(
      "不需要你补写正确答案",
    );
  });

  it("handles malformed or unavailable feedback without allocating a question id", async () => {
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle({
      ...message("bad-feedback", "#a#U", "/feedback #1 missing", "feedback"),
    });
    await bridge.handle(feedbackMessage("no-service", "#a#U", 1, "useful", ""));
    await bridge.handle(message("q1", "#a#U", "问题"));

    expect(answer).toHaveBeenCalledOnce();
    expect(sentTexts(sendText)).toContain(
      startedNotice(1),
    );
    expect(sentTexts(sendText)).toContain(
      "反馈服务暂时不可用，本次未保存任何内容。",
    );
    expect(sentTexts(sendText).some((text) => text.startsWith("反馈格式无效")))
      .toBe(true);
  });

  it("expires feedback receipts and clears them on a new session", async () => {
    let now = 1_000;
    const submit = vi.fn(async (_submission: BridgeFeedbackSubmission) => undefined);
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer: async () => answered("回答"),
      sendText,
      config: { feedbackReceiptTtlMs: 100 },
      now: () => now,
      feedback: feedbackDependencies(submit),
    });

    await bridge.handle(message("q1", "#a#U", "第一问"));
    now = 1_100;
    await bridge.handle(feedbackMessage("expired", "#a#U", 1, "useful", ""));
    await bridge.handle(message("q2", "#a#U", "第二问"));
    await bridge.handle(message("new", "#a#U", "/new", "new"));
    await bridge.handle(feedbackMessage("reset", "#a#U", 2, "useful", ""));

    expect(submit).not.toHaveBeenCalled();
    expect(sentTexts(sendText).filter((text) => text.startsWith("未找到问题")))
      .toHaveLength(2);
  });

  it("submits concurrent duplicate feedback once and releases a failed claim for retry", async () => {
    const firstSubmission = deferred<void>();
    let attempt = 0;
    const submit = vi.fn(async (_submission: BridgeFeedbackSubmission) => {
      attempt += 1;
      if (attempt === 1) return firstSubmission.promise;
      if (attempt === 2) throw new Error("ops unavailable");
    });
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer: async () => answered("回答"),
      sendText,
      feedback: feedbackDependencies(submit),
    });
    await bridge.handle(message("q1", "#a#U", "第一问"));

    const first = bridge.handle(feedbackMessage("f1", "#a#U", 1, "useful", ""));
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await bridge.handle(feedbackMessage("f2", "#a#U", 1, "useful", ""));
    expect(sentTexts(sendText)).toContain("问题 #1 已提交过反馈，请勿重复提交。");
    firstSubmission.resolve(undefined);
    await first;

    await bridge.handle(message("q2", "#a#U", "第二问"));
    await bridge.handle(feedbackMessage("f3", "#a#U", 2, "incorrect", "有误"));
    expect(sentTexts(sendText)).toContain(
      "反馈服务暂时不可用，本次未保存，可稍后重试。",
    );
    await bridge.handle(feedbackMessage("f4", "#a#U", 2, "incorrect", "有误"));

    expect(submit).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls[1]?.[0].caseId).toBe(submit.mock.calls[2]?.[0].caseId);
    expect(sentTexts(sendText)).toContain("已记录问题 #2 的反馈，感谢你的帮助。");
  });

  it("silently starts at #1 when accepted-question inactivity reaches ten minutes", async () => {
    let now = 1_000;
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer,
      sendText,
      config: { sessionIdleMs: 10 * 60_000 },
      now: () => now,
    });

    await bridge.handle(message("m1", "#a#U", "第一问"));
    now = 600_999;
    await bridge.handle(message("m2", "#a#U", "第二问"));
    now = 1_200_999;
    await bridge.handle(message("m3", "#a#U", "第三问"));

    expect(sentTexts(sendText)).toContain(
      startedNotice(2),
    );
    expect(sentTexts(sendText)).toContain(
      startedNotice(1),
    );
    expect(sentTexts(sendText)).not.toContain(
      "已开始新会话，之前处理中和排队的问题已取消。",
    );
    expect(answer.mock.calls[2]?.[1]).toBeUndefined();
  });

  it("does not extend idle activity for help attachments blank or duplicate events", async () => {
    let now = 0;
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer,
      sendText,
      config: { sessionIdleMs: 1_000 },
      now: () => now,
    });

    await bridge.handle(message("q1", "#a#U", "第一问"));
    now = 400;
    await bridge.handle(message("help", "#a#U", "/help", "help"));
    now = 600;
    await bridge.handle({ ...message("file", "#a#U", ""), hasAttachments: true });
    now = 800;
    await bridge.handle(message("blank", "#a#U", "   "));
    now = 900;
    await bridge.handle(message("q1", "#a#U", "重复事件"));
    now = 1_000;
    await bridge.handle(message("q2", "#a#U", "第二问"));

    const receipts = sentTexts(sendText).filter((text) =>
      text.includes("已收到，正在检索并核对相关资料"));
    expect(receipts).toEqual([
      startedNotice(1),
      startedNotice(1),
    ]);
    expect(answer.mock.calls[1]?.[1]).toBeUndefined();
  });

  it("expires each peer independently", async () => {
    let now = 0;
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer,
      sendText,
      config: { sessionIdleMs: 1_000 },
      now: () => now,
    });

    await bridge.handle(message("a1", "#a#U", "A1"));
    now = 600;
    await bridge.handle(message("b1", "#b#U", "B1"));
    now = 1_000;
    await bridge.handle(message("a2", "#a#U", "A2"));
    now = 1_100;
    await bridge.handle(message("b2", "#b#U", "B2"));

    const receipts = sentTexts(sendText).filter((text) =>
      text.includes("已收到，正在检索并核对相关资料"));
    expect(receipts).toEqual([
      startedNotice(1),
      startedNotice(1),
      startedNotice(1),
      startedNotice(2),
    ]);
  });

  it("does not refresh idle activity when a full peer queue rejects a question", async () => {
    let now = 0;
    const first = deferred<TestResult>();
    const answer = vi.fn<Answer>(async (question) =>
      question === "Q1" ? first.promise : answered(question));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer,
      sendText,
      config: { sessionIdleMs: 1_000 },
      now: () => now,
    });

    const handles = [bridge.handle(message("q1", "#a#U", "Q1"))];
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    for (let index = 2; index <= 6; index += 1) {
      handles.push(bridge.handle(message(`q${index}`, "#a#U", `Q${index}`)));
    }
    now = 900;
    handles.push(bridge.handle(message("q7", "#a#U", "Q7")));
    await vi.waitFor(() => expect(sentTexts(sendText)).toContain(
      "当前已有较多问题等待处理，请稍后再发送。",
    ));
    now = 1_000;
    const fresh = bridge.handle(message("q8", "#a#U", "Q8"));

    first.resolve(answered("Q1"));
    await Promise.all([...handles, fresh]);
    expect(sentTexts(sendText)).toContain(
      withProcessingGuide("已收到问题 #1，前面还有 1 个问题，已加入队列。"),
    );
    expect(answer.mock.calls.some((call) => call[0] === "Q7")).toBe(false);
    expect(answer.mock.calls.some((call) => call[0] === "Q8")).toBe(true);
  });

  it("emits hidden epochs and distinguishes manual from idle resets", async () => {
    let now = 0;
    const events: BridgeQuestionEvent[] = [];
    const bridge = createBridge({
      answer: async () => answered("回答"),
      sendText: async () => undefined,
      config: { sessionIdleMs: 1_000 },
      now: () => now,
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("q1", "#a#U", "第一问"));
    await bridge.handle(message("new", "#a#U", "/new", "new"));
    now = 100;
    await bridge.handle(message("q2", "#a#U", "第二问"));
    now = 1_100;
    await bridge.handle(message("q3", "#a#U", "第三问"));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "received",
        questionId: 1,
        sessionEpoch: 0,
      }),
      expect.objectContaining({
        type: "cancelled",
        sessionEpoch: 1,
        resetReason: "manual",
      }),
      expect.objectContaining({
        type: "received",
        questionId: 1,
        sessionEpoch: 1,
      }),
      expect.objectContaining({
        type: "cancelled",
        sessionEpoch: 2,
        resetReason: "idle",
      }),
      expect.objectContaining({
        type: "received",
        questionId: 1,
        sessionEpoch: 2,
      }),
    ]));
  });

  it("emits historical provider outcome independently from the total reference count", async () => {
    const events: BridgeQuestionEvent[] = [];
    const bridge = createBridge({
      answer: async (question) => question === "历史已展示"
        ? {
            answer: "历史回答已附加",
            status: "answered",
            retryable: false,
            stopReason: "final",
            historicalAttempted: true,
            historicalUsed: true,
            referenceCount: 3,
          }
        : {
            answer: "服务暂时不可用",
            status: "temporarily_unavailable",
            retryable: false,
            stopReason: "invalid_final",
            historicalAttempted: true,
            historicalUsed: false,
            referenceCount: 2,
            draftCoverage: ["partial"],
            verifiedCoverage: ["none"],
            retainedDirectSegmentCount: 0,
            retainedSynthesizedSegmentCount: 0,
            removedSegmentCount: 2,
            historicalGateReason: "formal_verification_incomplete",
          },
      sendText: async () => undefined,
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("answered", "#a#U", "历史已展示"));
    await bridge.handle(message("failed", "#a#U", "历史未展示"));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "answered",
        historicalAttempted: true,
        historicalUsed: true,
        referenceCount: 3,
      }),
      expect.objectContaining({
        type: "failed",
        historicalAttempted: true,
        historicalUsed: false,
        referenceCount: 2,
        draftCoverage: ["partial"],
        verifiedCoverage: ["none"],
        retainedDirectSegmentCount: 0,
        retainedSynthesizedSegmentCount: 0,
        removedSegmentCount: 2,
        historicalGateReason: "formal_verification_incomplete",
      }),
    ]));
  });

  it("emits only the fixed hidden-history reason without content", async () => {
    const events: BridgeQuestionEvent[] = [];
    const bridge = createBridge({
      answer: async () => ({
        answer: "正式知识未覆盖",
        scope: "professional",
        status: "not_covered",
        retryable: false,
        stopReason: "final",
        referenceCount: 0,
        historicalAttempted: true,
        historicalUsed: false,
        historicalNoticeShown: true,
        historicalRejectedReason: "topic_mismatch",
      }),
      sendText: async () => undefined,
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("hidden-history", "#a#U", "未覆盖"));

    expect(events).toContainEqual(expect.objectContaining({
      type: "answered",
      historicalAttempted: true,
      historicalUsed: false,
      historicalNoticeShown: true,
      historicalRejectedReason: "topic_mismatch",
    }));
    expect(JSON.stringify(events)).not.toContain("Coremail MCP 历史资料");
  });

  it("emits layered formal-evidence metadata for answered and not-covered results", async () => {
    const events: BridgeQuestionEvent[] = [];
    const bridge = createBridge({
      answer: async (question) => question === "正式归纳"
        ? {
            answer: "正式知识库归纳回答",
            scope: "general",
            status: "answered",
            retryable: false,
            stopReason: "final",
            referenceCount: 4,
            historicalAttempted: false,
            historicalUsed: false,
            draftCoverage: ["complete"],
            verifiedCoverage: ["complete"],
            retainedDirectSegmentCount: 1,
            retainedSynthesizedSegmentCount: 3,
            removedSegmentCount: 0,
          }
        : {
            answer: "正式知识库未覆盖",
            scope: "general",
            status: "not_covered",
            retryable: false,
            stopReason: "final",
            referenceCount: 0,
            historicalAttempted: false,
            historicalUsed: false,
            draftCoverage: ["none"],
            verifiedCoverage: ["none"],
            retainedDirectSegmentCount: 0,
            retainedSynthesizedSegmentCount: 0,
            removedSegmentCount: 1,
            historicalGateReason: "question_not_explicit_coremail",
          },
      sendText: async () => undefined,
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("formal", "#a#U", "正式归纳"));
    await bridge.handle(message("not-covered", "#a#U", "未覆盖"));

    const answeredEvent = events.find((event) =>
      event.type === "answered" && event.status === "answered"
    );
    expect(answeredEvent).toMatchObject({
      scope: "general",
      status: "answered",
      referenceCount: 4,
      historicalAttempted: false,
      historicalUsed: false,
      draftCoverage: ["complete"],
      verifiedCoverage: ["complete"],
      retainedDirectSegmentCount: 1,
      retainedSynthesizedSegmentCount: 3,
      removedSegmentCount: 0,
    });
    expect(answeredEvent).not.toHaveProperty("historicalGateReason");
    expect(events).toContainEqual(expect.objectContaining({
      type: "answered",
      scope: "general",
      status: "not_covered",
      draftCoverage: ["none"],
      verifiedCoverage: ["none"],
      retainedDirectSegmentCount: 0,
      retainedSynthesizedSegmentCount: 0,
      removedSegmentCount: 1,
      historicalGateReason: "question_not_explicit_coremail",
    }));
  });

  it("keeps the last retryable metadata when a later answer attempt throws", async () => {
    const events: BridgeQuestionEvent[] = [];
    const answer = vi.fn<Answer>()
      .mockResolvedValueOnce({
        answer: "服务暂时不可用",
        status: "temporarily_unavailable",
        retryable: true,
        stopReason: "model_unavailable",
        historicalAttempted: true,
        historicalUsed: false,
        referenceCount: 2,
      })
      .mockRejectedValueOnce(new Error("second attempt failed"));
    const bridge = createBridge({
      answer,
      sendText: async () => undefined,
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("retry-throws", "#a#U", "重试后失败"));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "failed",
        stopReason: "answer_error",
        historicalAttempted: true,
        historicalUsed: false,
        referenceCount: 2,
      }),
    ]));
  });

  it("keeps another peer running when one peer starts a new session", async () => {
    const otherResult = deferred<TestResult>();
    const answer = vi.fn<Answer>(async (question) =>
      question === "B1" ? otherResult.promise : answered(question));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    const other = bridge.handle(message("b1", "#b#U", "B1"));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    await bridge.handle(message("new-a", "#a#U", "/new", "new"));

    otherResult.resolve(answered("B1"));
    await other;

    expect(sentTexts(sendText)).toContain("问题 #1 的回答：\n\nB1");
  });

  it("does not cancel active work when the same peer asks for help", async () => {
    const result = deferred<TestResult>();
    const answer = vi.fn<Answer>(async () => result.promise);
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    const active = bridge.handle(message("a1", "#a#U", "A1"));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    await bridge.handle(message("help", "#a#U", "/help", "help"));
    result.resolve(answered("A1"));
    await active;

    expect(answer).toHaveBeenCalledOnce();
    expect(sentTexts(sendText)).toContain("问题 #1 的回答：\n\nA1");
  });

  it("suppresses late old-epoch results and clears pending work and context on /new", async () => {
    const oldResult = deferred<TestResult>();
    const oldWorkFinished = deferred<void>();
    const answer = vi.fn<Answer>(async (question) => {
      if (question !== "旧问题") return answered("新回答");
      const result = await oldResult.promise;
      oldWorkFinished.resolve();
      return result;
    });
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    const active = bridge.handle(message("old-1", "#a#U", "旧问题"));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    const pending = bridge.handle(message("old-2", "#a#U", "旧排队问题"));
    await bridge.handle(message("new", "#a#U", "/new", "new"));
    expect(sentTexts(sendText).at(-1)).toBe(
      "已开始新会话，之前处理中和排队的问题已取消。",
    );
    await Promise.all([active, pending]);

    oldResult.resolve(answered("不应回发"));
    await oldWorkFinished.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentTexts(sendText).join("\n")).not.toContain("不应回发");

    await bridge.handle(message("fresh", "#a#U", "新问题"));
    expect(answer.mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(sentTexts(sendText)).toContain(startedNotice(1));
  });

  it("retries one explicitly retryable result inside the shared budget", async () => {
    const answer = vi.fn<Answer>()
      .mockResolvedValueOnce(unavailable(true, "model_unavailable"))
      .mockResolvedValueOnce(answered("恢复后的回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("m1", "#a#U", "问题"));

    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(answer.mock.calls[1]?.[2]).toBeInstanceOf(AbortSignal);
    expect(sentTexts(sendText)).toContain(
      "问题 #1 的回答：\n\n恢复后的回答",
    );
  });

  it("uses the configured question budget for the shared abort signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const answer = vi.fn<Answer>(async () => answered("回答"));
      const bridge = createBridge({
        answer,
        sendText: vi.fn(async () => undefined),
        config: { questionBudgetMs: 600_000 },
        now: () => 10_000,
      });

      await bridge.handle(message("m-budget", "#a#U", "问题"));

      expect(timeout).toHaveBeenCalledWith(600_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("never performs a third attempt and does not store failed context", async () => {
    const answer = vi.fn<Answer>()
      .mockResolvedValueOnce(unavailable(true, "model_unavailable"))
      .mockResolvedValueOnce(unavailable(true, "model_unavailable"))
      .mockResolvedValueOnce(answered("下一题回答"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("m1", "#a#U", "失败问题"));
    await bridge.handle(message("m2", "#a#U", "下一题"));

    expect(answer).toHaveBeenCalledTimes(3);
    expect(sentTexts(sendText)).toContain(
      "问题 #1 处理失败：知识问答服务暂时不可用，请稍后重试。",
    );
    expect(answer.mock.calls[2]?.[1]).toBeUndefined();
  });

  it("does not retry a stable unavailable result", async () => {
    const answer = vi.fn<Answer>(async () =>
      unavailable(false, "invalid_model_payload"));
    const sendText = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("m1", "#a#U", "问题"));

    expect(answer).toHaveBeenCalledOnce();
    expect(sentTexts(sendText)).toContain(
      "问题 #1 处理失败：知识问答服务暂时不可用，请稍后重试。",
    );
  });

  it("retries Lunkr sending without re-answering", async () => {
    const answer = vi.fn<Answer>(async () => answered("回答"));
    const sendText = vi.fn(async () => undefined)
      .mockRejectedValueOnce(new Error("temporary send failure"))
      .mockResolvedValue(undefined);
    const bridge = createBridge({ answer, sendText });

    await bridge.handle(message("m1", "#a#U", "问题"));

    expect(answer).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledTimes(3);
  });

  it("does not start PSEAgent when the immediate acknowledgment cannot be sent", async () => {
    vi.useFakeTimers();
    try {
      const answer = vi.fn<Answer>(async () => answered("不应调用"));
      const sendText = vi.fn(async () => {
        throw new Error("send failed");
      });
      const bridge = createBridge({ answer, sendText });
      const handling = bridge.handle(message("m1", "#a#U", "问题"));
      const rejected = expect(handling).rejects.toThrow("send failed");

      await vi.runAllTimersAsync();
      await rejected;
      expect(answer).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a short answer in the normal text reply", async () => {
    const answer = vi.fn<Answer>(async () => answered("简短回答"));
    const sendText = vi.fn(async () => undefined);
    const sendPost = vi.fn(async () => undefined);
    const bridge = createBridge({ answer, sendText, sendPost });

    await bridge.handle(message("m1", "#a#U", "问题"));

    expect(sentTexts(sendText)).toEqual([
      startedNotice(1),
      "问题 #1 的回答：\n\n简短回答",
    ]);
    expect(sendPost).not.toHaveBeenCalled();
  });

  it("sends a long answer as one combined caption and text attachment", async () => {
    const longAnswer = [
      "## 压测场景设计",
      "甲".repeat(100),
      "## 关键性能指标",
      "乙".repeat(100),
    ].join("\n");
    const answer = vi.fn<Answer>(async () => answered(longAnswer));
    const sendText = vi.fn(async () => undefined);
    const sendTextFile = vi.fn(async () => undefined);
    const sendPost = vi.fn(async () => undefined);
    const events: BridgeQuestionEvent[] = [];
    const bridge = createBridge({
      answer,
      sendText,
      sendTextFile,
      sendPost,
      config: { messageMaxChars: 40 },
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("m1", "#a#U", "问题"));

    expect(sentTexts(sendText)).toEqual([startedNotice(1)]);
    expect(sendTextFile).toHaveBeenCalledOnce();
    expect(sendTextFile).toHaveBeenCalledWith(
      "#a#U",
      "问题#1-完整回答.txt",
      longAnswer,
      [
        "问题 #1 已处理完成",
        "本次回答涵盖：压测场景设计、关键性能指标。完整内容见附件。",
      ].join("\n"),
    );
    expect(sendPost).not.toHaveBeenCalled();
    expect(events.at(-1)?.deliveryMode).toBe("combined_attachment");
  });

  it("falls back to a standalone native post when combined delivery fails", async () => {
    const longAnswer = "甲".repeat(200);
    const answer = vi.fn<Answer>(async () => answered(longAnswer));
    const sendText = vi.fn(async () => undefined);
    const sendTextFile = vi.fn(async () => {
      throw new Error("combined delivery failed");
    });
    const sendPost = vi.fn(async () => undefined);
    const events: BridgeQuestionEvent[] = [];
    const bridge = createBridge({
      answer,
      sendText,
      sendTextFile,
      sendPost,
      config: { messageMaxChars: 40 },
      onEvent: (event) => events.push(event),
    });

    await bridge.handle(message("m1", "#a#U", "问题"));

    expect(sentTexts(sendText)).toEqual([startedNotice(1)]);
    expect(sendTextFile).toHaveBeenCalledOnce();
    expect(sendPost).toHaveBeenCalledWith(
      "#a#U",
      "问题#1-完整回答.txt",
      longAnswer,
    );
    expect(events.at(-1)?.deliveryMode).toBe("standalone_post");
  });

  it("stores only a clipped outline after combined attachment delivery", async () => {
    const longAnswer = "甲".repeat(200);
    const answer = vi.fn<Answer>(async (question, context) =>
      answered(question === "第一问" ? longAnswer : context ?? "无上下文"));
    const sendText = vi.fn(async () => undefined);
    const sendPost = vi.fn(async () => undefined);
    const bridge = createBridge({
      answer,
      sendText,
      sendPost,
      config: { messageMaxChars: 40 },
    });

    await bridge.handle(message("m1", "#a#U", "第一问"));
    await bridge.handle(message("m2", "#a#U", "第二问"));

    expect(answer.mock.calls[1]?.[1]).toContain("第一问");
    expect(answer.mock.calls[1]?.[1]).not.toContain(longAnswer);
    expect(answer.mock.calls[1]?.[1]).toContain("甲".repeat(80));
    expect(answer.mock.calls[1]?.[1]).not.toContain("完整回答.txt");
    expect(answer.mock.calls[1]?.[1]).not.toContain("问题 #1");
  });

  it("carries numbered answer points into a dependent follow-up without source paths", async () => {
    const firstAnswer="1. 确认迁移范围\n2. 获取客户端专用密码\n3. 检查 IMAP/SMTP\n\n资料来源：\nwiki/concepts/迁移.md";
    const answer=vi.fn<Answer>(async(question,context)=>answered(question==="第一问"?firstAnswer:context??"无上下文"));
    const sendText=vi.fn(async()=>undefined);
    const bridge=createBridge({answer,sendText});
    await bridge.handle(message("m1","#a#U","第一问"));
    await bridge.handle(message("m2","#a#U","把第二点展开说说"));
    expect(answer.mock.calls[1]?.[1]).toContain("2. 获取客户端专用密码");
    expect(answer.mock.calls[1]?.[1]).not.toContain("资料来源");
    expect(answer.mock.calls[1]?.[1]).not.toContain("wiki/");
  });

  it("restores persisted context, saves the resolved follow-up and ends it on new",async()=>{const requestId="019fcd9f-cfb9-7c62-93a9-39b84c7e00aa",load=vi.fn(async()=>({session:{sessionId:"019fcd9f-cfb9-7c62-93a9-39b84c7e00ab"},recentTurns:[{requestId:"019fcd9f-cfb9-7c62-93a9-39b84c7e00ac",resolvedQuestion:"腾讯企业邮箱迁移前需要哪些设置？",answerOutline:"1. 确认范围\n2. 获取客户端专用密码"}]})),append=vi.fn(async()=>undefined),end=vi.fn(async()=>undefined),conversation:BridgeConversationDependencies={pseudonymizationKey:"context-test-key-with-more-than-32-characters",load,append,end},answer=vi.fn<Answer>(async(_question,context)=>({...answered("请在安全设置中生成客户端专用密码。"),requestId,resolvedQuestion:"腾讯企业邮箱迁移时，客户端专用密码怎么生成？",contextUsed:true,inheritedSubjects:["客户端专用密码"]})),sendText=vi.fn(async()=>undefined),bridge=createBridge({answer,sendText,conversation});await bridge.handle(message("m1","#a#U","第二点怎么操作？"));expect(answer.mock.calls[0]?.[1]).toContain("2. 获取客户端专用密码");expect(append).toHaveBeenCalledWith(expect.objectContaining({requestId,rawQuestion:"第二点怎么操作？",resolvedQuestion:"腾讯企业邮箱迁移时，客户端专用密码怎么生成？",contextUsed:true,inheritedSubjects:["客户端专用密码"],answerOutline:"请在安全设置中生成客户端专用密码。"}));await bridge.handle(message("m2","#a#U","/new","new"));expect(end).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/u),"manual",expect.any(String));});

  it("falls back to numbered chunks when native text post delivery fails", async () => {
    vi.useFakeTimers();
    try {
      const answer = vi.fn<Answer>(async () => answered("甲".repeat(200)));
      const sendText = vi.fn(async () => undefined);
      const sendTextFile = vi.fn(async () => {
        throw new Error("combined delivery failed");
      });
      const sendPost = vi.fn(async () => {
        throw new Error("post failed");
      });
      const events: BridgeQuestionEvent[] = [];
      const bridge = createBridge({
        answer,
        sendText,
        sendTextFile,
        sendPost,
        config: { messageMaxChars: 40 },
        onEvent: (event) => events.push(event),
      });

      const handling = bridge.handle(message("m1", "#a#U", "问题"));
      await vi.runAllTimersAsync();
      await handling;

      expect(answer).toHaveBeenCalledOnce();
      expect(sendTextFile).toHaveBeenCalledOnce();
      expect(sendPost).toHaveBeenCalledTimes(3);
      expect(sentTexts(sendText)[1]).toBe(
        "问题 #1 的附件发送失败，下面改为分段发送完整回答。",
      );
      const answerChunks = sentTexts(sendText).slice(2);
      expect(answerChunks.length).toBeGreaterThan(1);
      answerChunks.forEach((chunk, index) => {
        expect(chunk.startsWith(
          `问题 #1（${index + 1}/${answerChunks.length}）\n\n`,
        )).toBe(true);
        expect(chunk.length).toBeLessThanOrEqual(40);
      });
      expect(events.at(-1)?.deliveryMode).toBe("segmented_text");
    } finally {
      vi.useRealTimers();
    }
  });
});

function createBridge(options: {
  readonly answer: Answer;
  readonly sendText: (peerUid: string, text: string) => Promise<void>;
  readonly sendPost?: (
    peerUid: string,
    title: string,
    content: string,
  ) => Promise<void>;
  readonly sendTextFile?: (
    peerUid: string,
    title: string,
    content: string,
    caption: string,
  ) => Promise<void>;
  readonly config?: Partial<LunkrDirectConfig>;
  readonly now?: () => number;
  readonly onEvent?: (event: BridgeQuestionEvent) => void;
  readonly feedback?: BridgeFeedbackDependencies;
  readonly answerReview?: BridgeAnswerReviewDependencies;
  readonly conversation?: BridgeConversationDependencies;
}) {
  return new LunkrPseBridge(
    { ...config, ...options.config },
    {
      answer: options.answer,
      formatAnswer: (result) => result.answer,
      describeResult: (result) => ({
        requestId: result.requestId,
        scope: result.scope,
        status: result.status,
        retryable: result.retryable ?? false,
        stopReason: result.stopReason,
        referenceCount: result.referenceCount ?? 0,
        historicalAttempted: result.historicalAttempted ?? false,
        historicalUsed: result.historicalUsed ?? false,
        historicalNoticeShown: result.historicalNoticeShown,
        historicalRejectedReason: result.historicalRejectedReason,
        draftCoverage: result.draftCoverage,
        verifiedCoverage: result.verifiedCoverage,
        retainedDirectSegmentCount: result.retainedDirectSegmentCount,
        retainedSynthesizedSegmentCount:
          result.retainedSynthesizedSegmentCount,
        removedSegmentCount: result.removedSegmentCount,
        historicalGateReason: result.historicalGateReason,
        references: result.references,
        resolvedQuestion:result.resolvedQuestion,
        contextUsed:result.contextUsed,
        inheritedSubjects:result.inheritedSubjects,
      }),
      sendText: options.sendText,
      sendTextFile: options.sendTextFile ?? (async () => undefined),
      sendPost: options.sendPost ?? (async () => undefined),
      onEvent: options.onEvent,
      feedback: options.feedback,
      answerReview: options.answerReview,
      conversation:options.conversation,
    },
    options.now,
  );
}

function answered(answer: string): TestResult {
  return {
    requestId: "019fcd9f-cfb9-7c62-93a9-39b84c7e00f9",
    answer,
    status: "answered",
    retryable: false,
    stopReason: "final",
  };
}

function unavailable(retryable: boolean, stopReason: string): TestResult {
  return {
    answer: "知识问答服务暂时不可用，请稍后重试。",
    status: "temporarily_unavailable",
    retryable,
    stopReason,
  };
}

function sentTexts(sendText: ReturnType<typeof vi.fn>): string[] {
  return sendText.mock.calls.map((call) => String(call[1]));
}

function withProcessingGuide(message: string): string {
  return [
    message,
    "",
    "处理期间可以：",
    "/status  查看问题状态",
    "/new     取消当前及排队问题，开始新会话",
    "         独立问题建议先用 /new，可清除上下文并提高回答准确率",
    "/help    查看全部使用说明",
  ].join("\n");
}

function startedNotice(questionId: number): string {
  return withProcessingGuide(
    `问题 #${questionId} 已收到，正在检索并核对相关资料。`,
  );
}

function message(
  id: string,
  peerUid: string,
  text: string,
  command?: DirectCommand,
): LunkrDirectMessage {
  return {
    id,
    peerUid,
    senderUid: peerUid,
    timestamp: Date.now(),
    text,
    hasAttachments: false,
    ...(command === undefined ? {} : { command }),
  };
}

function feedbackMessage(
  id: string,
  peerUid: string,
  questionId: number,
  classification: "useful" | "incorrect" | "missing" | "evidence",
  comment: string,
): LunkrDirectMessage {
  return {
    ...message(
      id,
      peerUid,
      `/feedback #${questionId} ${classification}${comment === "" ? "" : ` ${comment}`}`,
      "feedback",
    ),
    feedback: { questionId, classification, comment },
  };
}

function quickFeedbackMessage(
  id: string,
  peerUid: string,
  classification: "useful" | "incorrect" | "missing" | "review_requested",
  comment: string,
): LunkrDirectMessage {
  const option = {
    useful: 1,
    incorrect: 2,
    missing: 3,
    review_requested: 4,
  }[classification];
  const detail = comment;
  return {
    ...message(
      id,
      peerUid,
      `/q ${option}${detail === "" ? "" : ` ${detail}`}`,
      "feedback",
    ),
    feedback: {
      classification,
      comment,
    },
  };
}

function feedbackDependencies(
  submit: (submission: BridgeFeedbackSubmission) => Promise<void>,
): BridgeFeedbackDependencies {
  return {
    pseudonymizationKey: "feedback-test-key-with-at-least-32-characters",
    submit,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
