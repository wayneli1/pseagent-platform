import type { Scope } from "./contracts.js";
import {
  isUnambiguouslyGeneralPresalesQuestion,
  isUnambiguouslyProfessionalQuestion,
} from "./router.js";

const GENERAL_BOUNDARY_FALLBACK_PATTERN =
  /(?:客户|销售|售前|采购|营销|决策人|联系人|价格|价值|演示|预算|黄灯|绿灯|谈判|商机|机会|报名|互动|渠道|竞争对手|竞品|投标|付款|授权函|客户高层|BATNA|MTL|ROI)/iu;
const STRONG_GENERAL_BOUNDARY_PATTERN =
  /(?:采购.{0,20}营销|渠道|客户授权函|客户高层|竞争对手|竞品|投标底价|付款方式|BATNA|MTL|ROI)/iu;

export function inferBoundaryScope(question: string): Exclude<Scope, "normal"> {
  if (STRONG_GENERAL_BOUNDARY_PATTERN.test(question)) return "general";
  if (isUnambiguouslyGeneralPresalesQuestion(question)) return "general";
  if (isUnambiguouslyProfessionalQuestion(question)) return "professional";
  return GENERAL_BOUNDARY_FALLBACK_PATTERN.test(question) ? "general" : "professional";
}
