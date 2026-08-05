import { describe,expect,it } from "vitest";
import { loadAnswerReviewModelConfig } from "./answer-review-config.js";

describe("answer review model config",()=>{
  const base={PSE_MODEL_BASE_URL:"https://model.example.test/v1",PSE_MODEL_API_KEY:"secret",PSE_MODEL_NAME:"deepseek_v4_flash"};
  it("locks independent review to deepseek_v4_flash",()=>{expect(loadAnswerReviewModelConfig(base)).toMatchObject({model:"deepseek_v4_flash",timeoutMs:60_000,maxTokens:4_096});});
  it("rejects a different review model even when the general model is valid",()=>{expect(()=>loadAnswerReviewModelConfig({...base,PSE_ANSWER_REVIEW_MODEL_NAME:"another-model"})).toThrow("answer_review_model_must_be_deepseek_v4_flash");});
});
