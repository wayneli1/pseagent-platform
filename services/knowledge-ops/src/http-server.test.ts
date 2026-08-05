import type { AddressInfo } from "node:net";
import { afterEach,describe,expect,it } from "vitest";
import { createKnowledgeOpsHttpServer } from "./http-server.js";

const servers:ReturnType<typeof createKnowledgeOpsHttpServer>[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});

describe("knowledge ops health endpoints",()=>{
  it("exposes content-free liveness and database-backed readiness without authentication",async()=>{
    const api={handle:async()=>({status:401,body:{error:"authentication_required"}})};
    const server=createKnowledgeOpsHttpServer(api,{readiness:async()=>true});servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const port=(server.address() as AddressInfo).port;
    await expect(fetch(`http://127.0.0.1:${port}/healthz`).then(response=>response.json()))
      .resolves.toEqual({status:"alive"});
    const ready=await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);await expect(ready.json()).resolves.toEqual({status:"ready"});
  });
  it("fails readiness closed when its dependency probe fails",async()=>{
    const api={handle:async()=>({status:401,body:{error:"authentication_required"}})};
    const server=createKnowledgeOpsHttpServer(api,{readiness:async()=>{throw new Error("database secret");}});servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/readyz`);
    expect(response.status).toBe(503);await expect(response.json()).resolves.toEqual({status:"not_ready"});
  });
});
