import {afterEach,describe,expect,it,vi} from "vitest";
import {OpsApiClient} from "./api.js";

afterEach(()=>vi.unstubAllGlobals());

describe("management session API client",()=>{
  it("does not send bearer authorization with credentials and uses only the returned session afterwards",async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({sessionToken:"session-token",expiresAt:"2026-08-05T12:00:00.000Z",user:{username:"admin"}}),{status:200,headers:{"content-type":"application/json"}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ok:true}),{status:200,headers:{"content-type":"application/json"}}));
    vi.stubGlobal("fetch",fetchMock);const api=new OpsApiClient("");const session=await api.login("admin","test-admin-password");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/auth/login");expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({"content-type":"application/json"});
    api.setSessionToken(session.sessionToken);await api.get("/v1/dashboard");expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({authorization:"Bearer session-token"});
  });
  it("turns an aborted management request into an actionable timeout",async()=>{vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new DOMException("timed out","TimeoutError")));await expect(new OpsApiClient("session").get("/v1/jobs")).rejects.toMatchObject({status:503,code:"management_service_timeout"});});
  it("supports paginated and legacy array responses without leaving the page loading",async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(["first","second","third"]),{status:200,headers:{"content-type":"application/json"}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({items:["third"],total:3}),{status:200,headers:{"content-type":"application/json"}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({items:"invalid",total:3}),{status:200,headers:{"content-type":"application/json"}}));
    vi.stubGlobal("fetch",fetchMock);const api=new OpsApiClient("session");
    await expect(api.getPage<string>("/v1/audit?limit=1&offset=1",1,1,(item)=>item!=="first")).resolves.toEqual({items:["third"],total:2});
    await expect(api.getPage<string>("/v1/audit?limit=1&offset=2",2,1)).resolves.toEqual({items:["third"],total:3});
    await expect(api.getPage<string>("/v1/audit?limit=1&offset=0",0,1)).rejects.toMatchObject({status:502,code:"invalid_paginated_response"});
  });
});
