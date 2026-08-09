import {describe,expect,it} from "vitest";
import {answerReviewListQuerySchema,feedbackListQuerySchema,issueListQuerySchema,issuePatchSchema,paginatedListQuerySchema,repairBatchRequestSchema,repairProposalSchema} from "./schemas.js";

const proposal={rootCause:"user_missing" as const,targetKind:"answer_card" as const,targetDomain:"coremail-professional" as const,targetPath:"wiki/queries/迁移.md",cardId:"PRO-MIGRATION",title:"迁移设置",canonicalQuestion:"迁移前需要哪些设置？",aliases:["迁移要准备什么？"],answerTemplate:"先确认域名和路由。",obligations:[{id:"O1",label:"列出准备项",evidencePolicy:"direct" as const,requiredConcepts:["域名"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/迁移.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"迁移前需要哪些设置？"},{kind:"alias" as const,question:"迁移要准备什么？"},{kind:"colloquial" as const,question:"迁移这事儿要先整啥？"},{kind:"follow_up" as const,question:"关于迁移设置，下一步呢？"},{kind:"negative" as const,question:"今天天气怎么样？"}],generationSummary:"补充同义问法。",publishable:true};

describe("repair proposal schema",()=>{
  it("accepts valid UTF-8 repair content",()=>{expect(repairProposalSchema.parse(proposal)).toMatchObject({publishable:true});});
  it("rejects replacement characters and repeated question-mark mojibake",()=>{
    expect(repairProposalSchema.safeParse({...proposal,aliases:["????Coremail????"]}).success).toBe(false);
    expect(repairProposalSchema.safeParse({...proposal,answerTemplate:"迁移前先确认�域名"}).success).toBe(false);
  });
  it("requires at least one reusable alias for a publishable repair",()=>{expect(repairProposalSchema.safeParse({...proposal,aliases:[]}).success).toBe(false);expect(repairProposalSchema.safeParse({...proposal,aliases:[],answerTemplate:"",obligations:[],regressionQuestions:[],publishable:false,blockingReason:"缺少正式证据"}).success).toBe(true);});
  it("accepts a structured evidence request for a blocked repair",()=>{expect(repairProposalSchema.parse({...proposal,aliases:[],answerTemplate:"",obligations:[],regressionQuestions:[],publishable:false,blockingReason:"缺少正式证据",blockingKind:"evidence_required",evidenceRequest:{summary:"需要补充迁移规范。",requiredMaterials:["正式迁移手册"],acceptanceCriteria:["标明适用版本和生效日期"]}})).toMatchObject({blockingKind:"evidence_required",evidenceRequest:{requiredMaterials:["正式迁移手册"]}});});
  it("enforces the publishable answer-card limits for required concepts",()=>{
    const obligation=proposal.obligations[0]!;
    expect(repairProposalSchema.safeParse({...proposal,obligations:[{...obligation,requiredConcepts:["x".repeat(101)]}]}).success).toBe(false);
    expect(repairProposalSchema.safeParse({...proposal,obligations:[{...obligation,requiredConcepts:Array.from({length:21},(_,index)=>`concept-${index}`)}]}).success).toBe(false);
  });
});

describe("list query schemas",()=>{
  it("supports the dedicated evidence status and defaults paginated lists to twenty-five rows",()=>{expect(issueListQuerySchema.parse({status:"awaiting_evidence"})).toMatchObject({status:"awaiting_evidence"});expect(paginatedListQuerySchema.parse({})).toEqual({limit:25,offset:0});});
  it("rejects oversized pages and negative offsets",()=>{expect(paginatedListQuerySchema.safeParse({limit:101,offset:0}).success).toBe(false);expect(paginatedListQuerySchema.safeParse({limit:25,offset:-1}).success).toBe(false);});
  it("parses record filters and rejects conflicting actionable filters",()=>{expect(answerReviewListQuerySchema.parse({actionable:"true"})).toMatchObject({actionable:true,limit:25,offset:0});expect(feedbackListQuerySchema.parse({status:"resolved",limit:"10",offset:"20"})).toEqual({status:"resolved",limit:10,offset:20});expect(answerReviewListQuerySchema.safeParse({verdict:"fail",actionable:"true"}).success).toBe(false);expect(feedbackListQuerySchema.safeParse({status:"new",actionable:"true"}).success).toBe(false);});
});

describe("issue workflow schema",()=>{
  it("allows an administrator to close a system defect as resolved",()=>{expect(issuePatchSchema.parse({status:"resolved"})).toEqual({status:"resolved"});});
});

describe("repair batch request schema",()=>{
  it("accepts one to fifty unique draft identifiers",()=>{const ids=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"];expect(repairBatchRequestSchema.parse({draftIds:ids})).toEqual({draftIds:ids});});
  it("rejects duplicate or empty selections",()=>{const id="00000000-0000-4000-8000-000000000001";expect(repairBatchRequestSchema.safeParse({draftIds:[id,id]}).success).toBe(false);expect(repairBatchRequestSchema.safeParse({draftIds:[]}).success).toBe(false);});
});
