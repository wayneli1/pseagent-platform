import { describe, expect, it, vi } from "vitest";
import {
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

  it("returns undefined and reports only a safe code on invalid output", async () => {
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

    await expect(provider.answer("问题")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith("coremail_mcp_invalid_result");
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
      content: [{ type: "text", text: JSON.stringify(validRaw) }],
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

    await expect(provider.answer("问题")).resolves.toMatchObject({ answer: rawAnswer });
  });

  it("prefers structuredContent and does not parse fallback text when both exist", async () => {
    const client = fakeClient({
      structuredContent: validRaw,
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

    await expect(provider.answer("问题")).resolves.toMatchObject({ answer: rawAnswer });
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

    await expect(provider.answer("问题")).resolves.toBeUndefined();
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
    const secondClient = fakeClient();
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

    await expect(provider.answer("第一次")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenLastCalledWith("coremail_mcp_timeout");
    expect(firstClient.close).toHaveBeenCalledOnce();

    await expect(provider.answer("第二次")).resolves.toMatchObject({ answer: rawAnswer });
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

    await expect(provider.answer("问题")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith("coremail_mcp_auth_failed");
    expect(JSON.stringify(reportError.mock.calls)).not.toContain("secret response body");
  });
});
