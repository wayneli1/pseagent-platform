import { describe, expect, it, vi } from "vitest";
import {
  evaluateCoremailHistoricalAnswer,
  StdioCoremailHistoricalAnswerProvider,
  coremailKnowledgeArguments,
  sanitizeCoremailHistoricalAnswer,
} from "./coremail-mcp-client.js";

const rawAnswer = [
  "原始答案",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
].join("\n");

const validRaw = {
  answer: rawAnswer,
  confidence: "low",
  sources: [
    {
      source_type: "jira",
      id: "10001",
      key: "CMHA-1097",
      title: "镜像版本记录",
      url: "https://jira.example.test/browse/CMHA-1097",
      updated_at: "2026-07-20",
      metadata: { status: "已解决", fix_versions: ["5.0", "5.1"] },
    },
    {
      source_type: "local",
      id: "local-1",
      title: "本地索引",
      url: "https://local.example.test/1",
    },
  ],
  diagnostics: { secret: "must-not-leak" },
};
const displayRaw = {
  ...validRaw,
  confidence: "medium",
  sources: [{
    ...validRaw.sources[0],
    title: "Coremail 镜像版本记录",
    excerpt: "该历史资料记录了 Coremail 镜像版本的发布与验证方式。",
  }],
};

describe("sanitizeCoremailHistoricalAnswer", () => {
  it("preserves the raw answer and maps only Jira/Wiki public fields", () => {
    const result = sanitizeCoremailHistoricalAnswer(validRaw);
    expect(result?.answer).toBe(rawAnswer);
    expect(result?.confidence).toBe("low");
    expect(result?.references).toEqual([{
      sourceType: "jira",
      id: "10001",
      key: "CMHA-1097",
      title: "镜像版本记录",
      url: "https://jira.example.test/browse/CMHA-1097",
      updatedAt: "2026-07-20",
      status: "已解决",
      versions: ["5.0", "5.1"],
    }]);
    expect(result).not.toHaveProperty("diagnostics");
  });

  it.each([
    { ...validRaw, confidence: "none" },
    { ...validRaw, answer: "" },
    { ...validRaw, answer: " \n " },
    { ...validRaw, answer: "x".repeat(32_769) },
    { ...validRaw, sources: [] },
    { ...validRaw, sources: [{ source_type: "local", title: "仅本地" }] },
    { ...validRaw, sources: [{ source_type: "unknown", title: "未知来源" }] },
  ])("rejects unsupported or unverifiable output", (value) => {
    expect(sanitizeCoremailHistoricalAnswer(value)).toBeUndefined();
  });

  it("maps Wiki identifiers without retaining unlisted metadata", () => {
    expect(sanitizeCoremailHistoricalAnswer({
      ...validRaw,
      sources: [{
        source_type: "wiki",
        id: "page-1",
        title: "历史 Wiki",
        metadata: { status: "有效", secret_field: "discard" },
      }],
    })?.references).toEqual([{
      sourceType: "wiki",
      id: "page-1",
      title: "历史 Wiki",
      status: "有效",
    }]);
  });

  it("builds the one fixed tool argument shape", () => {
    expect(coremailKnowledgeArguments("当前问题")).toEqual({
      question: "当前问题",
      intent: "auto",
      limit: 8,
      includeComments: true,
      commentMode: "relevant",
      profileRanking: true,
      explainRanking: false,
      includeRelationExpansion: true,
      relationDepth: 1,
      diagnosticsLevel: "summary",
    });
  });
});

