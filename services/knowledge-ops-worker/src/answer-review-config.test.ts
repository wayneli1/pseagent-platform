import { describe,expect,it } from "vitest";
import { loadAnswerReviewModelConfig,loadRepairModelConfig } from "./answer-review-config.js";

describe("answer review model config",()=>{
  const base={PSE_MODEL_BASE_URL:"https://model.example.test/v1",PSE_MODEL_API_KEY:"secret",PSE_MODEL_NAME:"deepseek_v4_flash"};
  it("locks independent review to deepseek_v4_flash",()=>{expect(loadAnswerReviewModelConfig(base)).toMatchObject({model:"deepseek_v4_flash",timeoutMs:60_000,maxTokens:4_096});});
  it("gives long repair generation an independent three-minute budget",()=>{expect(loadRepairModelConfig(base)).toMatchObject({model:"deepseek_v4_flash",timeoutMs:180_000,maxTokens:4_096});});
  it("does not let the short answer-review timeout leak into repair generation",()=>{expect(loadRepairModelConfig({...base,PSE_ANSWER_REVIEW_TIMEOUT_MS:"15000"})).toMatchObject({timeoutMs:180_000});});
  it("accepts an explicit bounded repair timeout",()=>{expect(loadRepairModelConfig({...base,PSE_REPAIR_MODEL_TIMEOUT_MS:"240000"})).toMatchObject({timeoutMs:240_000});});
  it("rejects a different review model even when the general model is valid",()=>{expect(()=>loadAnswerReviewModelConfig({...base,PSE_ANSWER_REVIEW_MODEL_NAME:"another-model"})).toThrow("answer_review_model_must_be_deepseek_v4_flash");});
  it("rejects a different repair model",()=>{expect(()=>loadRepairModelConfig({...base,PSE_REPAIR_MODEL_NAME:"another-model"})).toThrow("repair_model_must_be_deepseek_v4_flash");});
});
