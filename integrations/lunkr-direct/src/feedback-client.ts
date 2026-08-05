import type { BridgeFeedbackSubmission } from "./feedback-receipt-store.js";
import type { BridgeAnswerReviewSubmission } from "./answer-review-submission.js";

export interface FeedbackClientOptions { readonly baseUrl:string; readonly serviceToken:string; readonly timeoutMs?:number; }

export class HttpFeedbackClient {
  private readonly endpoint:URL;private readonly reviewEndpoint:URL;private readonly timeoutMs:number;
  constructor(private readonly options:FeedbackClientOptions){
    this.endpoint=new URL("/v1/feedback",validateBaseUrl(options.baseUrl));
    this.reviewEndpoint=new URL("/v1/answer-reviews",validateBaseUrl(options.baseUrl));
    if(options.serviceToken.trim().length<24)throw new Error("feedback_service_token_invalid");
    this.timeoutMs=options.timeoutMs??5_000;if(!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<100||this.timeoutMs>30_000)throw new Error("feedback_timeout_invalid");
  }
  async submit(submission:BridgeFeedbackSubmission):Promise<void>{
    await this.post(this.endpoint,submission);
  }
  async submitReview(submission:BridgeAnswerReviewSubmission):Promise<void>{
    await this.post(this.reviewEndpoint,submission);
  }
  private async post(endpoint:URL,submission:BridgeFeedbackSubmission|BridgeAnswerReviewSubmission):Promise<void>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{const response=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${this.options.serviceToken}`,"content-type":"application/json"},body:JSON.stringify(submission),signal:controller.signal,redirect:"error"});
      if(!response.ok)throw new Error(`feedback_service_rejected_${response.status}`);
    }catch(error){if(error instanceof Error&&error.message.startsWith("feedback_service_rejected_"))throw error;throw new Error("feedback_service_unavailable");}finally{clearTimeout(timer);}
  }
}
function validateBaseUrl(value:string):URL{const url=new URL(value);const loopback=url.hostname==="127.0.0.1"||url.hostname==="localhost"||url.hostname==="[::1]";if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback))throw new Error("feedback_service_url_must_be_https_or_loopback");if(url.username||url.password)throw new Error("feedback_service_url_credentials_rejected");return url;}
