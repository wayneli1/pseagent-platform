import { randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { HttpFeedbackClient } from "./feedback-client.js";

afterEach(()=>vi.unstubAllGlobals());
it("submits explicit feedback with bearer authentication",async()=>{const fetchMock=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>new Response(null,{status:201}));vi.stubGlobal("fetch",fetchMock);const client=new HttpFeedbackClient({baseUrl:"http://127.0.0.1:19830",serviceToken:"service-token-with-more-than-24-characters"});await client.submit({caseId:randomUUID(),requestId:randomUUID(),pseudonymousUserId:"a".repeat(64),questionId:1,classification:"useful",comment:"",question:"问题",answer:"答案",answerStatus:"answered",referenceCount:1,answeredAt:new Date().toISOString(),submittedAt:new Date().toISOString(),source:"lunkr_direct",audit:{event:"feedback_submitted",occurredAt:new Date().toISOString()}});expect(fetchMock).toHaveBeenCalledOnce();expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({authorization:"Bearer service-token-with-more-than-24-characters"});});
it("rejects plaintext remote feedback endpoints",()=>{expect(()=>new HttpFeedbackClient({baseUrl:"http://example.com",serviceToken:"service-token-with-more-than-24-characters"})).toThrow("feedback_service_url_must_be_https_or_loopback");});
