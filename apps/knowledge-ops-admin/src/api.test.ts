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
});
