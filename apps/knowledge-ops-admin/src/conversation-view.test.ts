import {describe,expect,it} from "vitest";
import {conversationPresentation} from "./conversation-view.js";
import type {ConversationRelation,ConversationTurn} from "./types.js";

const turn=(overrides:Partial<ConversationTurn>={},linked=true):ConversationTurn=>({turnId:"turn-2",sessionId:"session-1",turnIndex:2,requestId:"request-2",questionId:2,...(linked?{parentTurnId:"turn-1",parentRequestId:"request-1"}:{}),rawQuestion:"第二点怎么操作？",resolvedQuestion:"腾讯企业邮箱迁移到 Coremail 时，客户端专用密码如何配置？",contextUsed:true,inheritedSubjects:["客户端专用密码"],answerOutline:"进入安全设置生成并配置专用密码",answerStatus:"answered",answeredAt:"2026-08-06T03:00:00.000Z",createdAt:"2026-08-06T03:00:00.000Z",...overrides});
const relation=(current=turn()):ConversationRelation=>({session:{sessionId:"session-1",pseudonymousUserId:"a".repeat(64),source:"lunkr_direct",startedAt:"2026-08-06T02:59:00.000Z",lastActiveAt:"2026-08-06T03:00:00.000Z",expiresAt:"2026-08-07T03:00:00.000Z"},current,parent:turn({turnId:"turn-1",turnIndex:1,requestId:"request-1",questionId:1,rawQuestion:"腾讯企业邮箱迁移到 Coremail 前需要哪些设置？",resolvedQuestion:"腾讯企业邮箱迁移到 Coremail 前需要哪些设置？",contextUsed:false,inheritedSubjects:[],answerOutline:"第二点是客户端专用密码"},false),chain:[]});

describe("管理台上下文关系展示",()=>{
  it("把省略主语的第二问展示为绑定上一问的上下文追问",()=>expect(conversationPresentation("第二点怎么操作？",relation())).toMatchObject({kind:"follow_up",label:"上下文追问",rawQuestion:"第二点怎么操作？",resolvedQuestion:"腾讯企业邮箱迁移到 Coremail 时，客户端专用密码如何配置？",parentQuestion:"腾讯企业邮箱迁移到 Coremail 前需要哪些设置？",parentAnswerOutline:"第二点是客户端专用密码",inheritedSubjects:["客户端专用密码"]}));
  it("不会把主题已切换的新问题错误绑定到上一问",()=>expect(conversationPresentation("Exchange 有什么优势？",relation(turn({rawQuestion:"Exchange 有什么优势？",resolvedQuestion:"Exchange 有什么优势？",contextUsed:false,inheritedSubjects:[]},false)))).toMatchObject({kind:"independent",label:"独立问题",rawQuestion:"Exchange 有什么优势？"}));
  it("兼容尚未记录上下文的历史数据",()=>expect(conversationPresentation("历史问题")).toEqual({kind:"history",label:"历史记录",rawQuestion:"历史问题",resolvedQuestion:"历史问题",inheritedSubjects:[]}));
});
