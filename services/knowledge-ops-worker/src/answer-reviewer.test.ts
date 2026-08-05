import { describe,expect,it } from "vitest";
import type { ModelClient } from "@pseagent/app/embedded";
import type { AnswerCard, AnswerReviewResult } from "@pseagent/knowledge-governance-contracts";
import { IndependentAnswerReviewer } from "./answer-reviewer.js";

const card:AnswerCard={cardSchemaVersion:1,cardId:"PRO-REVIEW-TEST",domain:"coremail-professional",title:"迁移前置",canonicalQuestion:"迁移前要做什么？",questionFamily:"migration_prerequisites",aliases:[],applicability:{products:[],versions:["*"],scenarios:[],excludeWhen:[]},obligations:[{id:"O1",label:"准备认证与协议",required:true,domains:["coremail-professional"],evidencePolicy:"direct",requiredConcepts:["客户端专用密码","IMAP","SMTP"],forbiddenClaims:["普通登录密码一定可以直接用于迁移"],preferredEvidencePaths:[]}],answerTemplate:"",owner:"运营",reviewers:[],reviewStatus:"approved",regressionCaseIds:[]};
const pass:AnswerReviewResult={verdict:"pass",score:95,summary:"完整",defects:[],obligationChecks:[{obligationId:"O1",covered:true,explanation:"已覆盖"}]};
const evidence=[{index:1,title:"正式资料",path:"wiki/concepts/a.md",content:"迁移应生成客户端专用密码并开启 IMAP 和 SMTP。"}];

describe("IndependentAnswerReviewer",()=>{
  it("downgrades a model pass when governed concepts are absent",async()=>{const result=await new IndependentAnswerReviewer(scripted(pass)).review({question:"迁移前要做什么？",answer:"请勾选收取全部邮件。",answerStatus:"answered",evidence,evidenceIssues:[],exactCard:card,answerCardActivation:{activated:true}});expect(result.verdict).toBe("needs_review");expect(result.score).toBeLessThanOrEqual(69);expect(result.defects.some((item)=>item.category==="coverage_gap"&&item.evidence.includes("客户端专用密码"))).toBe(true);});
  it("keeps a fully governed paraphrase as pass instead of requiring exact phrase copying",async()=>{const result=await new IndependentAnswerReviewer(scripted(pass)).review({question:"迁移前要做什么？",answer:"生成客户端的专用密码，并开启 IMAP 与 SMTP。",answerStatus:"answered",evidence,evidenceIssues:[],exactCard:card,answerCardActivation:{activated:true}});expect(result).toMatchObject({verdict:"pass",score:95,defects:[]});});
  it("fails a forbidden governed claim even when the model says pass",async()=>{const result=await new IndependentAnswerReviewer(scripted(pass)).review({question:"迁移前要做什么？",answer:"普通登录密码一定可以直接用于迁移；同时开启客户端专用密码、IMAP、SMTP。",answerStatus:"answered",evidence,evidenceIssues:[],exactCard:card});expect(result.verdict).toBe("fail");expect(result.score).toBeLessThanOrEqual(39);});
  it("normalizes an internally inconsistent low pass score to the pass range",async()=>{const result=await new IndependentAnswerReviewer(scripted({...pass,score:10})).review({question:"迁移前要做什么？",answer:"生成客户端专用密码，并开启 IMAP 与 SMTP。",answerStatus:"answered",evidence,evidenceIssues:[],exactCard:card,answerCardActivation:{activated:true}});expect(result).toMatchObject({verdict:"pass",score:80});});
});

function scripted(result:AnswerReviewResult):ModelClient{return{completeJson:async<T>()=>result as T,completeText:async()=>""};}
