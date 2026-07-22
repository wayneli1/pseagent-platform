import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "./model-client.js";
import { AnswerService } from "./answer-service.js";

describe("AnswerService", () => {
  it("answers normal questions without opening a knowledge session", async () => {
    const model = { completeText: vi.fn(async () => "普通回答") } as unknown as ModelClient;
    const router = { route: vi.fn(async () => "normal" as const) };
    const knowledge = { open: vi.fn() };
    const runAgent = vi.fn();
    const service = new AnswerService({ model, router, knowledge, runAgent });

    await expect(service.answer("普通问题")).resolves.toEqual({
      scope: "normal", status: "answered", answer: "普通回答", references: [],
    });
    expect(knowledge.open).not.toHaveBeenCalled();
  });
});