describe("evaluateCoremailHistoricalAnswer", () => {
  it("rejects the real Exchange comparison mismatch backed only by SMC attachments", () => {
    const result = evaluateCoremailHistoricalAnswer(
      "对比 Exchange 邮件系统，Coremail 的优势有哪些？",
      {
        answer: [
          "围绕问题检索到 3 个候选来源。",
          "附件：【SMC2高级版与SMC1高级版功能对比-v2220】功能对比.xlsx",
          "https://wiki.coremail.cn/pages/viewpage.action?pageId=1221525564",
        ].join("\n"),
        confidence: "medium",
        sources: [{
          source_type: "wiki",
          id: "1221525564",
          title: "【SMC2高级版与SMC1高级版功能对比】功能对比.xlsx",
          url: "https://wiki.coremail.cn/pages/viewpage.action?pageId=1221525564",
          excerpt: "附件：SMC2高级版与SMC1高级版功能对比，类型：application/vnd.openxmlformats-officedocument.spreadsheetml.sheet，大小：15924 bytes",
          evidence_blocks: [{
            role: "attachment",
            text: "附件：SMC2高级版与SMC1高级版功能对比.xlsx",
            next_action: "Use list_attachments to inspect metadata.",
          }],
        }],
      },
    );

    expect(result).toEqual({
      outcome: "hidden",
      reason: "topic_mismatch",
    });
  });

  it("hides a topic-matching answer when Coremail MCP reports low confidence", () => {
    expect(evaluateCoremailHistoricalAnswer(
      "Coremail 海外邮件投递策略有哪些？",
      {
        answer: "历史资料提到 Coremail 海外邮件投递策略。",
        confidence: "low",
        sources: [{
          source_type: "jira",
          key: "MAIL-100",
          title: "Coremail 海外邮件投递策略",
          excerpt: "该问题记录了海外邮件投递策略与退信处理方式。",
        }],
      },
    )).toEqual({
      outcome: "hidden",
      reason: "low_confidence",
    });
  });

  it("reports a completed lookup with no reliable source separately from failure", () => {
    expect(evaluateCoremailHistoricalAnswer(
      "Coremail 未收录能力",
      {
        confidence: "none",
        sources: [],
      },
    )).toEqual({
      outcome: "hidden",
      reason: "no_reliable_source",
    });
  });

  it("accepts a medium-confidence answer with substantive matching evidence", () => {
    const result = evaluateCoremailHistoricalAnswer(
      "Coremail 海外邮件投递策略有哪些？",
      {
        answer: "历史资料提到 Coremail 海外邮件投递策略。",
        confidence: "medium",
        sources: [{
          source_type: "jira",
          key: "MAIL-100",
          title: "Coremail 海外邮件投递策略",
          excerpt: "该问题记录了海外邮件投递策略与退信处理方式。",
        }],
      },
    );

    expect(result).toMatchObject({
      outcome: "display",
      answer: {
        confidence: "medium",
        answer: "历史资料提到 Coremail 海外邮件投递策略。",
        references: [{ key: "MAIL-100" }],
      },
    });
  });

  it("accepts a comparison only when substantive evidence covers both products", () => {
    expect(evaluateCoremailHistoricalAnswer(
      "对比 Exchange 邮件系统，Coremail 的优势有哪些？",
      {
        answer: "历史资料记录了 Coremail 与 Exchange 的迁移和能力差异。",
        confidence: "medium",
        sources: [{
          source_type: "wiki",
          id: "comparison-1",
          title: "Coremail 与 Exchange 邮件系统对比",
          excerpt: "正文比较了 Coremail 和 Exchange 的部署、迁移与管理差异。",
        }],
      },
    )).toMatchObject({
      outcome: "display",
      answer: {
        confidence: "medium",
        references: [{ id: "comparison-1" }],
      },
    });
  });

  it("removes URLs and bounds accepted historical content before exposing it", () => {
    const result = evaluateCoremailHistoricalAnswer(
      "Coremail 海外邮件投递策略有哪些？",
      {
        answer: [
          "Coremail 海外邮件投递策略历史说明。",
          "内部链接：https://wiki.coremail.cn/pages/viewpage.action?pageId=1",
          "正文".repeat(1_200),
        ].join("\n"),
        confidence: "medium",
        sources: Array.from({ length: 5 }, (_, index) => ({
          source_type: "jira",
          key: `MAIL-${index + 1}`,
          title: `Coremail 海外邮件投递策略来源 ${index + 1}`,
          url: `https://jira.coremail.cn/browse/MAIL-${index + 1}`,
          excerpt: "该问题记录了海外邮件投递策略与退信处理方式。",
        })),
      },
    );

    expect(result.outcome).toBe("display");
    if (result.outcome !== "display") throw new Error("expected display");
    expect(result.answer.answer.length).toBeLessThanOrEqual(2_000);
    expect(result.answer.answer).not.toContain("https://");
    expect(result.answer.references).toHaveLength(3);
    expect(result.answer.references.every((reference) =>
      reference.url === undefined
    )).toBe(true);
  });

  it("treats malformed Coremail MCP output as unavailable", () => {
    expect(evaluateCoremailHistoricalAnswer(
      "Coremail 海外邮件投递策略有哪些？",
      { answer: 42, confidence: "medium", sources: "invalid" },
    )).toEqual({ outcome: "unavailable" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type FakeMcpResult = {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

function fakeClient(
  result: FakeMcpResult = { structuredContent: validRaw },
) {
  return {
    connect: vi.fn<(transport: unknown) => Promise<void>>(
      async (_transport: unknown) => undefined,
    ),
    listTools: vi.fn(async () => ({
      tools: [
        { name: "answer_coremail_knowledge" },
        { name: "auth_login" },
        { name: "search_jira" },
      ],
    })),
    callTool: vi.fn(async (
      _request: { name: string; arguments: Record<string, unknown> },
      _resultSchema?: undefined,
      _options?: { signal?: AbortSignal },
    ) => result),
    close: vi.fn(async () => undefined),
  };
}

describe("StdioCoremailHistoricalAnswerProvider", () => {
  it("is lazy, memoizes concurrent connect, and only calls the fixed tool", async () => {
    const gate = deferred<void>();
    const client = fakeClient();
    client.connect.mockImplementation(() => gate.promise);
    const transportFactory = vi.fn(() => ({ stderr: null }));
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: transportFactory,
        reportError: vi.fn(),
      },
    );
    expect(client.connect).not.toHaveBeenCalled();

    const first = provider.answer("问题一");
    const second = provider.answer("问题二");
    gate.resolve();
    await Promise.all([first, second]);

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.callTool.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        {
          name: "answer_coremail_knowledge",
          arguments: coremailKnowledgeArguments("问题一"),
        },
        {
          name: "answer_coremail_knowledge",
          arguments: coremailKnowledgeArguments("问题二"),
        },
      ]),
    );
    for (const call of client.callTool.mock.calls) {
      expect(call[1]).toBeUndefined();
      expect(call[2]?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(transportFactory).toHaveBeenCalledOnce();
  });

  it("forces a minimal child environment without PSE or Knowledge secrets", async () => {
    const client = fakeClient();
    const createTransport = vi.fn(() => ({ stderr: null }));
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport,
        defaultEnvironment: () => ({
          PATH: "safe-path",
          PSE_MODEL_API_KEY: "must-not-pass",
          KNOWLEDGE_ENGINE_TOKEN: "must-not-pass",
          KNOWLEDGE_MCP_ENTRY_PATH: "must-not-pass",
        }),
        reportError: vi.fn(),
      },
    );

    await provider.answer("问题");

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      command: "node",
      args: ["C:\\runtime\\dist\\server.js"],
      env: {
        PATH: "safe-path",
        AI_ADOPTION_ENABLED: "false",
        KNOWLEDGE_ENABLE_CACHE: "false",
        KNOWLEDGE_AUTH_INTERACTIVE: "false",
      },
      stderr: "pipe",
    }));
  });

  it("returns a hidden no-source result without reporting a runtime error", async () => {
    const reportError = vi.fn();
    const client = fakeClient({
      structuredContent: { answer: "无来源", confidence: "none", sources: [] },
    });
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError,
      },
    );

    await expect(provider.answer("Coremail 未收录能力")).resolves.toEqual({
      outcome: "hidden",
      reason: "no_reliable_source",
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("closes the underlying client once", async () => {
    const client = fakeClient();
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError: vi.fn(),
      },
    );
    await provider.answer("问题");
    await provider.close();
    await provider.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("uses text JSON only when structuredContent is absent", async () => {
    const client = fakeClient({
      content: [{ type: "text", text: JSON.stringify(displayRaw) }],
    });
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError: vi.fn(),
      },
    );

    await expect(provider.answer("Coremail 镜像版本记录")).resolves.toMatchObject({
      outcome: "display",
      answer: { answer: rawAnswer },
    });
  });

  it("prefers structuredContent and does not parse fallback text when both exist", async () => {
    const client = fakeClient({
      structuredContent: displayRaw,
      content: [{ type: "text", text: "not-json" }],
    });
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError: vi.fn(),
      },
    );

    await expect(provider.answer("Coremail 镜像版本记录")).resolves.toMatchObject({
      outcome: "display",
      answer: { answer: rawAnswer },
    });
  });

  it("rejects a tool list without answer_coremail_knowledge", async () => {
    const reportError = vi.fn();
    const client = fakeClient();
    client.listTools.mockResolvedValue({ tools: [{ name: "search_jira" }] });
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError,
      },
    );

    await expect(provider.answer("问题")).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(reportError).toHaveBeenCalledWith("coremail_mcp_connect_failed");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("aborts on timeout, closes the broken client, and permits a later reconnect", async () => {
    const reportError = vi.fn();
    const firstClient = fakeClient();
    firstClient.callTool.mockImplementation(async (_request, _resultSchema, options) =>
      await new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error("missing_abort_signal"));
          return;
        }
        const rejectOnAbort = () => reject(signal.reason);
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener("abort", rejectOnAbort, { once: true });
      }));
    const secondClient = fakeClient({ structuredContent: displayRaw });
    const clients = [firstClient, secondClient];
    const createClient = vi.fn(() => {
      const client = clients.shift();
      if (!client) throw new Error("unexpected_client_generation");
      return client;
    });
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 5,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient,
        createTransport: () => ({ stderr: null }),
        reportError,
      },
    );

    await expect(provider.answer("第一次")).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(reportError).toHaveBeenLastCalledWith("coremail_mcp_timeout");
    expect(firstClient.close).toHaveBeenCalledOnce();

    await expect(provider.answer("Coremail 镜像版本记录")).resolves.toMatchObject({
      outcome: "display",
      answer: { answer: rawAnswer },
    });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(secondClient.callTool).toHaveBeenCalledOnce();
  });

  it("classifies authentication failures without reporting the raw message", async () => {
    const reportError = vi.fn();
    const client = fakeClient();
    client.callTool.mockRejectedValue(
      new Error("401 authentication failed: secret response body"),
    );
    const provider = new StdioCoremailHistoricalAnswerProvider(
      "C:\\runtime\\dist\\server.js",
      {
        command: "node",
        timeoutMs: 30_000,
        validateEntry: () => "C:\\runtime\\dist\\server.js",
        createClient: () => client,
        createTransport: () => ({ stderr: null }),
        reportError,
      },
    );

    await expect(provider.answer("问题")).resolves.toEqual({
      outcome: "unavailable",
    });
    expect(reportError).toHaveBeenCalledWith("coremail_mcp_auth_failed");
    expect(JSON.stringify(reportError.mock.calls)).not.toContain("secret response body");
  });
});
