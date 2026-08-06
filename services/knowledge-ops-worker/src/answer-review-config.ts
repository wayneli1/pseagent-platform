import { z } from "zod";

const schema=z.object({
  PSE_MODEL_BASE_URL:z.string().url(),
  PSE_MODEL_API_KEY:z.string().trim().min(1),
  PSE_MODEL_NAME:z.string().trim().min(1),
  PSE_ANSWER_REVIEW_MODEL_NAME:z.string().trim().min(1).optional(),
  PSE_REPAIR_MODEL_NAME:z.string().trim().min(1).optional(),
  PSE_MODEL_JSON_RESPONSE_FORMAT:z.enum(["true","false"]).default("true"),
  PSE_ANSWER_REVIEW_TIMEOUT_MS:z.coerce.number().int().min(1_000).max(180_000).default(60_000),
  PSE_ANSWER_REVIEW_MAX_TOKENS:z.coerce.number().int().min(1_024).max(16_384).default(4_096),
  PSE_REPAIR_MODEL_TIMEOUT_MS:z.coerce.number().int().min(1_000).max(300_000).default(180_000),
  PSE_REPAIR_MODEL_MAX_TOKENS:z.coerce.number().int().min(1_024).max(16_384).default(4_096),
}).passthrough();

export function loadAnswerReviewModelConfig(env:NodeJS.ProcessEnv){
  const parsed=schema.parse(env);const model=parsed.PSE_ANSWER_REVIEW_MODEL_NAME??parsed.PSE_MODEL_NAME;
  if(model!=="deepseek_v4_flash")throw new Error("answer_review_model_must_be_deepseek_v4_flash");
  return{baseUrl:parsed.PSE_MODEL_BASE_URL,apiKey:parsed.PSE_MODEL_API_KEY,model,timeoutMs:parsed.PSE_ANSWER_REVIEW_TIMEOUT_MS,maxTokens:parsed.PSE_ANSWER_REVIEW_MAX_TOKENS,jsonResponseFormat:parsed.PSE_MODEL_JSON_RESPONSE_FORMAT==="true"};
}

export function loadRepairModelConfig(env:NodeJS.ProcessEnv){
  const parsed=schema.parse(env);const model=parsed.PSE_REPAIR_MODEL_NAME??parsed.PSE_MODEL_NAME;
  if(model!=="deepseek_v4_flash")throw new Error("repair_model_must_be_deepseek_v4_flash");
  return{baseUrl:parsed.PSE_MODEL_BASE_URL,apiKey:parsed.PSE_MODEL_API_KEY,model,timeoutMs:parsed.PSE_REPAIR_MODEL_TIMEOUT_MS,maxTokens:parsed.PSE_REPAIR_MODEL_MAX_TOKENS,jsonResponseFormat:parsed.PSE_MODEL_JSON_RESPONSE_FORMAT==="true"};
}
