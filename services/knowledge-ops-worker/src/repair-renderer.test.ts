import { expect,it } from "vitest";
import { parseAnswerCard } from "./catalog-compiler.js";
import { renderRepairMarkdown } from "./repair-renderer.js";

it("renders a governed answer card while preserving source metadata",()=>{const original=`---
type: query
title: 旧标题
created: 2026-01-01
card_schema_version: 1
card_id: PRO-RENDER-TEST
canonical_question: "旧问题？"
question_family: render_test
aliases: []
source_url: "https://example.invalid/source"
applicable_version: "*"
obligations:
  - id: O1
    label: 旧必答项
    required: true
    domains: [coremail-professional]
    evidence_policy: direct
    required_concepts: [旧概念]
    forbidden_claims: []
    preferred_evidence_paths: [wiki/concepts/证据.md]
owner: PSE
reviewers: [管理员]
review_status: approved
regression_case_ids: []
---
# 旧标题

旧答案
`,proposal={rootCause:"coverage_gap" as const,targetKind:"answer_card" as const,targetDomain:"coremail-professional" as const,targetPath:"wiki/queries/旧标题.md",cardId:"PRO-RENDER-TEST",title:"新标题",canonicalQuestion:"新问题？",aliases:["新问法？","口语问法"],answerTemplate:"这是有证据的新答案。",obligations:[{id:"O1",label:"新必答项",evidencePolicy:"direct" as const,requiredConcepts:["新概念"],forbiddenClaims:["错误承诺"],preferredEvidencePaths:["wiki/concepts/证据.md"]}],regressionQuestions:[{kind:"canonical" as const,question:"新问题？"},{kind:"alias" as const,question:"新问法？"},{kind:"colloquial" as const,question:"口语问法"},{kind:"follow_up" as const,question:"那具体怎么做？"},{kind:"negative" as const,question:"无关问题"}],generationSummary:"修订",publishable:true};const rendered=renderRepairMarkdown(proposal,original,new Date("2026-08-05T00:00:00Z")),card=parseAnswerCard(rendered,"coremail-professional");expect(rendered).toContain("source_url: https://example.invalid/source");expect(rendered).toContain("updated: 2026-08-05");expect(card).toMatchObject({cardId:"PRO-RENDER-TEST",title:"新标题",canonicalQuestion:"新问题？",reviewStatus:"approved"});expect(card?.answerTemplate).toContain("这是有证据的新答案。");expect(card?.obligations[0]).toMatchObject({label:"新必答项",requiredConcepts:["新概念"],forbiddenClaims:["错误承诺"]});});
