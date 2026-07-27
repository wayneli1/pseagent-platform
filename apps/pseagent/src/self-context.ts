export const PSEAGENT_SELF_CONTEXT = `PSEAgent 是 Coremail 售前问答统一入口。
它把问题分为三类：普通问题由主模型直接回答；Coremail 产品、功能、部署、迁移和客户项目问题只查询专业知识库；厂商无关的售前方法问题只查询通用售前知识库。
专业和通用问题每次只绑定一个知识库，正式知识回答必须引用实际读取的知识页。
正式知识库完全未覆盖时，才可以附加只读 Coremail Jira/Wiki 历史资料；部分覆盖时不会查询历史资料。
当前运行路径直接接入 Lunkr（论客）私聊，不使用 OpenClaw。Lunkr 只负责消息输入、有限会话上下文和回答输出，不参与 PSEAgent 的路由、检索、模型调用或引用生成。`;

const EXPLICIT_PSEAGENT = /pse[\s_-]*agent/iu;
const CURRENT_ASSISTANT = /(?:当前|这个|本)(?:机器人|助手|智能体|agent)/iu;
const SECOND_PERSON = /你(?:自己|本身|的)/u;
const SELF_INTENT =
  /(?:目标|架构|身份|是谁|是什么|能做什么|怎么工作|工作原理|运行方式|运行路径|知识库|知识边界|问答边界|路由|检索|引用|上下文|preagent|lunkr|论客|openclaw)/iu;

export function isPseAgentSelfQuestion(question: string): boolean {
  const normalized = question.trim();
  if (EXPLICIT_PSEAGENT.test(normalized)) return true;
  if (CURRENT_ASSISTANT.test(normalized)) return SELF_INTENT.test(normalized);
  return SECOND_PERSON.test(normalized) && SELF_INTENT.test(normalized);
}
