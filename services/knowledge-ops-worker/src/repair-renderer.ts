import { parse,stringify } from "yaml";
import type { RepairDraftProposal } from "@pseagent/knowledge-ops";

export function renderRepairMarkdown(proposal:RepairDraftProposal,originalMarkdown:string|undefined,timestamp=new Date()):string{
  if(!proposal.publishable||proposal.targetKind!=="answer_card"||proposal.targetDomain===undefined||proposal.cardId===undefined)throw new Error("repair_proposal_not_renderable");
  const original=originalMarkdown===undefined?{}:frontmatter(originalMarkdown),date=timestamp.toISOString().slice(0,10),contextualCases=new Set(proposal.regressionQuestions.filter((item)=>item.kind==="follow_up"||item.kind==="negative").map((item)=>item.question.trim()));
  const metadata:Record<string,unknown>={...original,type:"query",title:proposal.title,created:original.created??date,updated:date,
    card_schema_version:1,card_id:proposal.cardId,canonical_question:proposal.canonicalQuestion,
    question_family:original.question_family??`repair_${proposal.cardId.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu,"_").replace(/^_|_$/gu,"")}`,
    aliases:proposal.aliases.filter((item)=>!contextualCases.has(item.trim())),applicable_product:original.applicable_product??[],applicable_version:original.applicable_version??"*",
    applicable_scenarios:original.applicable_scenarios??[],exclude_when:original.exclude_when??[],
    obligations:proposal.obligations.map((item)=>({id:item.id,label:item.label,required:true,domains:[proposal.targetDomain],evidence_policy:item.evidencePolicy,
      required_concepts:[...item.requiredConcepts],forbidden_claims:[...item.forbiddenClaims],preferred_evidence_paths:[...item.preferredEvidencePaths]})),
    owner:original.owner??"PSE知识运营",reviewers:original.reviewers??["PSE知识运营管理员"],review_status:"approved",
    regression_case_ids:proposal.regressionQuestions.map((item,index)=>`RC-${proposal.cardId}-${String(index+1).padStart(2,"0")}`),
  };
  const yaml=stringify(metadata,{lineWidth:0}).trimEnd();return`---\n${yaml}\n---\n# ${proposal.title}\n\n${proposal.answerTemplate.trim()}\n`;
}

function frontmatter(markdown:string):Record<string,unknown>{const normalized=markdown.replace(/\r\n?/gu,"\n");if(!normalized.startsWith("---\n"))throw new Error("repair_original_frontmatter_missing");const end=normalized.indexOf("\n---\n",4);if(end<0)throw new Error("repair_original_frontmatter_unclosed");const value=parse(normalized.slice(4,end));if(value===null||typeof value!=="object"||Array.isArray(value))throw new Error("repair_original_frontmatter_invalid");return value as Record<string,unknown>;}
