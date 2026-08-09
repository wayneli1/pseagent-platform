import { describe, expect, it, vi } from "vitest";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";
import {
  identityResolvedQuestion,
  InvalidResolvedQuestionError,
  ModelQuestionResolver,
  QUESTION_RESOLVER_SYSTEM_PROMPT,
  requiresContextualRouteResolution,
} from "./question-resolver.js";

describe("requiresContextualRouteResolution", () => {
  const context = JSON.stringify({
    version: 3,
    recentTurns: [{ question: "演示前确认什么？", answerOutline: "1. 参会角色\n2. 关键业务问题" }],
  });

  it.each([
    "你刚才列的第二点具体怎么确认？",
    "那它在什么情况下算具备资格？",
    "这个具体怎么判断？",
  ])("detects a context-dependent follow-up: %s", (question) => {
    expect(requiresContextualRouteResolution(question, context)).toBe(true);
  });

  it.each([
    "换个话题：为什么拓扑排序只适用于有向无环图？",
    "为什么拓扑排序只适用于有向无环图？",
  ])("does not inherit context for a standalone topic: %s", (question) => {
    expect(requiresContextualRouteResolution(question, context)).toBe(false);
  });

  it("requires actual conversation context", () => {
    expect(requiresContextualRouteResolution("你刚才列的第二点是什么？")).toBe(false);
  });
});

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

  it("uses the numbered item in a recent answer outline", async () => {
    const context=JSON.stringify({version:3,recentTurns:[{question:"迁移前要做什么？",answerOutline:"1. 确认迁移范围\n2. 获取客户端专用密码\n3. 检查 IMAP/SMTP"}]});
    const model={completeJson:vi.fn(async()=>({action:"resolve",standaloneQuestion:"请详细说明迁移前如何获取并使用客户端专用密码。",contextUsed:true,inheritedSubjects:["客户端专用密码"],corrections:[]})),completeText:vi.fn()} as unknown as ModelClient;
    await expect(new ModelQuestionResolver(model).resolve({question:"把刚才第二点展开说说",conversationContext:context})).resolves.toMatchObject({standaloneQuestion:"请详细说明迁移前如何获取并使用客户端专用密码。",contextUsed:true,inheritedSubjects:["客户端专用密码"]});
  });

  it("repairs a model result that ignores an explicit numbered answer reference", async () => {
    const context=JSON.stringify({version:3,recentTurns:[{question:"演示前确认什么？",answerOutline:"1. 参会角色\n2. 关键业务问题\n3. 判断标准"}]});
    const completeJson=vi.fn()
      .mockResolvedValueOnce({action:"resolve",standaloneQuestion:"你刚才列的第二点具体怎么确认？",contextUsed:false,inheritedSubjects:[],corrections:[]})
      .mockResolvedValueOnce({action:"resolve",standaloneQuestion:"演示前如何确认客户的关键业务问题？",contextUsed:true,inheritedSubjects:["关键业务问题"],corrections:[]});
    const model={completeJson,completeText:vi.fn()} as unknown as ModelClient;

    await expect(new ModelQuestionResolver(model).resolve({
      question:"你刚才列的第二点具体怎么确认？",
      conversationContext:context,
    })).resolves.toMatchObject({
      standaloneQuestion:"演示前如何确认客户的关键业务问题？",
      contextUsed:true,
      inheritedSubjects:["关键业务问题"],
    });
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("repairs an unresolved leading personal pronoun when recent turns contain the role antecedent", async () => {
    const context=JSON.stringify({version:3,recentTurns:[{question:"真正决策者与普通影响者有什么区别？",answerOutline:"真正决策者能调动预算和资源；影响者只能影响评估过程，需要通过共同会议和决策历史持续验证。"}]});
    const completeJson=vi.fn()
      .mockResolvedValueOnce({action:"resolve",standaloneQuestion:"判断他是否真的能调动预算和资源，最少要核验哪几类实际行为？",contextUsed:false,inheritedSubjects:[],corrections:[]})
      .mockResolvedValueOnce({action:"resolve",standaloneQuestion:"判断真正决策者是否能调动预算和资源，最少要核验哪几类实际行为？",contextUsed:true,inheritedSubjects:["真正决策者"],corrections:[]});
    const model={completeJson,completeText:vi.fn()} as unknown as ModelClient;

    await expect(new ModelQuestionResolver(model).resolve({
      question:"那判断他是否真的能调动预算和资源，最少要核验哪几类实际行为？",
      conversationContext:context,
    })).resolves.toMatchObject({
      standaloneQuestion:"判断真正决策者是否能调动预算和资源，最少要核验哪几类实际行为？",
      contextUsed:true,
      inheritedSubjects:["真正决策者"],
    });
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("repairs a corrective follow-up that drops answer-changing parent constraints",async()=>{
    const context=JSON.stringify({version:3,recentTurns:[{question:"有一个客户要购买邮件系统，他们有5000用户，需要多活高可用，建议如何设计架构？",answerOutline:"推荐两台前端、两台后端和一台仲裁服务器。"}]});
    const incomplete={action:"resolve",standaloneQuestion:"Coremail 邮件系统架构需要几台前端服务器和几台后端服务器？",contextUsed:true,inheritedSubjects:["邮件系统"],corrections:[]};
    const completeJson=vi.fn()
      .mockResolvedValueOnce(incomplete)
      .mockResolvedValueOnce({...incomplete,standaloneQuestion:"5000用户、需要多活高可用的 Coremail 邮件系统架构，需要几台前端和几台后端？",inheritedSubjects:["邮件系统","5000用户","多活高可用"]});
    const model={completeJson,completeText:vi.fn()} as unknown as ModelClient;

    await expect(new ModelQuestionResolver(model).resolve({
      question:"你并没有答复我应该如何设计架构，几台前端几台后端",
      conversationContext:context,
    })).resolves.toMatchObject({
      standaloneQuestion:expect.stringContaining("5000用户"),
      contextUsed:true,
      inheritedSubjects:expect.arrayContaining(["多活高可用"]),
    });
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(completeJson.mock.calls[1])).toContain("丢失了最近问题中会改变答案的数量");
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
