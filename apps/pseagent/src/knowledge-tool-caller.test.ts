import { describe, expect, it, vi } from "vitest";
import { StdioKnowledgeToolCaller } from "./knowledge-tool-caller.js";

const allowedTools = [
  "knowledge_status",
  "knowledge_context",
  "knowledge_search",
  "knowledge_read",
  "knowledge_graph",
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeClient(toolNames = allowedTools) {
  return {
    connect: vi.fn<() => Promise<void>>(async () => undefined),
    listTools: vi.fn(async () => ({ tools: toolNames.map((name) => ({ name })) })),
    callTool: vi.fn(async () => ({ structuredContent: { ok: true } })),
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
}

describe("StdioKnowledgeToolCaller", () => {
  it("validates the exact five-tool allowlist", async () => {
    const client = fakeClient([...allowedTools, "shell"]);
    const caller = new StdioKnowledgeToolCaller(process.execPath, {
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
    });

    await expect(caller.connect()).rejects.toThrow("knowledge_mcp_tool_allowlist_mismatch");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("memoizes concurrent connect calls", async () => {
    const gate = deferred<void>();
    const client = fakeClient();
    client.connect.mockImplementation(() => gate.promise);
    const caller = new StdioKnowledgeToolCaller(process.execPath, {
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
    });

    const first = caller.connect();
    const second = caller.connect();
    gate.resolve();
    await Promise.all([first, second]);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("waits when closed during connect and cannot resurrect the transport", async () => {
    const gate = deferred<void>();
    const client = fakeClient();
    client.connect.mockImplementation(() => gate.promise);
    const caller = new StdioKnowledgeToolCaller(process.execPath, {
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
    });

    const connecting = caller.connect();
    const closing = caller.close();
    gate.resolve();
    await expect(connecting).rejects.toThrow("knowledge_mcp_closed");
    await closing;
    await expect(caller.connect()).rejects.toThrow("knowledge_mcp_closed");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("passes cancellation to MCP request options", async () => {
    const client = fakeClient();
    const caller = new StdioKnowledgeToolCaller(process.execPath, {
      createClient: () => client,
      createTransport: () => ({ stderr: null }),
    });
    const controller = new AbortController();

    await caller.call("knowledge_status", {}, controller.signal);

    expect(client.callTool).toHaveBeenCalledWith(
      { name: "knowledge_status", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
  });

  it.each(["relative.js", "C:\\definitely-missing\\entry.js"])(
    "rejects an invalid entry before creating a transport: %s",
    async (entryPath) => {
      const createTransport = vi.fn(() => ({ stderr: null }));
      const caller = new StdioKnowledgeToolCaller(entryPath, {
        createClient: () => fakeClient(),
        createTransport,
      });

      await expect(caller.connect()).rejects.toThrow("knowledge_mcp_invalid_entry");
      expect(createTransport).not.toHaveBeenCalled();
    },
  );

  it("redacts child errors and never inherits stderr", async () => {
    const secret = "token-and-local-knowledge";
    const client = fakeClient();
    client.connect.mockRejectedValue(new Error(secret));
    const createTransport = vi.fn(() => ({ stderr: { on: vi.fn() } }));
    const caller = new StdioKnowledgeToolCaller(process.execPath, { createClient: () => client, createTransport });

    const error = await caller.connect().catch((reason: unknown) => reason);

    expect(String(error)).not.toContain(secret);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ stderr: "pipe" }));
  });
});
