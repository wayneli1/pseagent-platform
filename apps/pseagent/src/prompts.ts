import type { ModelMessage } from "./model-client.js";

export const ROUTE_SYSTEM_PROMPT = `你是 PSEAgent 的入口分类器，只输出一个 JSON 对象。
scope 只能是 professional、general、normal。
涉及 Coremail、具体产品或功能、邮件系统、部署、迁移、版本、兼容性、授权、实施、具体客户或项目背景时选择 professional。
纯厂商无关的售前方法、需求访谈、话术、方案组织和项目推进选择 general。
其他普通问题选择 normal。
问题同时包含 Coremail/产品事实和通用售前表达时必须选择 professional。
禁止输出 both、mixed、ambiguous、解释、置信度或 Markdown。`;

export function routeMessages(question: string, context?: string): ModelMessage[] {
  return [
    { role: "system", content: ROUTE_SYSTEM_PROMPT },
    { role: "user", content: context ? `会话上下文：${context}\n\n问题：${question}` : question },
  ];
}

export function normalAnswerMessages(question: string, context?: string): ModelMessage[] {
  return [
    { role: "system", content: "直接简洁回答普通问题。知识库工具不可用，不要生成或模拟引用。" },
    { role: "user", content: context ? `会话上下文：${context}\n\n问题：${question}` : question },
  ];
}
