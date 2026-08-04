import { describe,expect,it,vi } from "vitest";
import type { Pool } from "pg";
import { PostgresKnowledgeOpsStore } from "./postgres-store.js";

it("claims PostgreSQL jobs with row locking and SKIP LOCKED",async()=>{const queries:string[]=[];const client={query:vi.fn(async(sql:string)=>{queries.push(sql);return{rows:sql.includes("RETURNING j.*")?[{job_id:"00000000-0000-4000-8000-000000000001",type:"compile_catalog",payload:{},status:"running",attempts:1,available_at:new Date(),locked_by:"w",locked_at:new Date(),created_at:new Date(),updated_at:new Date()}]:[]};}),release:vi.fn()};const pool={connect:vi.fn(async()=>client)} as unknown as Pool;const job=await new PostgresKnowledgeOpsStore(pool).claimJob("w");expect(job?.status).toBe("running");expect(queries.join("\n")).toContain("FOR UPDATE SKIP LOCKED");expect(client.release).toHaveBeenCalledOnce();});
