import {describe,expect,it} from "vitest";
import {repairProposalSchema} from "./schemas.js";

const proposal={rootCause:"user_missing" as const,targetKind:"answer_card" as const,targetDomain:"coremail-professional" as const,targetPath:"wiki/queries/迁移.md",cardId:"PRO-MIGRATION",title:"迁移设置",canonicalQuestion:"迁移前需要哪些设置？",aliases:["迁移要准备什么？"],answerTemplate:"先确认域名和路由。",obligations:[{id:"O1",label:"列出准备项",evidencePolicy:"direct" as const,requiredConcepts:["域名"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/迁移.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"迁移前需要哪些设置？"},{kind:"alias" as const,question:"迁移要准备什么？"},{kind:"colloquial" as const,question:"迁移这事儿要先整啥？"},{kind:"follow_up" as const,question:"关于迁移设置，下一步呢？"},{kind:"negative" as const,question:"今天天气怎么样？"}],generationSummary:"补充同义问法。",publishable:true};

describe("repair proposal schema",()=>{
  it("accepts valid UTF-8 repair content",()=>{expect(repairProposalSchema.parse(proposal)).toMatchObject({publishable:true});});
  it("rejects replacement characters and repeated question-mark mojibake",()=>{
    expect(repairProposalSchema.safeParse({...proposal,aliases:["????Coremail????"]}).success).toBe(false);
    expect(repairProposalSchema.safeParse({...proposal,answerTemplate:"迁移前先确认�域名"}).success).toBe(false);
  });
});
