import { describe, expect, it, vi } from "vitest";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import {
  identityResolvedQuestion,
  InvalidResolvedQuestionError,
  ModelQuestionResolver,
  QUESTION_RESOLVER_SYSTEM_PROMPT,
} from "./question-resolver.js";

describe("ModelQuestionResolver", () => {
  it("uses an identity result without a model call when no context exists", async () => {
    const model = {
      completeJson: vi.fn(),
      completeText: vi.fn(),
    } as unknown as ModelClient;
    const resolver = new ModelQuestionResolver(model);

    await expect(resolver.resolve({ question: "Coremail 如何部署？" }))
      .resolves.toEqual(identityResolvedQuestion("Coremail 如何部署？"));
    expect(model.completeJson).not.toHaveBeenCalled();
  });

  it("resolves a contextual follow-up into a standalone question", async () => {
    const completeJson = vi.fn(async (input: Parameters<ModelClient["completeJson"]>[0]) => {
      expect(input.schemaDescription).toBe("pse_resolved_question");
      expect(input.messages[0]?.content).toBe(QUESTION_RESOLVER_SYSTEM_PROMPT);
      expect(input.messages[1]?.content).toContain("华为");
      return input.schema.parse({
        action: "resolve",
        standaloneQuestion: "知识库是否有华为的多节点方案？",
        contextUsed: true,
        inheritedSubjects: ["多节点方案"],
        corrections: [{
          original: "多借点",
          normalized: "多节点",
          confidence: "high",
        }],
      });
    });
    const resolver = new ModelQuestionResolver({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(resolver.resolve({
      question: "是没有华为的多借点方案么",
      conversationContext: "用户：平安想调整架构，参考工行、华为、比亚迪的多节点方案",
    })).resolves.toMatchObject({
      rawQuestion: "是没有华为的多借点方案么",
      standaloneQuestion: "知识库是否有华为的多节点方案？",
      contextUsed: true,
      corrections: [{ original: "多借点", normalized: "多节点" }],
    });
  });

  it("rejects corrections that cannot be traced to the current question", async () => {
    const model = {
      completeJson: vi.fn(async () => ({
        action: "resolve",
        standaloneQuestion: "华为多节点方案",
        contextUsed: true,
        inheritedSubjects: [],
        corrections: [{
          original: "不存在的原词",
          normalized: "多节点",
          confidence: "high",
        }],
      })),
      completeText: vi.fn(),
    } as unknown as ModelClient;

    await expect(new ModelQuestionResolver(model).resolve({
      question: "华为多借点方案",
      conversationContext: "用户：多节点方案",
    })).rejects.toBeInstanceOf(InvalidResolvedQuestionError);
  });

  it("makes bounded repairs for invalid model payloads", async () => {
    const completeJson = vi.fn(async () => {
      throw new InvalidModelPayloadError();
    });
    const resolver = new ModelQuestionResolver({
      completeJson,
      completeText: vi.fn(),
    } as unknown as ModelClient);

    await expect(resolver.resolve({
      question: "还有华为呢？",
      conversationContext: "用户：比较三家客户",
    })).rejects.toBeInstanceOf(InvalidModelPayloadError);
    expect(completeJson).toHaveBeenCalledTimes(3);
  });
});

